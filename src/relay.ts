// Relay's brain: transcript -> utterances -> (OpenAI proposes an action) -> checked against the real state
// -> state changes -> a confirmation spoken by MiniMax. Crew, tasks, findings and timers live here, in code —
// never in a model. Spoken sentences come from phrases.ts, built from what actually changed.
import type { Transcript } from "./stt.js";
import type { Action, InterpretContext } from "./interpret.js";
import { durationWords, phrases } from "./phrases.js";

export type TaskStatus = "pending" | "accepted" | "done";

export interface HistoryEvent {
  at: string;
  kind: "assigned" | "accepted" | "completed" | "corrected" | "logged";
  by: string; // who said it (voice label)
  said: string; // the transcript line it came from — the source of every fact
  from?: string;
  to?: string;
}

export interface Task {
  id: string;
  assignee: string;
  description: string;
  status: TaskStatus;
  result: string | null; // current value; corrections keep the original in history
  createdAt: string;
  updatedAt: string;
  history: HistoryEvent[];
}

/** A finding or event nobody was asked for ("blood pressure normal"). Confirmed, goes into the handoff. */
export interface Finding {
  id: string;
  finding: string; // current value; corrections keep the original in history
  at: string;
  history: HistoryEvent[];
}

export interface Timer {
  id: string;
  person: string;
  seconds: number;
  startedAt: string;
  endsAt: string;
  state: "running" | "expired";
}

export interface Utterance {
  id: string;
  at: string;
  speaker: string; // a crew name (if that voice is assigned), else "Voice 1", "Voice 2", or "unknown"
  text: string;
}

export interface RelayDeps {
  interpret(ctx: InterpretContext): Promise<Action>;
  speak(text: string, kind: string): Promise<void>;
  broadcast(event: string, data: unknown): void;
  now?: () => Date;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}

const RECENT = 6; // earlier utterances given to the model as context
const MAX_TIMER_S = 3600;
const MAX_CREW = 12;
export const VOICES = 2; // voices the dashboard can assign to crew members

/** Cleans a typed roster: trimmed, 1-30 letters/spaces/'-., no duplicates (case-insensitive), at most 12. */
export function cleanCrew(names: unknown): string[] {
  if (!Array.isArray(names)) throw new Error("crew must be a list of names");
  const out: string[] = [];
  for (const raw of names) {
    if (typeof raw !== "string") throw new Error("each crew name must be text");
    const n = raw.replace(/\s+/g, " ").trim();
    if (!n) continue;
    if (n.length > 30 || !/^[\p{L}][\p{L} .'-]*$/u.test(n)) throw new Error(`"${n.slice(0, 30)}" is not a usable name (letters, spaces, ' - . only)`);
    if (n.toLowerCase() === "unknown" || /^voice \d+$/i.test(n)) throw new Error(`"${n}" is reserved`);
    if (!out.some((x) => x.toLowerCase() === n.toLowerCase())) out.push(n);
  }
  if (out.length > MAX_CREW) throw new Error(`at most ${MAX_CREW} crew members`);
  return out;
}

export class Relay {
  crew: string[] = [];
  voices: Array<string | null> = Array(VOICES).fill(null); // voice index -> crew name (set on the dashboard)
  tasks: Task[] = [];
  findings: Finding[] = [];
  timers: Timer[] = [];
  utterances: Utterance[] = [];
  private pieces: Array<{ text: string; speaker: number | null }> = [];
  private queue: Promise<void> = Promise.resolve();
  private results: string[] = []; // ids of tasks/findings in the order their value was last set (for corrections)
  private nextTask = 1;
  private nextFinding = 1;
  private nextTimer = 1;
  private nextUtt = 1;
  private timerHandles = new Map<string, unknown>();

  constructor(private d: RelayDeps, crew: string[] = []) {
    this.crew = cleanCrew(crew);
  }

  private now() { return (this.d.now ?? (() => new Date()))(); }
  private iso() { return this.now().toISOString(); }

  /** Diarization index -> label. Index 0 is the first voice Deepgram heard in this listening session. */
  speakerName(idx: number | null): string {
    if (idx === null || idx < 0) return "unknown";
    return this.voices[idx] ?? `Voice ${idx + 1}`;
  }

  snapshot() {
    return {
      crew: this.crew, voices: this.voices, tasks: this.tasks, findings: this.findings, timers: this.timers,
      utterances: this.utterances.slice(-50),
    };
  }

  private publishCrew() { this.d.broadcast("crew", { crew: this.crew, voices: this.voices }); }
  private publishBoard() { this.d.broadcast("tasks", { tasks: this.tasks, findings: this.findings, timers: this.timers }); }

  /** Replace the roster (typed on the dashboard). Voice assignments to removed names are cleared. */
  setCrew(names: unknown) {
    this.crew = cleanCrew(names);
    this.voices = this.voices.map((v) => (v && this.crew.includes(v) ? v : null));
    this.publishCrew();
  }

  /** Which crew member a detected voice is (null = not assigned). */
  setVoice(index: number, name: string | null) {
    if (!Number.isInteger(index) || index < 0 || index >= VOICES) throw new Error("unknown voice");
    if (name !== null && !this.crew.includes(name)) throw new Error("that name is not on the crew list");
    this.voices = this.voices.map((v, i) => (i === index ? name : v === name && name !== null ? null : v)); // one voice per name
    this.publishCrew();
  }

  /** Every transcript piece from Deepgram. Final pieces are joined until the speaker has finished. */
  onTranscript(t: Transcript) {
    if (!t.isFinal) return;
    const last = this.pieces[this.pieces.length - 1];
    // A different voice starts a new utterance ("Mark, repeat BP." / "On it.") even without a pause.
    if (last && last.speaker !== null && t.speaker !== null && last.speaker !== t.speaker) this.flush();
    this.pieces.push({ text: t.text, speaker: t.speaker });
  }

  /** Deepgram's UtteranceEnd (~1 s without words): the joined pieces are one command. */
  onUtteranceEnd() { this.flush(); }

  /** Listening stopped: whatever was said last still counts. */
  endSession() { this.flush(); }

  /** Resolves when every queued utterance has been handled (tests, shutdown). */
  idle() { return this.queue; }

  private flush() {
    if (!this.pieces.length) return;
    const pieces = this.pieces;
    this.pieces = [];
    const text = pieces.map((p) => p.text).join(" ").replace(/\s+/g, " ").trim();
    if (!text) return;
    const counts = new Map<number, number>();
    for (const p of pieces) if (p.speaker !== null) counts.set(p.speaker, (counts.get(p.speaker) ?? 0) + p.text.length);
    const idx = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const utt: Utterance = { id: `U${this.nextUtt++}`, at: this.iso(), speaker: this.speakerName(idx), text };
    this.utterances.push(utt);
    if (this.utterances.length > 200) this.utterances.shift();
    this.d.broadcast("utterance", utt);
    // One at a time, in order: each action sees the state the previous one left.
    this.queue = this.queue.then(() => this.handle(utt)).catch(() => {});
  }

  private async handle(utt: Utterance) {
    const recent = this.utterances.filter((u) => u.id !== utt.id).slice(-RECENT).map((u) => ({ speaker: u.speaker, text: u.text }));
    let action: Action;
    try {
      action = await this.d.interpret({
        crew: this.crew,
        speaker: utt.speaker,
        newest: utt.text,
        recent,
        openTasks: this.tasks.filter((t) => t.status !== "done" || t.result).map((t) => ({
          id: t.id, assignee: t.assignee, description: t.description, status: t.status, result: t.result ?? undefined,
        })),
        findings: this.findings.map((f) => ({ id: f.id, finding: f.finding })),
      });
    } catch (err) {
      this.d.broadcast("task_error", { message: (err as Error).message, utterance: utt.id, at: this.iso() });
      return;
    }
    const outcome = this.apply(action, utt);
    this.d.broadcast("action", { utterance: utt.id, action, outcome: outcome.note, at: this.iso() });
    if (outcome.changed) this.publishBoard();
    if (outcome.say) {
      try {
        await this.d.speak(outcome.say, outcome.kind);
      } catch (err) {
        this.d.broadcast("voice_error", { message: (err as Error).message, at: this.iso() });
      }
    }
  }

  /** Checks the proposed action against the real state, then changes it. */
  apply(a: Action, utt: Utterance): { changed: boolean; say?: string; kind: string; note: string } {
    const named = this.crew.includes(a.person) ? a.person : null;
    const who = named ?? (this.crew.includes(utt.speaker) ? utt.speaker : null);
    const ask = (what: string) => ({ changed: false, say: phrases.clarify(what), kind: "clarify", note: `asked: ${what}` });
    const at = this.iso();

    switch (a.action) {
      case "none":
        return { changed: false, kind: "none", note: "not a command" };

      case "unclear":
        return ask(a.clarify || "that");

      case "assign_task": {
        if (!this.crew.length) return ask("who that task is for. No crew names are entered yet");
        if (!named) return ask("who that task is for");
        if (!a.task) return ask("the task");
        const task: Task = {
          id: `T${this.nextTask++}`, assignee: named, description: a.task, status: "pending", result: null,
          createdAt: at, updatedAt: at, history: [{ at, kind: "assigned", by: utt.speaker, said: utt.text }],
        };
        this.tasks.push(task);
        return { changed: true, say: phrases.taskAssigned(task.description, task.assignee), kind: "taskAssigned", note: `created ${task.id}` };
      }

      case "accept_task": {
        const t = this.findTask(a.task_id, who, ["pending"]);
        if (!t) return this.tasks.some((x) => x.status === "pending") ? ask("which task was accepted") : { changed: false, kind: "none", note: "no pending task to accept" };
        t.status = "accepted";
        t.updatedAt = at;
        t.history.push({ at, kind: "accepted", by: utt.speaker, said: utt.text });
        return { changed: true, say: phrases.taskAccepted(t.description, t.assignee), kind: "taskAccepted", note: `accepted ${t.id}` };
      }

      case "complete_task": {
        const t = this.findTask(a.task_id, who, ["pending", "accepted"]);
        if (!t) {
          // A finding that answers no open task is still a fact worth keeping: log it instead of asking.
          if (a.result) return this.logFinding(a.result, utt, at);
          return this.tasks.some((x) => x.status !== "done") ? ask("which task that is for") : { changed: false, kind: "none", note: "no open task" };
        }
        t.status = "done";
        t.result = a.result || null;
        t.updatedAt = at;
        t.history.push({ at, kind: "completed", by: utt.speaker, said: utt.text, to: a.result || undefined });
        if (t.result) this.markResult(t.id);
        return {
          changed: true, say: phrases.taskCompleted(t.description, t.assignee, a.result || undefined), kind: "taskCompleted",
          note: `completed ${t.id}`,
        };
      }

      case "log_finding":
        if (!a.result) return { changed: false, kind: "none", note: "empty finding" };
        return this.logFinding(a.result, utt, at);

      case "correct_result": {
        if (!a.result) return ask("the corrected value");
        const id = this.results.includes(a.task_id) ? a.task_id : this.results[this.results.length - 1];
        const task = this.tasks.find((t) => t.id === id && t.result);
        const finding = this.findings.find((f) => f.id === id);
        if (task && task.result) {
          const from = task.result;
          task.result = a.result;
          task.updatedAt = at;
          task.history.push({ at, kind: "corrected", by: utt.speaker, said: utt.text, from, to: a.result }); // original kept
          this.markResult(task.id);
          return { changed: true, say: phrases.correction(task.description, from, a.result), kind: "correction", note: `corrected ${task.id}` };
        }
        if (finding) {
          const from = finding.finding;
          finding.finding = a.result;
          finding.history.push({ at, kind: "corrected", by: utt.speaker, said: utt.text, from, to: a.result }); // original kept
          this.markResult(finding.id);
          return { changed: true, say: phrases.findingCorrected(from, a.result), kind: "correction", note: `corrected ${finding.id}` };
        }
        return ask("which result to correct");
      }

      case "start_timer": {
        if (!named) return ask("who the timer is for");
        if (!Number.isInteger(a.seconds) || a.seconds < 1 || a.seconds > MAX_TIMER_S) return ask("how long the timer is");
        const startedAt = this.now();
        const timer: Timer = {
          id: `C${this.nextTimer++}`, person: named, seconds: a.seconds, startedAt: startedAt.toISOString(),
          endsAt: new Date(startedAt.getTime() + a.seconds * 1000).toISOString(), state: "running",
        };
        this.timers.push(timer);
        const set = this.d.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
        this.timerHandles.set(timer.id, set(() => this.expire(timer.id), a.seconds * 1000));
        return { changed: true, say: phrases.timerStarted(a.seconds, named), kind: "timerStarted", note: `timer ${timer.id}` };
      }

      case "handoff":
        return { changed: false, say: this.handoffText(), kind: "handoff", note: "handoff" };
    }
  }

  private logFinding(text: string, utt: Utterance, at: string) {
    const f: Finding = { id: `F${this.nextFinding++}`, finding: text, at, history: [{ at, kind: "logged", by: utt.speaker, said: utt.text, to: text }] };
    this.findings.push(f);
    this.markResult(f.id);
    return { changed: true, say: phrases.findingLogged(text), kind: "findingLogged", note: `logged ${f.id}` };
  }

  private markResult(id: string) {
    this.results = this.results.filter((x) => x !== id);
    this.results.push(id);
  }

  handoffText(): string {
    const corrected = (h: HistoryEvent[]) => [...h].reverse().find((x) => x.kind === "corrected");
    const items: Array<{ at: string; text: string }> = [];
    for (const t of this.tasks.filter((x) => x.status === "done")) {
      const c = corrected(t.history);
      const what = t.result ? `${t.description}: ${t.result}` : `${t.description} done`;
      items.push({ at: t.history[0].at, text: c ? `${what}, corrected from ${c.from}` : what });
    }
    for (const f of this.findings) {
      const c = corrected(f.history);
      items.push({ at: f.at, text: c ? `${f.finding}, corrected from ${c.from}` : f.finding });
    }
    const confirmed = items.sort((a, b) => a.at.localeCompare(b.at)).map((i) => i.text);
    const pending = this.tasks.filter((t) => t.status !== "done").map((t) =>
      `${t.assignee}: ${t.description}, ${t.status === "accepted" ? "in progress" : "not yet accepted"}`
    );
    return phrases.handoff(confirmed, pending);
  }

  private expire(id: string) {
    const t = this.timers.find((x) => x.id === id);
    this.timerHandles.delete(id);
    if (!t || t.state !== "running") return;
    t.state = "expired";
    this.d.broadcast("alert", { person: t.person, kind: "timer", timer: t.id, at: this.iso() });
    this.publishBoard();
    this.queue = this.queue
      .then(() => this.d.speak(phrases.timerExpired(t.person, durationWords(t.seconds)), "timerExpired"))
      .catch((err) => this.d.broadcast("voice_error", { message: (err as Error).message, at: this.iso() }));
  }

  /** The task a line refers to: the id the model named, else that person's only task in the allowed states. */
  private findTask(id: string, who: string | null, states: TaskStatus[]): Task | undefined {
    const byId = this.tasks.find((t) => t.id === id && states.includes(t.status));
    if (byId) return byId;
    const open = this.tasks.filter((t) => states.includes(t.status));
    const mine = who ? open.filter((t) => t.assignee === who) : [];
    if (mine.length === 1) return mine[0];
    // Nobody identifiable, or the voice label points at someone with no such task (diarization is unreliable
    // on short phrases like "On it."): if only one task can be meant, it is that one.
    if (mine.length === 0 && open.length === 1) return open[0];
    return undefined; // none or ambiguous: ask instead of guessing
  }

  dispose() {
    const clear = this.d.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    for (const h of this.timerHandles.values()) clear(h);
    this.timerHandles.clear();
  }
}
