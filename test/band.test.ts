import { describe, it, expect } from "vitest";
import { BandService } from "../src/band.js";

const make = () => new BandService({ vaishnav: 26 });

describe("BandService.hasCrew", () => {
  it("returns true for registered crew (case-insensitive)", () => {
    const s = make();
    expect(s.hasCrew("vaishnav")).toBe(true);
    expect(s.hasCrew("Vaishnav")).toBe(true);
    expect(s.hasCrew("VAISHNAV")).toBe(true);
  });

  it("returns false for unknown crew", () => {
    expect(make().hasCrew("alex")).toBe(false);
  });
});

describe("BandService.notify — assigned", () => {
  it("returns orange blink LED and correct voice text", () => {
    const r = make().notify("vaishnav", "assigned", { task: "repeat blood pressure" });
    expect(r).not.toBeNull();
    expect(r!.ledCommand).toMatchObject({ color: "#ff8800", pattern: "blink", period: 500 });
    expect(r!.voiceText).toBe("Repeat blood pressure assigned to Vaishnav.");
  });

  it("stores the task so a later tap can acknowledge it", () => {
    const s = make();
    s.notify("vaishnav", "assigned", { task: "repeat blood pressure" });
    expect(s.handleTap("vaishnav")).not.toBeNull();
  });

  it("returns null for unknown crew", () => {
    expect(make().notify("unknown", "assigned", { task: "something" })).toBeNull();
  });
});

describe("BandService.notify — timerExpired", () => {
  it("returns red fast-blink LED and timer voice text with label", () => {
    const r = make().notify("vaishnav", "timerExpired", { label: "two-minute" });
    expect(r!.ledCommand).toMatchObject({ color: "#ff0000", pattern: "blink", period: 200 });
    expect(r!.voiceText).toBe("Vaishnav, two-minute timer is up.");
  });

  it("falls back to generic timer text when label is omitted", () => {
    const r = make().notify("vaishnav", "timerExpired");
    expect(r!.voiceText).toBe("Vaishnav, your timer is up.");
  });
});

describe("BandService.notify — clarify", () => {
  it("returns purple blink LED and clarify voice text", () => {
    const r = make().notify("vaishnav", "clarify", { what: "who that task is for" });
    expect(r!.ledCommand).toMatchObject({ color: "#8800ff", pattern: "blink", period: 800 });
    expect(r!.voiceText).toBe("Sorry, I didn't catch who that task is for. Please repeat.");
  });

  it("uses default 'that' when what is omitted", () => {
    const r = make().notify("vaishnav", "clarify");
    expect(r!.voiceText).toContain("that");
  });
});

describe("BandService.notify — taskSent", () => {
  it("returns white flash LED and assigned-to voice text", () => {
    const r = make().notify("vaishnav", "taskSent", { task: "repeat blood pressure", person: "Alex" });
    expect(r!.ledCommand).toMatchObject({ color: "#ffffff", pattern: "steady", durationMs: 1000 });
    expect(r!.voiceText).toBe("Repeat blood pressure assigned to Alex.");
  });
});

describe("BandService.handleTap", () => {
  it("returns green solid LED and accepted voice text after a pending task", () => {
    const s = make();
    s.notify("vaishnav", "assigned", { task: "repeat blood pressure" });
    const r = s.handleTap("vaishnav");
    expect(r).not.toBeNull();
    expect(r!.ledCommand).toMatchObject({ color: "#00ff00", pattern: "steady", durationMs: 3000 });
    expect(r!.voiceText).toBe("Vaishnav accepted: repeat blood pressure.");
  });

  it("returns null when there is no pending task", () => {
    expect(make().handleTap("vaishnav")).toBeNull();
  });

  it("clears the pending task so a second tap returns null", () => {
    const s = make();
    s.notify("vaishnav", "assigned", { task: "repeat blood pressure" });
    s.handleTap("vaishnav");
    expect(s.handleTap("vaishnav")).toBeNull();
  });

  it("overwrites pending task when assigned twice before tap", () => {
    const s = make();
    s.notify("vaishnav", "assigned", { task: "first task" });
    s.notify("vaishnav", "assigned", { task: "second task" });
    const r = s.handleTap("vaishnav");
    expect(r!.voiceText).toBe("Vaishnav accepted: second task.");
  });

  it("returns null for unknown crew", () => {
    expect(make().handleTap("unknown")).toBeNull();
  });
});
