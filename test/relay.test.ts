import { describe, it, expect, vi } from "vitest";
import { Relay, cleanCrew, type Utterance } from "../src/relay.js";
import type { Action, InterpretContext } from "../src/interpret.js";
import type { Transcript } from "../src/stt.js";

const act = (a: Partial<Action>): Action => ({ action: "none", person: "unknown", task: "", task_id: "", result: "", seconds: 0, clarify: "", ...a });
const utt = (speaker: string, text = "…"): Utterance => ({ id: "U0", at: "", speaker, text });
const tr = (text: string, speaker: number | null, isFinal = true): Transcript => ({ text, isFinal, speechFinal: false, start: 0, duration: 0, speaker });

function setup(actions: Action[] = [], crew = ["Mark", "Sarah"]) {
  const spoken: string[] = [];
  const events: Array<[string, any]> = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const interpret = vi.fn(async (_ctx: InterpretContext) => actions.shift() ?? act({}));
  const relay = new Relay({
    interpret, speak: async (t) => { spoken.push(t); }, broadcast: (e, d) => events.push([e, d]),
    now: () => new Date("2026-11-14T12:00:00Z"), setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => {},
  }, crew);
  return { relay, spoken, events, timers, interpret };
}

describe("crew roster", () => {
  it("cleans names: trims, dedupes case-insensitively, rejects junk and reserved labels", () => {
    expect(cleanCrew([" Mark ", "mark", "Sarah  Lee", ""])).toEqual(["Mark", "Sarah Lee"]);
    expect(() => cleanCrew(["<script>"])).toThrow(/not a usable name/);
    expect(() => cleanCrew(["Voice 1"])).toThrow(); // digits are not allowed in names at all
    expect(() => cleanCrew(["Unknown"])).toThrow(/reserved/);
    expect(() => cleanCrew("Mark")).toThrow(/list/);
  });

  it("voices map to crew names; removing a name clears its voice", () => {
    const { relay } = setup();
    expect(relay.speakerName(0)).toBe("Voice 1");
    relay.setVoice(0, "Mark");
    expect(relay.speakerName(0)).toBe("Mark");
    relay.setVoice(1, "Mark"); // one voice per name: moves
    expect(relay.voices).toEqual([null, "Mark"]);
    expect(() => relay.setVoice(0, "Bob")).toThrow(/not on the crew/);
    relay.setCrew(["Sarah"]);
    expect(relay.voices).toEqual([null, null]);
  });
});

describe("Relay: utterances", () => {
  it("joins final pieces until UtteranceEnd and asks the model once, with the roster", async () => {
    const { relay, interpret, events } = setup();
    relay.setVoice(0, "Sarah");
    relay.onTranscript(tr("Ask Mark to", 0));
    relay.onTranscript(tr("Ask Mark to rec", 0, false)); // interim: ignored
    relay.onTranscript(tr("record the blood pressure of a patient.", 0));
    relay.onUtteranceEnd();
    await relay.idle();
    expect(interpret).toHaveBeenCalledTimes(1);
    expect(interpret.mock.calls[0][0]).toMatchObject({ crew: ["Mark", "Sarah"], speaker: "Sarah", newest: "Ask Mark to record the blood pressure of a patient." });
    expect(events.find(([e]) => e === "utterance")?.[1]).toMatchObject({ speaker: "Sarah" });
  });

  it("a change of voice starts a new utterance even without a pause; stopping flushes the last words", async () => {
    const { relay, interpret } = setup();
    relay.onTranscript(tr("Mark, repeat the BP.", 0));
    relay.onTranscript(tr("On it.", 1));
    relay.endSession();
    await relay.idle();
    expect(interpret.mock.calls.map((c) => [c[0].speaker, c[0].newest])).toEqual([["Voice 1", "Mark, repeat the BP."], ["Voice 2", "On it."]]);
    expect(interpret.mock.calls[1][0].recent).toEqual([{ speaker: "Voice 1", text: "Mark, repeat the BP." }]);
  });
});

describe("Relay: tasks, findings and corrections — spoken only after the state changed", () => {
  it("your case: 'Ask Mark to record the blood pressure of a patient.' becomes a task for Mark", () => {
    const { relay } = setup();
    const r = relay.apply(act({ action: "assign_task", person: "Mark", task: "record blood pressure" }), utt("Voice 1", "Ask Mark to record the blood pressure of a patient."));
    expect(r.say).toBe("Record blood pressure assigned to Mark.");
    expect(relay.tasks[0]).toMatchObject({ assignee: "Mark", status: "pending" });
  });

  it("assign -> accept -> complete -> correct -> handoff", () => {
    const { relay } = setup();
    relay.setVoice(1, "Mark");
    relay.apply(act({ action: "assign_task", person: "Mark", task: "repeat blood pressure" }), utt("Voice 1", "Mark, repeat the BP"));
    expect(relay.apply(act({ action: "accept_task" }), utt("Mark", "On it")).say).toBe("Mark accepted: repeat blood pressure.");
    expect(relay.apply(act({ action: "complete_task", person: "Mark", result: "BP 110 over 70" }), utt("Mark", "BP 110 over 70")).say)
      .toBe("Mark reports BP 110 over 70. Repeat blood pressure complete.");
    expect(relay.apply(act({ action: "correct_result", result: "BP 100 over 70" }), utt("Mark", "Correction, 100 over 70")).say)
      .toBe("Correction logged: repeat blood pressure BP 100 over 70, previously BP 110 over 70.");
    const t = relay.tasks[0];
    expect(t.history.map((h) => h.kind)).toEqual(["assigned", "accepted", "completed", "corrected"]);
    expect(t.history[3]).toMatchObject({ from: "BP 110 over 70", to: "BP 100 over 70" }); // original kept
    relay.apply(act({ action: "assign_task", person: "Sarah", task: "twelve-lead ECG" }), utt("Voice 1"));
    expect(relay.handoffText()).toBe(
      "Handoff. Confirmed: repeat blood pressure: BP 100 over 70, corrected from BP 110 over 70. Still pending: Sarah: twelve-lead ECG, not yet accepted."
    );
  });

  it("your case: 'Blood pressure is normal.' with no task is logged as a finding, confirmed, and correctable", () => {
    const { relay } = setup();
    expect(relay.apply(act({ action: "log_finding", result: "blood pressure normal" }), utt("Voice 2", "Blood pressure is normal.")).say)
      .toBe("Logged: blood pressure normal.");
    // the model may call it complete_task instead: with no open task it is logged, not questioned
    expect(relay.apply(act({ action: "complete_task", result: "patient alert" }), utt("Voice 2", "Patient is alert.")).say).toBe("Logged: patient alert.");
    expect(relay.findings.map((f) => f.finding)).toEqual(["blood pressure normal", "patient alert"]);
    expect(relay.apply(act({ action: "correct_result", task_id: "F1", result: "blood pressure low" }), utt("Voice 2")).say)
      .toBe("Correction logged: blood pressure low, previously blood pressure normal.");
    expect(relay.findings[0].history.at(-1)).toMatchObject({ kind: "corrected", from: "blood pressure normal" });
    expect(relay.handoffText()).toBe("Handoff. Confirmed: blood pressure low, corrected from blood pressure normal; patient alert. No open tasks.");
  });

  it("stays quiet instead of asking when there is nothing to refer to", () => {
    const { relay } = setup();
    expect(relay.apply(act({ action: "accept_task" }), utt("Voice 1", "On it")).say).toBeUndefined();
    expect(relay.apply(act({ action: "complete_task" }), utt("Voice 1", "Done")).say).toBeUndefined();
    expect(relay.apply(act({ action: "none" }), utt("Voice 1", "Report what")).say).toBeUndefined();
  });

  it("asks instead of guessing: no assignee, not on the roster, ambiguous task, bad timer", () => {
    const { relay } = setup();
    expect(relay.apply(act({ action: "assign_task", person: "unknown", task: "get vitals" }), utt("Voice 1")).say).toBe("Sorry, I didn't catch who that task is for. Please repeat.");
    relay.apply(act({ action: "assign_task", person: "Mark", task: "get vitals" }), utt("Voice 1"));
    relay.apply(act({ action: "assign_task", person: "Mark", task: "check pupils" }), utt("Voice 1"));
    expect(relay.apply(act({ action: "complete_task", person: "Mark" }), utt("Voice 2")).say).toMatch(/which task/);
    expect(relay.apply(act({ action: "complete_task", person: "Mark", task_id: "T2", result: "equal" }), utt("Voice 2")).say).toMatch(/Check pupils complete/);
    expect(relay.apply(act({ action: "start_timer", person: "Mark", seconds: 0 }), utt("Voice 1")).say).toMatch(/how long/);
    expect(relay.apply(act({ action: "start_timer", person: "unknown", seconds: 60 }), utt("Voice 1")).say).toMatch(/who the timer is for/);
    const empty = setup([], []).relay;
    expect(empty.apply(act({ action: "assign_task", person: "unknown", task: "get vitals" }), utt("Voice 1")).say).toMatch(/No crew names are entered yet/);
  });

  it("a mislabelled short reply still reaches the only open task", () => {
    const { relay } = setup();
    relay.setVoice(0, "Sarah");
    relay.apply(act({ action: "assign_task", person: "Mark", task: "repeat blood pressure" }), utt("Sarah"));
    expect(relay.apply(act({ action: "accept_task" }), utt("Sarah", "On it.")).say).toBe("Mark accepted: repeat blood pressure.");
  });

  it("timers: confirm on start, alert and speak on expiry", async () => {
    const { relay, spoken, events, timers } = setup();
    expect(relay.apply(act({ action: "start_timer", person: "Mark", seconds: 120 }), utt("Voice 1")).say).toBe("Two-minute timer started for Mark.");
    expect(timers[0].ms).toBe(120000);
    timers[0].fn();
    await relay.idle();
    expect(relay.timers[0].state).toBe("expired");
    expect(events.find(([e]) => e === "alert")?.[1]).toMatchObject({ person: "Mark", kind: "timer" });
    expect(spoken).toEqual(["Mark, two-minute timer is up."]);
  });

  it("handle(): a model failure changes nothing; a valid action changes state, broadcasts, then speaks", async () => {
    const a = setup();
    a.interpret.mockRejectedValueOnce(new Error("OpenAI does not accept the key (status 401)"));
    a.relay.onTranscript(tr("Mark, get vitals.", 0));
    a.relay.onUtteranceEnd();
    await a.relay.idle();
    expect(a.relay.tasks).toEqual([]);
    expect(a.spoken).toEqual([]);
    expect(a.events.find(([e]) => e === "task_error")?.[1].message).toMatch(/401/);

    const b = setup([act({ action: "assign_task", person: "Mark", task: "get vitals" })]);
    b.relay.onTranscript(tr("Mark, get vitals.", 0));
    b.relay.onUtteranceEnd();
    await b.relay.idle();
    const names = b.events.map(([e]) => e);
    expect(names.indexOf("tasks")).toBeGreaterThan(names.indexOf("action"));
    expect(b.spoken).toEqual(["Get vitals assigned to Mark."]);
  });
});
