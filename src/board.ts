// Task ledger for the dashboard. Built from the band lifecycle routes (assigned → tap → completed) so the
// page can show Pending / Accepted / Done. It only records what those routes did; BandService still decides
// the LED and the spoken line.

export type TaskStatus = "pending" | "accepted" | "done";

export interface TaskEvent {
  at: string;
  kind: "assigned" | "sent" | "accepted" | "completed";
  detail?: string;
}

export interface BoardTask {
  id: string;
  crewId: string | null; // band wearer this task belongs to (null when sent to someone without a band)
  assignee: string;
  description: string;
  status: TaskStatus;
  result: string | null;
  createdAt: string;
  updatedAt: string;
  history: TaskEvent[];
}

const displayName = (id: string) => id.charAt(0).toUpperCase() + id.slice(1);

export class TaskBoard {
  private tasks: BoardTask[] = [];
  private next = 1;

  constructor(private now: () => Date = () => new Date()) {}

  list(): BoardTask[] {
    return structuredClone(this.tasks);
  }

  private add(crewId: string | null, assignee: string, description: string, kind: TaskEvent["kind"], detail?: string) {
    const at = this.now().toISOString();
    const task: BoardTask = {
      id: `T${this.next++}`, crewId, assignee, description, status: "pending", result: null,
      createdAt: at, updatedAt: at, history: [{ at, kind, detail }],
    };
    this.tasks.push(task);
    return task;
  }

  private move(task: BoardTask, status: TaskStatus, kind: TaskEvent["kind"], detail?: string) {
    const at = this.now().toISOString();
    task.status = status;
    task.updatedAt = at;
    task.history.push({ at, kind, detail });
    return structuredClone(task);
  }

  private latest(crewId: string, status: TaskStatus, description?: string) {
    const id = crewId.toLowerCase();
    for (let i = this.tasks.length - 1; i >= 0; i--) {
      const t = this.tasks[i];
      if (t.crewId === id && t.status === status && (description === undefined || t.description === description)) return t;
    }
    return undefined;
  }

  /** A task was assigned to this band wearer. */
  assigned(crewId: string, description: string): BoardTask {
    const id = crewId.toLowerCase();
    return structuredClone(this.add(id, displayName(id), description, "assigned"));
  }

  /** The band wearer sent a task to someone else (by name). */
  sent(fromCrewId: string, person: string, description: string): BoardTask {
    return structuredClone(this.add(null, person.trim(), description, "sent", `from ${displayName(fromCrewId.toLowerCase())}`));
  }

  /** Double-tap (legacy): the most recently assigned pending task is accepted. */
  accepted(crewId: string): BoardTask | null {
    const t = this.latest(crewId, "pending");
    return t ? this.move(t, "accepted", "accepted") : null;
  }

  /** Double-tap with explicit selection: accept a specific pending task by ID. */
  acceptedById(taskId: string): BoardTask | null {
    const t = this.tasks.find((x) => x.id === taskId && x.status === "pending");
    return t ? this.move(t, "accepted", "accepted") : null;
  }

  /** A result was reported: closes the accepted task, else a matching pending one, else records a new done task. */
  completed(crewId: string, description: string | undefined, result: string | undefined, taskId?: string): BoardTask {
    const t =
      (taskId ? this.tasks.find((x) => x.id === taskId && (x.status === "accepted" || x.status === "pending")) : undefined) ??
      this.latest(crewId, "accepted") ??
      (description ? this.latest(crewId, "pending", description) : undefined);
    const target = t ?? this.add(crewId.toLowerCase(), displayName(crewId.toLowerCase()), description?.trim() || "Task", "assigned");
    target.result = result?.trim() || null;
    return this.move(target, "done", "completed", target.result ?? undefined);
  }
}
