// The exact sentences Relay speaks. Built by code from confirmed backend state — never by an LLM —
// so the voice only ever says what actually happened.


export function durationWords(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("duration must be positive");
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m && s) return `${numberWord(m)} minute ${numberWord(s)} second`;
  return m ? `${numberWord(m)}-minute` : `${numberWord(s)}-second`;
}

const SMALL = ["zero","one","two","three","four","five","six","seven","eight","nine","ten","eleven","twelve","thirteen","fourteen","fifteen","sixteen","seventeen","eighteen","nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty"];
function numberWord(n: number): string {
  if (n < 20) return SMALL[n];
  if (n < 60) return TENS[Math.floor(n / 10)] + (n % 10 ? `-${SMALL[n % 10]}` : "");
  return String(n);
}

/** "repeat the blood pressure" -> "Repeat the blood pressure" */
function cap(s: string) {
  const t = s.trim().replace(/[.!?]+$/, "");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export const phrases = {
  taskAssigned: (task: string, person: string) => `${cap(task)} assigned to ${person}.`,
  taskAccepted: (task: string, person: string) => `${person} accepted: ${task.trim().replace(/[.!?]+$/, "").toLowerCase()}.`,
  taskCompleted: (task: string, person: string, result?: string) =>
    result ? `${person} reports ${result.trim().replace(/[.!?]+$/, "")}. ${cap(task)} complete.` : `${cap(task)} complete, reported by ${person}.`,
  timerStarted: (seconds: number, person: string) => `${cap(durationWords(seconds))} timer started for ${person}.`,
  timerExpired: (person: string, label?: string) => (label ? `${person}, ${label} timer is up.` : `${person}, your timer is up.`),
  correction: (field: string, from: string, to: string) => `Correction logged: ${field} ${to}, previously ${from}.`,
  clarify: (what: string) => `Sorry, I didn't catch ${what}. Please repeat.`,
  handoff: (confirmed: string[], pending: string[]) => {
    const c = confirmed.length ? `Confirmed: ${confirmed.join("; ")}.` : "No confirmed events.";
    const p = pending.length ? `Still pending: ${pending.join("; ")}.` : "No open tasks.";
    return `Handoff. ${c} ${p}`;
  },
};
