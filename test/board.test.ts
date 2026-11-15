import { describe, it, expect } from "vitest";
import { TaskBoard } from "../src/board.js";

let t = 0;
const clock = () => new Date(Date.UTC(2026, 10, 14, 12, 0, t++));
const make = () => new TaskBoard(clock);

describe("TaskBoard", () => {
  it("assigned -> pending card for the band wearer", () => {
    const b = make();
    const c = b.assigned("chris", "repeat blood pressure");
    expect(c).toMatchObject({ id: "T1", crewId: "chris", assignee: "Chris", description: "repeat blood pressure", status: "pending", result: null });
  });

  it("tap moves the latest pending card for that crew to accepted", () => {
    const b = make();
    b.assigned("chris", "old task");
    b.assigned("chris", "repeat blood pressure");
    const c = b.accepted("chris");
    expect(c?.description).toBe("repeat blood pressure");
    expect(c?.status).toBe("accepted");
    expect(b.list().find((x) => x.description === "old task")?.status).toBe("pending");
  });

  it("tap with nothing pending changes nothing", () => {
    const b = make();
    expect(b.accepted("chris")).toBeNull();
    expect(b.list()).toHaveLength(0);
  });

  it("completed closes the accepted card and records the result", () => {
    const b = make();
    b.assigned("chris", "repeat blood pressure");
    b.accepted("chris");
    const c = b.completed("chris", undefined, "BP 110 over 70");
    expect(c).toMatchObject({ id: "T1", status: "done", result: "BP 110 over 70" });
    expect(c.history.map((h) => h.kind)).toEqual(["assigned", "accepted", "completed"]);
  });

  it("completed without an accept closes the matching pending card", () => {
    const b = make();
    b.assigned("chris", "repeat blood pressure");
    const c = b.completed("chris", "repeat blood pressure", "BP 120 over 80");
    expect(c).toMatchObject({ id: "T1", status: "done" });
    expect(b.list()).toHaveLength(1);
  });

  it("completed with no matching card adds a done card", () => {
    const b = make();
    const c = b.completed("chris", "glucose check", "glucose 95");
    expect(c).toMatchObject({ status: "done", description: "glucose check", result: "glucose 95" });
  });

  it("taskSent creates a pending card for the named person", () => {
    const b = make();
    const c = b.sent("chris", "Alex", "start IV");
    expect(c).toMatchObject({ assignee: "Alex", crewId: null, status: "pending", description: "start IV" });
  });

  it("list returns copies so callers cannot mutate state", () => {
    const b = make();
    b.assigned("chris", "x");
    b.list()[0].status = "done";
    expect(b.list()[0].status).toBe("pending");
  });

  it("acceptedById accepts the specific pending task regardless of order", () => {
    const b = make();
    b.assigned("chris", "repeat blood pressure");
    b.assigned("chris", "check glucose");
    const firstId = b.list()[0].id;
    const c = b.acceptedById(firstId);
    expect(c).toMatchObject({ id: firstId, description: "repeat blood pressure", status: "accepted" });
    expect(b.list().find((x) => x.description === "check glucose")?.status).toBe("pending");
  });

  it("acceptedById returns null for a non-existent or already-accepted task", () => {
    const b = make();
    b.assigned("chris", "repeat blood pressure");
    b.accepted("chris");
    expect(b.acceptedById("T1")).toBeNull();
    expect(b.acceptedById("T999")).toBeNull();
  });

  it("completed with taskId closes the specific task regardless of accepted order", () => {
    const b = make();
    b.assigned("chris", "repeat blood pressure");
    b.assigned("chris", "check glucose");
    b.acceptedById("T1");
    b.acceptedById("T2");
    const c = b.completed("chris", undefined, "glucose 95", "T2");
    expect(c).toMatchObject({ id: "T2", description: "check glucose", status: "done", result: "glucose 95" });
    expect(b.list().find((x) => x.id === "T1")?.status).toBe("accepted");
  });
});
