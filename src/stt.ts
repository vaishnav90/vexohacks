// Deepgram live speech-to-text for the Vexo band's microphone.
// The band sends raw Opus packets (16 kHz, mono, 20 ms each); Deepgram takes them as-is with
// encoding=opus, one packet per binary message (vexo-open-kit/docs/deepgram.md).
import { DeepgramClient } from "@deepgram/sdk";

export interface SttConfig {
  apiKey: string;
  model: string; // e.g. "nova-3"
  language: string; // e.g. "en"
  endpointingMs: number; // silence (ms) that ends a sentence; the kit measured 100 as best for the band mic
}

/**
 * Where the audio comes from:
 *  - "band": the Vexo band's raw Opus packets (16 kHz mono, 20 ms each), sent as-is
 *  - "mic":  the computer's microphone, as 16-bit little-endian PCM at 16 kHz mono (made in the browser)
 */
export type AudioSource = "band" | "mic";

export interface Transcript {
  text: string;
  isFinal: boolean; // this piece will not change any more
  speechFinal: boolean; // the speaker paused (end of an utterance)
  start: number; // seconds since the stream began
  duration: number;
  speaker: number | null; // Deepgram diarization: 0 = first voice heard this session, 1 = second, ...
}

/** The speaker most of the words belong to (Deepgram labels each word). */
export function majoritySpeaker(words: Array<{ speaker?: number }> | undefined): number | null {
  const counts = new Map<number, number>();
  for (const w of words ?? []) if (typeof w.speaker === "number") counts.set(w.speaker, (counts.get(w.speaker) ?? 0) + 1);
  let best: number | null = null;
  let bestN = 0;
  for (const [s, n] of counts) if (n > bestN) { best = s; bestN = n; }
  return best;
}

/** The parts of the SDK's V1Socket this module uses (lets tests pass a fake). */
export interface LiveSocket {
  on(event: "open", cb: () => void): void;
  on(event: "message", cb: (msg: any) => void): void;
  on(event: "close", cb: (ev: { code?: number; reason?: string }) => void): void;
  on(event: "error", cb: (err: Error & { statusCode?: number }) => void): void;
  connect(): unknown;
  waitForOpen(): Promise<unknown>;
  sendMedia(data: ArrayBufferView): void;
  sendKeepAlive(msg: { type: "KeepAlive" }): void;
  sendCloseStream(msg: { type: "CloseStream" }): void;
  close(): void;
}

export type ConnectFn = (cfg: SttConfig, params: Record<string, unknown>) => Promise<LiveSocket>;

/** Query parameters for one listening session. mip_opt_out=true is required by the Vexo kit: keep it. */
export function liveParams(cfg: SttConfig, source: AudioSource = "band", keyterms: string[] = []): Record<string, unknown> {
  const terms = keyterms.map((k) => k.trim()).filter(Boolean).slice(0, 50);
  return {
    // Crew names, so Deepgram hears "Mark" as Mark. Sent through queryParams because the SDK's typed `keyterm`
    // JSON-encodes a list; queryParams are serialised as repeated keyterm=... (SDK core/websocket arrayFormat "repeat").
    ...(terms.length ? { queryParams: { keyterm: terms } } : {}),
    model: cfg.model,
    language: cfg.language,
    encoding: source === "band" ? "opus" : "linear16",
    sample_rate: 16000,
    channels: 1,
    interim_results: "true",
    smart_format: "true",
    endpointing: cfg.endpointingMs,
    diarize: "true", // label which voice said each word, so Person 1 and Person 2 can share one mic
    // UtteranceEnd after 1 s with no words: a whole command, even if the speaker took a breath mid-sentence
    // (endpointing stays short so the on-screen transcript is still fast). Needs interim_results.
    utterance_end_ms: 1000,
    mip_opt_out: "true",
  };
}

const sdkConnect: ConnectFn = async (cfg, params) => {
  // reconnect:false / reconnectAttempts:0 — a dropped session ends visibly instead of silently
  // re-opening (and re-billing) with a gap in the audio. The user re-toggles to start again.
  const client = new DeepgramClient({ apiKey: cfg.apiKey, reconnect: false });
  const socket = await client.listen.v1.connect({
    ...(params as any),
    reconnectAttempts: 0,
    connectionTimeoutInSeconds: 10,
  });
  return socket as unknown as LiveSocket;
};

/** Human message for a refused connection. Shows the status number only — never the key or what was sent. */
export function describeStatus(status: number | undefined): string {
  switch (status) {
    case 400: return "Deepgram rejected a setting (status 400)";
    case 401: return "Deepgram does not accept the key (status 401) — check DEEPGRAM_API_KEY in .env";
    case 402: return "Deepgram key has no credit left (status 402)";
    case 403: return "Deepgram key may not use this model or setting (status 403)";
    case 429: return "Too many Deepgram connections with this key (status 429) — close other tabs/programs using it";
    default: return status ? `Deepgram refused the connection (status ${status})` : "Could not reach Deepgram";
  }
}

export interface SessionHandlers {
  onTranscript(t: Transcript): void;
  onUtteranceEnd?(): void; // the speaker has finished (about 1 s without words)
  onError(message: string): void;
  onClosed(): void;
}

const MAX_PENDING = 250; // 5 s of 20 ms packets buffered while the socket opens
const MAX_PACKET: Record<AudioSource, number> = {
  band: 1275, // largest possible Opus packet (RFC 6716)
  mic: 8192, // PCM chunk: 20 ms is 640 bytes; allow up to ~250 ms
};
const KEEPALIVE_MS = 3000; // Deepgram hangs up after ~10 s without audio
const CLOSE_WAIT_MS = 3000; // how long stop() waits for the last words before closing hard

export type SessionState = "idle" | "connecting" | "open" | "closing" | "closed";

/** One listening session: opened when the medic toggles listening on, closed when toggled off. */
export class TranscriptionSession {
  state: SessionState = "idle";
  packetsSent = 0;
  private socket: LiveSocket | null = null;
  private pending: Uint8Array[] = [];
  private lastAudioAt = 0;
  private keepAlive: ReturnType<typeof setInterval> | null = null;
  private closeWaiters: Array<() => void> = [];
  private errored = false;

  constructor(
    private cfg: SttConfig,
    private handlers: SessionHandlers,
    private connectImpl: ConnectFn = sdkConnect,
    readonly source: AudioSource = "band",
    private keyterms: string[] = []
  ) {}

  async start(): Promise<void> {
    if (this.state !== "idle") throw new Error(`session already ${this.state}`);
    if (!this.cfg.apiKey) {
      const msg = "Transcription needs a Deepgram key: set DEEPGRAM_API_KEY in .env and restart the server";
      this.fail(msg);
      this.finish();
      throw new Error(msg);
    }
    this.state = "connecting";
    let socket: LiveSocket;
    try {
      socket = await this.connectImpl(this.cfg, liveParams(this.cfg, this.source, this.keyterms));
      if (this.state !== "connecting") {
        // stop() ran while the SDK was still being set up: never open this socket.
        try { socket.close(); } catch { /* ignore */ }
        return;
      }
      this.socket = socket;
      socket.on("message", (msg) => this.onMessage(msg));
      socket.on("error", (err) => this.fail(describeStatus(err?.statusCode)));
      socket.on("close", () => this.onSocketClosed());
      socket.connect();
      await socket.waitForOpen();
    } catch (err) {
      if (this.state !== "connecting") return; // stopped while opening: not an error
      const status = (err as { statusCode?: number })?.statusCode;
      this.fail(describeStatus(status));
      this.finish();
      throw new Error(describeStatus(status));
    }
    if (this.state !== "connecting") return; // stopped or failed while opening
    this.state = "open";
    for (const p of this.pending) this.sendNow(p);
    this.pending = [];
    this.keepAlive = setInterval(() => {
      if (this.state === "open" && Date.now() - this.lastAudioAt >= KEEPALIVE_MS) {
        try { this.socket?.sendKeepAlive({ type: "KeepAlive" }); } catch { /* closing */ }
      }
    }, KEEPALIVE_MS);
  }

  /** One audio chunk (band: one Opus packet; mic: PCM16). Returns false if it was not accepted. */
  send(packet: Uint8Array): boolean {
    if (packet.byteLength === 0 || packet.byteLength > MAX_PACKET[this.source]) return false;
    if (this.source === "mic" && packet.byteLength % 2 !== 0) return false; // PCM16 = whole 2-byte samples
    if (this.state === "open") return this.sendNow(packet);
    if (this.state === "connecting" || this.state === "idle") {
      if (this.pending.length >= MAX_PENDING) this.pending.shift();
      this.pending.push(packet);
      return true;
    }
    return false;
  }

  /** Ask Deepgram for the last words, wait for it to close (bounded), then release everything. */
  async stop(): Promise<void> {
    if (this.state === "closed") return;
    const wasOpen = this.state === "open";
    this.state = "closing";
    this.pending = [];
    if (!this.socket || !wasOpen) {
      // Still connecting: start() sees state !== "connecting" and stops; close what exists.
      this.finish();
      return;
    }
    const closed = new Promise<void>((resolve) => this.closeWaiters.push(resolve));
    try { this.socket.sendCloseStream({ type: "CloseStream" }); } catch { /* already closing */ }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([closed, new Promise<void>((r) => (timer = setTimeout(r, CLOSE_WAIT_MS)))]);
    clearTimeout(timer);
    this.finish();
  }

  private sendNow(packet: Uint8Array): boolean {
    try {
      this.socket!.sendMedia(packet);
      this.packetsSent++;
      this.lastAudioAt = Date.now();
      return true;
    } catch {
      return false;
    }
  }

  private onMessage(msg: any) {
    if (msg?.type === "Results") {
      const alt = msg.channel?.alternatives?.[0];
      const text = typeof alt?.transcript === "string" ? alt.transcript.trim() : "";
      if (!text) return; // Deepgram sends empty results for silence
      this.handlers.onTranscript({
        text,
        isFinal: msg.is_final === true,
        speechFinal: msg.speech_final === true,
        start: Number(msg.start) || 0,
        duration: Number(msg.duration) || 0,
        speaker: majoritySpeaker(alt.words),
      });
    } else if (msg?.type === "UtteranceEnd") {
      this.handlers.onUtteranceEnd?.();
    } else if (msg?.type === "Error") {
      this.fail("Deepgram reported an error during the session");
    }
  }

  private onSocketClosed() {
    for (const w of this.closeWaiters.splice(0)) w();
    // While connecting, the SDK fires close (code 1000) BEFORE the error carrying the HTTP status,
    // then rejects waitForOpen(). Let start()'s catch report it, so the real reason (e.g. 401) is shown.
    if (this.state === "open") {
      // Deepgram closed on its own (network drop, timeout) — not a requested stop.
      this.fail("Deepgram closed the connection");
      this.finish();
    }
  }

  private fail(message: string) {
    if (this.errored) return;
    this.errored = true;
    this.handlers.onError(message);
  }

  private finish() {
    if (this.state === "closed") return;
    this.state = "closed";
    if (this.keepAlive) clearInterval(this.keepAlive);
    this.keepAlive = null;
    this.pending = [];
    try { this.socket?.close(); } catch { /* ignore */ }
    this.socket = null;
    for (const w of this.closeWaiters.splice(0)) w();
    this.handlers.onClosed();
  }
}
