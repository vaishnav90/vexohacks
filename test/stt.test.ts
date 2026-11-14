import { describe, it, expect, vi } from "vitest";
import { TranscriptionSession, liveParams, describeStatus, majoritySpeaker, type LiveSocket, type SttConfig } from "../src/stt.js";

const cfg: SttConfig = { apiKey: "k", model: "nova-3", language: "en", endpointingMs: 100 };

function fakeSocket(opts: { failOpen?: { statusCode?: number } } = {}) {
  const handlers: Record<string, (x?: any) => void> = {};
  const s = {
    handlers,
    media: [] as Uint8Array[],
    control: [] as string[],
    closed: false,
    on: (ev: string, cb: any) => { handlers[ev] = cb; },
    connect: vi.fn(),
    waitForOpen: vi.fn(() => (opts.failOpen ? Promise.reject(Object.assign(new Error("x"), opts.failOpen)) : Promise.resolve())),
    sendMedia: (d: Uint8Array) => { s.media.push(d); },
    sendKeepAlive: () => { s.control.push("KeepAlive"); },
    sendCloseStream: () => { s.control.push("CloseStream"); },
    close: () => { s.closed = true; },
  };
  return s;
}

const results = (text: string, is_final: boolean, speech_final = false, speaker?: number) => ({
  type: "Results", is_final, speech_final, start: 1.5, duration: 0.8,
  channel: { alternatives: [{ transcript: text, words: speaker === undefined ? [] : text.split(" ").map((w) => ({ word: w, speaker })) }] },
});

function handlers() {
  return { onTranscript: vi.fn(), onError: vi.fn(), onClosed: vi.fn(), onUtteranceEnd: vi.fn() };
}

describe("liveParams", () => {
  const common = {
    model: "nova-3", language: "en", sample_rate: 16000, channels: 1, interim_results: "true", smart_format: "true",
    endpointing: 100, diarize: "true", utterance_end_ms: 1000, mip_opt_out: "true",
  };
  it("band: the Vexo kit's settings for raw Opus packets, plus diarization and utterance end", () => {
    expect(liveParams(cfg, "band")).toEqual({ ...common, encoding: "opus" });
  });
  it("computer mic: 16 kHz 16-bit PCM", () => {
    expect(liveParams(cfg, "mic")).toEqual({ ...common, encoding: "linear16" });
  });
  it("crew names become repeated keyterm query params (not the SDK's JSON-encoded typed option)", () => {
    const p = liveParams(cfg, "band", ["Mark", " Sarah ", ""]);
    expect(p.queryParams).toEqual({ keyterm: ["Mark", "Sarah"] });
    expect(p).not.toHaveProperty("keyterm");
  });
});

describe("majoritySpeaker", () => {
  it("picks the speaker most words belong to, or null without labels", () => {
    expect(majoritySpeaker([{ speaker: 1 }, { speaker: 0 }, { speaker: 1 }])).toBe(1);
    expect(majoritySpeaker([{}, {}])).toBeNull();
    expect(majoritySpeaker(undefined)).toBeNull();
  });
});

describe("TranscriptionSession", () => {
  it("buffers packets while connecting, flushes them in order, then streams", async () => {
    const sock = fakeSocket();
    let release!: () => void;
    sock.waitForOpen = vi.fn(() => new Promise<void>((r) => (release = r)));
    const s = new TranscriptionSession(cfg, handlers(), async () => sock as unknown as LiveSocket);
    const started = s.start();
    s.send(new Uint8Array([1]));
    await Promise.resolve(); await Promise.resolve();
    s.send(new Uint8Array([2]));
    expect(sock.media).toHaveLength(0);
    release();
    await started;
    expect(s.state).toBe("open");
    s.send(new Uint8Array([3]));
    expect(sock.media.map((m) => m[0])).toEqual([1, 2, 3]);
    expect(s.packetsSent).toBe(3);
  });

  it("rejects empty and oversized packets", async () => {
    const sock = fakeSocket();
    const s = new TranscriptionSession(cfg, handlers(), async () => sock as unknown as LiveSocket);
    await s.start();
    expect(s.send(new Uint8Array(0))).toBe(false);
    expect(s.send(new Uint8Array(1276))).toBe(false);
    expect(s.send(new Uint8Array(1275))).toBe(true);
  });

  it("reports interim and final results, skipping empty (silence) results", async () => {
    const sock = fakeSocket();
    const h = handlers();
    const s = new TranscriptionSession(cfg, h, async () => sock as unknown as LiveSocket);
    await s.start();
    sock.handlers.message(results("", true));
    sock.handlers.message(results("Person 2 repeat", false));
    sock.handlers.message(results("Person 2, repeat the blood pressure.", true, true, 1));
    sock.handlers.message({ type: "Metadata" });
    sock.handlers.message({ type: "UtteranceEnd", last_word_end: 3.1 });
    expect(h.onTranscript.mock.calls.map((c) => c[0])).toEqual([
      { text: "Person 2 repeat", isFinal: false, speechFinal: false, start: 1.5, duration: 0.8, speaker: null },
      { text: "Person 2, repeat the blood pressure.", isFinal: true, speechFinal: true, start: 1.5, duration: 0.8, speaker: 1 },
    ]);
    expect(h.onUtteranceEnd).toHaveBeenCalledTimes(1);
  });

  it("mic source accepts PCM chunks (whole 16-bit samples, up to 8 KB) and rejects odd sizes", async () => {
    const sock = fakeSocket();
    const s = new TranscriptionSession(cfg, handlers(), async () => sock as unknown as LiveSocket, "mic");
    await s.start();
    expect(s.send(new Uint8Array(640))).toBe(true); // 20 ms at 16 kHz
    expect(s.send(new Uint8Array(641))).toBe(false);
    expect(s.send(new Uint8Array(8194))).toBe(false);
  });

  it("stop() sends CloseStream, waits for Deepgram to close, then releases", async () => {
    const sock = fakeSocket();
    const h = handlers();
    const s = new TranscriptionSession(cfg, h, async () => sock as unknown as LiveSocket);
    await s.start();
    const stopped = s.stop();
    expect(sock.control).toEqual(["CloseStream"]);
    sock.handlers.message(results("last words", true)); // arrives after CloseStream
    sock.handlers.close({ code: 1000 });
    await stopped;
    expect(h.onTranscript).toHaveBeenCalledTimes(1);
    expect(s.state).toBe("closed");
    expect(sock.closed).toBe(true);
    expect(h.onClosed).toHaveBeenCalledTimes(1);
    expect(h.onError).not.toHaveBeenCalled();
    expect(s.send(new Uint8Array([1]))).toBe(false);
  });

  it("stop() gives up waiting after a bound and still closes", async () => {
    vi.useFakeTimers();
    try {
      const sock = fakeSocket();
      const h = handlers();
      const s = new TranscriptionSession(cfg, h, async () => sock as unknown as LiveSocket);
      await s.start();
      const stopped = s.stop();
      await vi.advanceTimersByTimeAsync(3000);
      await stopped;
      expect(sock.closed).toBe(true);
      expect(h.onClosed).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends KeepAlive only when no audio has flowed for 3 s", async () => {
    vi.useFakeTimers();
    try {
      const sock = fakeSocket();
      const s = new TranscriptionSession(cfg, handlers(), async () => sock as unknown as LiveSocket);
      await s.start();
      s.send(new Uint8Array([1]));
      await vi.advanceTimersByTimeAsync(2999);
      expect(sock.control).toEqual([]);
      await vi.advanceTimersByTimeAsync(3001);
      expect(sock.control).toContain("KeepAlive");
      const stopped = s.stop();
      sock.handlers.close({ code: 1000 });
      await stopped;
    } finally {
      vi.useRealTimers();
    }
  });

  it("a refused connection reports the status number (never the key) and closes", async () => {
    const sock = fakeSocket({ failOpen: { statusCode: 401 } });
    const h = handlers();
    const s = new TranscriptionSession({ ...cfg, apiKey: "secret-key-value" }, h, async () => sock as unknown as LiveSocket);
    await expect(s.start()).rejects.toThrow(/401/);
    expect(h.onError).toHaveBeenCalledTimes(1);
    expect(h.onError.mock.calls[0][0]).toMatch(/status 401/);
    expect(h.onError.mock.calls[0][0]).not.toContain("secret-key-value");
    expect(h.onClosed).toHaveBeenCalledTimes(1);
    expect(s.state).toBe("closed");
  });

  it("refused connection in the real SDK's event order (close, then error 401, then reject) reports 401", async () => {
    // Observed with @deepgram/sdk 5.20.0 and an invalid key.
    const sock = fakeSocket();
    sock.waitForOpen = vi.fn(() => {
      sock.handlers.close({ code: 1000 });
      sock.handlers.error(Object.assign(new Error("Unexpected server response: 401 (...)"), { statusCode: 401 }));
      return Promise.reject(Object.assign(new Error("Unexpected server response: 401 (...)"), { statusCode: 401 }));
    });
    const h = handlers();
    const s = new TranscriptionSession(cfg, h, async () => sock as unknown as LiveSocket);
    await expect(s.start()).rejects.toThrow(/status 401/);
    expect(h.onError).toHaveBeenCalledTimes(1);
    expect(h.onError.mock.calls[0][0]).toMatch(/does not accept the key \(status 401\)/);
    expect(h.onError.mock.calls[0][0]).not.toMatch(/Unexpected server response/); // raw body never shown
    expect(h.onClosed).toHaveBeenCalledTimes(1);
    expect(s.state).toBe("closed");
  });

  it("without a key it never connects", async () => {
    const connect = vi.fn();
    const h = handlers();
    const s = new TranscriptionSession({ ...cfg, apiKey: "" }, h, connect as any);
    await expect(s.start()).rejects.toThrow(/DEEPGRAM_API_KEY/);
    expect(connect).not.toHaveBeenCalled();
    expect(h.onError).toHaveBeenCalledTimes(1);
    expect(h.onClosed).toHaveBeenCalledTimes(1);
  });

  it("an unexpected close from Deepgram is reported once", async () => {
    const sock = fakeSocket();
    const h = handlers();
    const s = new TranscriptionSession(cfg, h, async () => sock as unknown as LiveSocket);
    await s.start();
    sock.handlers.close({ code: 1011 });
    expect(h.onError).toHaveBeenCalledWith("Deepgram closed the connection");
    expect(h.onClosed).toHaveBeenCalledTimes(1);
    expect(s.state).toBe("closed");
  });

  it("stop() during connect never opens the socket and does not report an error", async () => {
    const sock = fakeSocket();
    let give!: (x: LiveSocket) => void;
    const h = handlers();
    const s = new TranscriptionSession(cfg, h, () => new Promise<LiveSocket>((r) => (give = r)));
    const started = s.start();
    await s.stop();
    give(sock as unknown as LiveSocket);
    await started;
    expect(sock.connect).not.toHaveBeenCalled();
    expect(sock.closed).toBe(true);
    expect(h.onError).not.toHaveBeenCalled();
    expect(h.onClosed).toHaveBeenCalledTimes(1);
  });
});

describe("describeStatus", () => {
  it("maps the statuses in the kit's troubleshooting table", () => {
    expect(describeStatus(402)).toMatch(/credit/);
    expect(describeStatus(429)).toMatch(/Too many/);
    expect(describeStatus(undefined)).toBe("Could not reach Deepgram");
  });
});
