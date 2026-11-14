import express, { type Response } from "express";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { config } from "./config.js";
import { VoiceService, type SpokenLine } from "./voice.js";
import { TranscriptionSession, type Transcript } from "./stt.js";
import { attachListenServer } from "./listen.js";
import { interpret } from "./interpret.js";
import { Relay, cleanCrew } from "./relay.js";

// The crew roster typed on the dashboard, kept across restarts (git-ignored with the rest of .cache/).
const crewFile = path.resolve(".cache", "crew.json");
function loadCrew(): string[] {
  try {
    return cleanCrew(JSON.parse(readFileSync(crewFile, "utf8")));
  } catch {
    return [];
  }
}

const voice = new VoiceService({ ...config.minimax });
const app = express();
app.use(express.json({ limit: "16kb" }));
app.use(express.static(path.resolve("public")));

// ---- Vexo Open kit: the band library (browser ES modules) ----
const kitLib = path.join(config.vexo.kitDir, "js", "src");
const kitAvailable = existsSync(path.join(kitLib, "index.js"));
app.use("/vexo", express.static(kitLib));

app.get("/api/config", (_req, res) =>
  res.json({
    band: config.vexo.band,
    kitAvailable,
    deepgramKey: Boolean(config.deepgram.apiKey),
    openaiKey: Boolean(config.openai.apiKey),
    minimaxKey: Boolean(config.minimax.apiKey),
  })
);

// ---- live event stream (SSE) to dashboards / earpiece devices ----
const clients = new Set<Response>();
const voiceLog: SpokenLine[] = [];
let listening: { on: boolean; source: string | null } = { on: false, source: null };

function broadcast(event: string, data: unknown) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.write(msg);
}

/** Speak a line through Relay's voice: synthesize (or cache-hit), log it, push it to every connected earpiece. */
async function say(text: string, kind: string): Promise<void> {
  const r = await voice.speak(text);
  const line: SpokenLine = {
    id: randomUUID(),
    text: text.trim(),
    kind,
    at: new Date().toISOString(),
    cached: r.cached,
    latencyMs: r.latencyMs,
    durationMs: r.durationMs,
    audioUrl: `/api/audio/${r.id}.mp3`,
  };
  voiceLog.push(line);
  if (voiceLog.length > 200) voiceLog.shift();
  broadcast("spoken", line);
  broadcast("usage", await voice.usage());
}

// OpenAI spend, visible in the server log (this run only).
const openaiUsage = { requests: 0, inputTokens: 0, outputTokens: 0 };
const onUsage = (u: { inputTokens: number; outputTokens: number }) => {
  openaiUsage.requests++;
  openaiUsage.inputTokens += u.inputTokens;
  openaiUsage.outputTokens += u.outputTokens;
  console.log(`[openai] +${u.inputTokens} in / +${u.outputTokens} out tokens · this run: ${openaiUsage.requests} requests, ${openaiUsage.inputTokens} in / ${openaiUsage.outputTokens} out`);
};

const relay = new Relay({
  interpret: (ctx) => interpret(ctx, { ...config.openai, onUsage }),
  speak: say,
  broadcast,
}, loadCrew());

app.get("/api/events", (req, res) => {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.flushHeaders();
  res.write(`event: snapshot\ndata: ${JSON.stringify({ voiceLog, listening, ...relay.snapshot() })}\n\n`);
  clients.add(res);
  const ping = setInterval(() => res.write(": ping\n\n"), 20000);
  req.on("close", () => {
    clearInterval(ping);
    clients.delete(res);
  });
});

app.get("/api/audio/:id.mp3", (req, res) => {
  let file: string;
  try {
    file = voice.audioPath(req.params.id);
  } catch {
    return res.status(400).end();
  }
  res.type("audio/mpeg").sendFile(file, (err) => err && !res.headersSent && res.status(404).end());
});

app.get("/api/voice/usage", async (_req, res) => res.json(await voice.usage()));

// The crew roster, typed on the dashboard. Only these names can be given tasks; Deepgram is primed with them
// (from the next listening session on — a session's settings are fixed when it opens).
app.post("/api/crew", async (req, res) => {
  try {
    relay.setCrew(req.body?.crew);
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
  await mkdir(path.dirname(crewFile), { recursive: true });
  await writeFile(crewFile, JSON.stringify(relay.crew));
  res.json({ crew: relay.crew, voices: relay.voices });
});

// Which crew member each detected voice is. Deepgram numbers voices in the order it first hears them
// in each listening session, so this may need setting again after listening restarts.
app.post("/api/voices", (req, res) => {
  const { index, name } = req.body ?? {};
  try {
    relay.setVoice(Number(index), typeof name === "string" && name ? name : null);
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
  res.json({ voices: relay.voices });
});

// Spoken handoff for the hospital, from the current task state (also available by voice: "give me the handoff").
app.post("/api/handoff", async (_req, res) => {
  const text = relay.handoffText();
  try {
    await say(text, "handoff");
    res.json({ text });
  } catch (err) {
    const message = (err as Error).message;
    broadcast("voice_error", { message, at: new Date().toISOString() });
    res.status(502).json({ error: message, text });
  }
});

const server = app.listen(config.port, () => {
  const k = (v: string) => (v ? "set" : "MISSING");
  console.log(`Relay running at http://localhost:${config.port}`);
  console.log(`MiniMax key=${k(config.minimax.apiKey)} · Deepgram key=${k(config.deepgram.apiKey)} · OpenAI key=${k(config.openai.apiKey)} model=${config.openai.model}`);
  console.log(`Band Vexo-HACK-${String(config.vexo.band).padStart(2, "0")} · crew: ${relay.crew.join(", ") || "(none yet: add names on the dashboard)"}`);
  if (!kitAvailable) console.warn("vexo-open-kit/ not found — run `npm run kit` to fetch the band library.");
});

// ---- band mic or computer mic -> Deepgram -> transcripts -> Relay (tasks + spoken confirmations) ----
attachListenServer(server, (handlers, source) => new TranscriptionSession(config.deepgram, handlers, undefined, source, relay.crew), {
  onListening(on, source) {
    listening = { on, source: on ? source : null };
    console.log(on ? `[stt] listening (${source}): audio is being sent to Deepgram` : "[stt] stopped listening");
    if (!on) relay.endSession();
    broadcast("listening", { ...listening, at: new Date().toISOString() });
  },
  onTranscript(t: Transcript) {
    broadcast("transcript", { ...t, id: randomUUID(), at: new Date().toISOString(), speakerName: relay.speakerName(t.speaker) });
    relay.onTranscript(t);
  },
  onUtteranceEnd() {
    relay.onUtteranceEnd();
  },
  onError(message) {
    console.error("[stt]", message);
    broadcast("stt_error", { message, at: new Date().toISOString() });
  },
});
