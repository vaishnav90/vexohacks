import { describe, it, expect, vi, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { attachListenServer, CLOSE_BUSY, LISTEN_PATH, type ListenSession } from "../src/listen.js";
import type { SessionHandlers } from "../src/stt.js";

let server: http.Server | null = null;
afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = null;
});

/** Starts a real HTTP server with the bridge; sessions are fakes that record what they get. */
async function setup(startImpl?: (h: SessionHandlers) => Promise<void>) {
  const sessions: Array<{ h: SessionHandlers; source: string; packets: Buffer[]; stop: ReturnType<typeof vi.fn> }> = [];
  const events = { onListening: vi.fn(), onTranscript: vi.fn(), onError: vi.fn() };
  server = http.createServer();
  attachListenServer(
    server,
    (h, source): ListenSession => {
      const rec = { h, source, packets: [] as Buffer[], stop: vi.fn(async () => h.onClosed()) };
      sessions.push(rec);
      return { start: () => (startImpl ? startImpl(h) : Promise.resolve()), send: (p) => (rec.packets.push(Buffer.from(p)), true), stop: rec.stop };
    },
    events
  );
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
  const port = (server!.address() as AddressInfo).port;
  return { sessions, events, url: `ws://127.0.0.1:${port}${LISTEN_PATH}`, port };
}

function open(url: string, headers?: Record<string, string>) {
  const ws = new WebSocket(url, { headers });
  const messages: any[] = [];
  ws.on("message", (d, bin) => { if (!bin) messages.push(JSON.parse(d.toString())); });
  const closed = new Promise<{ code: number }>((r) => ws.on("close", (code) => r({ code })));
  const opened = new Promise<void>((res, rej) => { ws.on("open", () => res()); ws.on("error", rej); });
  return { ws, messages, closed, opened };
}

const until = async (fn: () => boolean) => { for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 10)); };

describe("listen bridge", () => {
  it("forwards binary packets to the session, reports open, and stops on {type:stop}", async () => {
    const { sessions, events, url } = await setup();
    const c = open(url);
    await c.opened;
    await until(() => c.messages.length > 0);
    expect(c.messages[0]).toEqual({ type: "status", state: "open" });
    c.ws.send(Buffer.from([1, 2, 3]));
    c.ws.send(Buffer.from([4]));
    await until(() => sessions[0]?.packets.length === 2);
    expect(sessions[0].packets.map((p) => [...p])).toEqual([[1, 2, 3], [4]]);
    c.ws.send(JSON.stringify({ type: "stop" }));
    expect((await c.closed).code).toBe(1000);
    expect(sessions[0].stop).toHaveBeenCalledTimes(1);
    expect(events.onListening.mock.calls).toEqual([[true, "band"], [false, "band"]]);
  });

  it("closing the page's socket also stops the Deepgram session", async () => {
    const { sessions, events, url } = await setup();
    const c = open(url);
    await c.opened;
    c.ws.close();
    await until(() => events.onListening.mock.calls.length === 2);
    expect(sessions[0].stop).toHaveBeenCalledTimes(1);
  });

  it("allows one listening session at a time", async () => {
    const { url } = await setup();
    const a = open(url);
    await a.opened;
    const b = open(url);
    expect((await b.closed).code).toBe(CLOSE_BUSY);
    a.ws.close();
  });

  it("rejects connections from another website's origin", async () => {
    const { url, port } = await setup();
    const evil = open(url, { Origin: "https://evil.example" });
    await expect(evil.opened).rejects.toThrow(/403/);
    const same = open(url, { Origin: `http://127.0.0.1:${port}` });
    await same.opened;
    same.ws.close();
  });

  it("a failed start reports the error to the page and closes", async () => {
    const { url, events } = await setup(async (h) => {
      h.onError("Deepgram does not accept the key (status 401)");
      h.onClosed();
      throw new Error("401");
    });
    const c = open(url);
    await c.opened;
    await c.closed;
    expect(c.messages).toContainEqual({ type: "error", message: "Deepgram does not accept the key (status 401)" });
    expect(events.onError).toHaveBeenCalledTimes(1);
    expect(events.onListening.mock.calls).toEqual([[true, "band"], [false, "band"]]);
  });

  it("passes the audio source to the session and refuses unknown sources", async () => {
    const { sessions, url } = await setup();
    const c = open(url + "?source=mic");
    await c.opened;
    await until(() => sessions.length === 1);
    expect(sessions[0].source).toBe("mic");
    c.ws.close();
    await c.closed;
    const bad = open(url + "?source=radio");
    await expect(bad.opened).rejects.toThrow(/400/);
  });

  it("refuses upgrades on other paths with 404", async () => {
    const { port } = await setup();
    const other = open(`ws://127.0.0.1:${port}/elsewhere`);
    await expect(other.opened).rejects.toThrow(/404/);
  });
});
