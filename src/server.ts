import express, { type Response } from "express";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { config } from "./config.js";
import { VoiceService, type SpokenLine } from "./voice.js";
import { phrases } from "./phrases.js";
import { MAX_TEXT_CHARS } from "./minimax.js";

const voice = new VoiceService({ ...config.minimax });
const app = express();
app.use(express.json({ limit: "64kb" }));
app.use(express.static(path.resolve("public")));

// ---- live event stream (SSE) to dashboards / earpiece devices ----
const clients = new Set<Response>();
const voiceLog: SpokenLine[] = [];

function broadcast(event: string, data: unknown) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.write(msg);
}

app.get("/api/events", (req, res) => {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.flushHeaders();
  res.write(`event: snapshot\ndata: ${JSON.stringify({ voiceLog })}\n\n`);
  clients.add(res);
  const ping = setInterval(() => res.write(": ping\n\n"), 20000);
  req.on("close", () => {
    clearInterval(ping);
    clients.delete(res);
  });
});

/** Speak a line through Relay's voice: synthesize (or cache-hit), log it, push it to every connected device. */
export async function say(text: string, kind = "custom"): Promise<SpokenLine> {
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
  return line;
}

function sendError(res: Response, err: unknown) {
  const e = err as Error & { statusCode?: number };
  console.error("[voice]", e.message);
  broadcast("voice_error", { message: e.message, at: new Date().toISOString() });
  res.status(502).json({ error: e.message });
}

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

app.post("/api/speak", async (req, res) => {
  const text = typeof req.body?.text === "string" ? req.body.text : "";
  if (!text.trim()) return res.status(400).json({ error: "text is required" });
  if (text.length > MAX_TEXT_CHARS) return res.status(400).json({ error: `text must be under ${MAX_TEXT_CHARS} chars` });
  try {
    res.json(await say(text, "custom"));
  } catch (err) {
    sendError(res, err);
  }
});

// Demo buttons: speak each kind of confirmation with sample data.
const samples: Record<string, () => string> = {
  taskAssigned: () => phrases.taskAssigned("repeat blood pressure", "Alex"),
  taskAccepted: () => phrases.taskAccepted("repeat blood pressure", "Alex"),
  taskCompleted: () => phrases.taskCompleted("repeat blood pressure", "Alex", "BP 110 over 70"),
  timerStarted: () => phrases.timerStarted(120, "Alex"),
  timerExpired: () => phrases.timerExpired("Alex", "two-minute"),
  correction: () => phrases.correction("blood pressure", "110 over 70", "100 over 70"),
  clarify: () => phrases.clarify("who that task is for"),
  handoff: () =>
    phrases.handoff(
      ["blood pressure 100 over 70, corrected from 110", "aspirin 324 milligrams given"],
      ["Jordan: twelve-lead ECG not yet reported"]
    ),
};

app.post("/api/voice/sample/:kind", async (req, res) => {
  const make = samples[req.params.kind];
  if (!make) return res.status(404).json({ error: "unknown sample" });
  try {
    res.json(await say(make(), req.params.kind));
  } catch (err) {
    sendError(res, err);
  }
});

app.listen(config.port, () => {
  console.log(`Relay running at http://localhost:${config.port}`);
  console.log(`MiniMax model=${config.minimax.model} voice=${config.minimax.voiceId} key=${config.minimax.apiKey ? "set" : "MISSING"}`);
});
