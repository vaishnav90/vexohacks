import { describe, it, expect } from "vitest";
import { phrases, durationWords } from "../src/phrases.js";

describe("phrases", () => {
  it("matches the spec wording", () => {
    expect(phrases.taskAssigned("repeat blood pressure", "Alex")).toBe("Repeat blood pressure assigned to Alex.");
    expect(phrases.timerStarted(120, "Alex")).toBe("Two-minute timer started for Alex.");
  });
  it("words durations", () => {
    expect(durationWords(90)).toBe("one minute thirty second");
    expect(durationWords(45)).toBe("forty-five-second");
    expect(() => durationWords(0)).toThrow();
  });
  it("builds a handoff separating confirmed and pending", () => {
    expect(phrases.handoff(["BP 100 over 70"], ["Jordan: ECG"])).toBe("Handoff. Confirmed: BP 100 over 70. Still pending: Jordan: ECG.");
    expect(phrases.handoff([], [])).toBe("Handoff. No confirmed events. No open tasks.");
  });
});
