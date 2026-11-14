// WebSocket bridge: dashboard page (connected to the band over Web Bluetooth) -> this server -> Deepgram.
// The Deepgram key stays on the server; the browser only ever sends Opus packets.
//
// Protocol on ws://<host>/api/listen?source=band|mic — one WebSocket = one listening session:
//   browser -> server  binary            band: one Opus packet (16 kHz mono, 20 ms)
//                                        mic:  16-bit little-endian PCM, 16 kHz mono
//   browser -> server  {"type":"stop"}   flush the last words, then the server closes the socket
//   server -> browser  {"type":"status","state":"open"|"closed"}   or  {"type":"error","message":...}
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket, type RawData } from "ws";
import type { AudioSource, SessionHandlers, Transcript } from "./stt.js";

export const LISTEN_PATH = "/api/listen";
export const CLOSE_BUSY = 4409; // another listening session is active (one band, one session)

export interface ListenSession {
  start(): Promise<void>;
  send(packet: Uint8Array): boolean;
  stop(): Promise<void>;
}

export interface ListenEvents {
  onListening(on: boolean, source: AudioSource): void;
  onTranscript(t: Transcript): void;
  onUtteranceEnd?(): void;
  onError(message: string): void;
}

/** Same-origin check: blocks other websites in the browser from driving the mic bridge (and the key's bill). */
export function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser clients (local scripts) send no Origin
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

export function attachListenServer(
  server: Server,
  createSession: (h: SessionHandlers, source: AudioSource) => ListenSession,
  events: ListenEvents
) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16384 });
  let active: WebSocket | null = null;

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    // This is the server's only WebSocket endpoint: refuse anything else instead of leaving the socket hanging.
    if (url.pathname !== LISTEN_PATH) return refuse(socket, "404 Not Found");
    if (!originAllowed(req)) return refuse(socket, "403 Forbidden");
    const src = url.searchParams.get("source") ?? "band";
    if (src !== "band" && src !== "mic") return refuse(socket, "400 Bad Request");
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, src));
  });

  function refuse(socket: Duplex, status: string) {
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  }

  function sendJson(ws: WebSocket, msg: unknown) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  function onConnection(ws: WebSocket, source: AudioSource) {
    if (active) {
      ws.close(CLOSE_BUSY, "already listening");
      return;
    }
    active = ws;
    let stopping = false;
    let ended = false;

    const end = () => {
      if (ended) return;
      ended = true;
      if (active === ws) active = null;
      events.onListening(false, source);
      sendJson(ws, { type: "status", state: "closed" });
      if (ws.readyState === ws.OPEN) ws.close(1000, "done");
    };

    const session = createSession({
      onTranscript: (t) => events.onTranscript(t),
      onUtteranceEnd: () => events.onUtteranceEnd?.(),
      onError: (message) => {
        events.onError(message);
        sendJson(ws, { type: "error", message });
      },
      onClosed: end,
    }, source);

    const stop = () => {
      if (stopping) return;
      stopping = true;
      session.stop().catch(() => {}).finally(end);
    };

    ws.on("message", (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
        session.send(buf);
        return;
      }
      let msg: any;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg?.type === "stop") stop();
    });
    ws.on("close", stop); // tab closed / band page reloaded: end the Deepgram session too
    ws.on("error", stop);

    events.onListening(true, source);
    session
      .start()
      .then(() => sendJson(ws, { type: "status", state: "open" }))
      .catch(() => {
        /* onError already reported it; onClosed ends the socket */
        end();
      });
  }

  return wss;
}
