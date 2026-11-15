import express, { type Response } from "express";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { config } from "./config.js";
import { VoiceService, type SpokenLine } from "./voice.js";
import { phrases } from "./phrases.js";
import { MAX_TEXT_CHARS } from "./minimax.js";
import { BandService, type BandState, type LedCommand } from "./band.js";
import { TaskBoard } from "./board.js";

const voice = new VoiceService({ ...config.minimax });
const bandService = new BandService(config.bandCrew);
// Dashboard state: task ledger + each band's current LED, so a page that opens mid-call sees everything.
const board = new TaskBoard();
const bandLeds = new Map<string, LedCommand & { at: string }>();
const bands = () =>
  Object.entries(config.bandCrew).map(([crewId, band]) => ({
    crewId: crewId.toLowerCase(),
    name: crewId.charAt(0).toUpperCase() + crewId.slice(1),
    band,
    led: bandLeds.get(crewId.toLowerCase()) ?? null,
  }));
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
  res.write(`event: snapshot\ndata: ${JSON.stringify({ voiceLog, tasks: board.list(), bands: bands() })}\n\n`);
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
  // Play audio through the laptop speakers (macOS afplay, fire-and-forget)
  spawn("afplay", [voice.audioPath(r.id)], { stdio: "ignore" });
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

function setLed(crewId: string, led: LedCommand) {
  bandLeds.set(crewId, { ...led, at: new Date().toISOString() });
  broadcast("bands", { bands: bands() });
}

/** Mirror a band lifecycle event onto the dashboard: task ledger, band LED, and alerts. */
function recordBand(crewId: string, state: BandState, led: LedCommand, p: { task?: string; person?: string; label?: string; what?: string; result?: string }) {
  setLed(crewId, led);
  const at = new Date().toISOString();
  const name = crewId.charAt(0).toUpperCase() + crewId.slice(1);
  if (state === "assigned" && p.task) board.assigned(crewId, p.task.trim());
  else if (state === "taskSent" && p.task && p.person) board.sent(crewId, p.person, p.task.trim());
  else if (state === "completed") board.completed(crewId, typeof p.task === "string" ? p.task.trim() || undefined : undefined, typeof p.result === "string" ? p.result : undefined);
  else if (state === "timerExpired") broadcast("band_alert", { crewId, name, kind: "timer", text: p.label ? `${name}: ${p.label} timer is up` : `${name}: timer is up`, at });
  else if (state === "clarify") broadcast("band_alert", { crewId, name, kind: "clarify", text: `Relay asked to repeat: ${p.what || "that"}`, at });
  broadcast("board", { tasks: board.list() });
}

const BAND_STATES: BandState[] = ["assigned", "timerExpired", "clarify", "taskSent", "completed"];

// Called by teammates' code when a task lifecycle event targets this crew member.
app.post("/api/band/:crewId/notify", async (req, res) => {
  const crewId = req.params.crewId.toLowerCase();
  if (!bandService.hasCrew(crewId)) return res.status(404).json({ error: `No band assigned to '${crewId}'` });

  const { state, task, person, label, what, result: taskResult } = req.body ?? {};
  if (!BAND_STATES.includes(state)) {
    return res.status(400).json({ error: `state must be one of: ${BAND_STATES.join(", ")}` });
  }
  if ((state === "assigned" || state === "taskSent") && (!task || typeof task !== "string" || !task.trim())) {
    return res.status(400).json({ error: "task is required for assigned/taskSent states" });
  }
  if (state === "taskSent" && (!person || typeof person !== "string" || !person.trim())) {
    return res.status(400).json({ error: "person is required for taskSent state" });
  }

  const result = bandService.notify(crewId, state as BandState, { task, person, label, what, result: taskResult });
  if (!result) return res.status(500).json({ error: "notify failed" });

  broadcast("band_notify", { crewId, ...result.ledCommand });
  recordBand(crewId, state as BandState, result.ledCommand, { task, person, label, what, result: taskResult });
  try {
    await say(result.voiceText, `band_${state}`);
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

// Called by band_bridge.py when the wearer double-taps to acknowledge a pending task.
app.post("/api/band/:crewId/tap", async (req, res) => {
  const crewId = req.params.crewId.toLowerCase();
  if (!bandService.hasCrew(crewId)) return res.status(404).json({ error: `No band assigned to '${crewId}'` });

  const result = bandService.handleTap(crewId);
  if (!result) return res.json({ ok: true, acknowledged: false });

  broadcast("band_notify", { crewId, ...result.ledCommand });
  setLed(crewId, result.ledCommand);
  board.accepted(crewId);
  broadcast("board", { tasks: board.list() });
  try {
    await say(result.voiceText, "band_acknowledged");
    res.json({ ok: true, acknowledged: true });
  } catch (err) {
    sendError(res, err);
  }
});

app.listen(config.port, () => {
  console.log(`Relay running at http://localhost:${config.port}`);
  console.log(`MiniMax model=${config.minimax.model} voice=${config.minimax.voiceId} key=${config.minimax.apiKey ? "set" : "MISSING"}`);
  console.log(`Band crew: ${JSON.stringify(config.bandCrew)}`);
});
