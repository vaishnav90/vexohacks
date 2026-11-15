import { phrases } from "./phrases.js";

export interface LedCommand {
  color: string;
  pattern: "blink" | "steady" | "off";
  period?: number;     // ms, only for blink
  durationMs?: number; // ms until auto-off; absent = stays until next command
}

export type BandState = "assigned" | "timerExpired" | "clarify" | "taskSent" | "completed";

export interface NotifyParams {
  task?: string;
  person?: string; // who is assigning (for "assigned") or who to assign to (for "taskSent")
  label?: string;  // e.g. "two-minute", used by timerExpired
  what?: string;   // e.g. "who that task is for", used by clarify
  result?: string; // measurement or finding reported by the crew member (for "completed")
}

export interface NotifyResult {
  ledCommand: LedCommand;
  voiceText: string;
}

const LED: Record<BandState | "acknowledged", LedCommand> = {
  assigned:     { color: "#ff8800", pattern: "blink",  period: 500 },
  timerExpired: { color: "#ff0000", pattern: "blink",  period: 200 },
  clarify:      { color: "#8800ff", pattern: "blink",  period: 800 },
  taskSent:     { color: "#ffffff", pattern: "steady", durationMs: 1000 },
  completed:    { color: "#00ffff", pattern: "steady", durationMs: 2000 },
  acknowledged: { color: "#00ff00", pattern: "steady", durationMs: 3000 },
};

function displayName(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1);
}

export class BandService {
  private pending  = new Map<string, string>(); // crewId → pending task (waiting for accept)
  private lastTask = new Map<string, string>(); // crewId → last accepted task (waiting for result)

  constructor(private crewToBand: Record<string, number>) {
    this.crewToBand = Object.fromEntries(
      Object.entries(crewToBand).map(([k, v]) => [k.toLowerCase(), v])
    );
  }

  hasCrew(crewId: string): boolean {
    return crewId.toLowerCase() in this.crewToBand;
  }

  notify(crewId: string, state: BandState, params: NotifyParams = {}): NotifyResult | null {
    const id = crewId.toLowerCase();
    if (!(id in this.crewToBand)) return null;

    const { task = "", person = "", label, what = "that", result } = params;
    const name = displayName(id);

    if (state === "assigned" && task) {
      this.pending.set(id, task);
    }

    const ledCommand: LedCommand = { ...LED[state] };

    let voiceText: string;
    switch (state) {
      case "assigned":
        voiceText = phrases.taskAssigned(task, name);
        break;
      case "timerExpired":
        voiceText = phrases.timerExpired(name, label);
        break;
      case "clarify":
        voiceText = phrases.clarify(what);
        break;
      case "taskSent":
        voiceText = phrases.taskAssigned(task, person);
        break;
      case "completed": {
        const completedTask = this.lastTask.get(id) ?? task;
        this.lastTask.delete(id);
        voiceText = phrases.taskCompleted(completedTask, name, result);
        break;
      }
      default: {
        const _: never = state;
        throw new Error(`Unknown band state: ${String(_)}`);
      }
    }

    return { ledCommand, voiceText };
  }

  /**
   * Called when the band wearer double-taps to acknowledge a pending task.
   * Returns null if there is no pending task (tap is ignored).
   */
  handleTap(crewId: string): NotifyResult | null {
    const id = crewId.toLowerCase();
    if (!(id in this.crewToBand)) return null;
    const task = this.pending.get(id);
    if (!task) return null;
    this.pending.delete(id);
    this.lastTask.set(id, task); // remember so completed state can reference it
    return {
      ledCommand: { ...LED.acknowledged },
      voiceText: phrases.taskAccepted(task, displayName(id)),
    };
  }
}
