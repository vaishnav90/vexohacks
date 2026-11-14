// Speech -> one structured crew action, using OpenAI's Responses API with a strict JSON schema
// (same request shape as vexo-open-kit/examples/python/ai.py). The model only *proposes* an action;
// src/relay.ts checks it against the real task state before anything changes or is spoken.

export const OPENAI_URL = "https://api.openai.com/v1/responses";

export const ACTIONS = [
  "assign_task", // "Person 2, repeat the blood pressure"
  "accept_task", // "On it" / "Got it"
  "complete_task", // "BP is 110 over 70" / "Done"
  "start_timer", // "Two-minute timer for Person 2"
  "log_finding", // "Blood pressure is normal" — a finding nobody was asked for
  "correct_result", // "Correction: 100 over 70, not 110"
  "handoff", // "Give me the handoff"
  "unclear", // sounds like a command, but who/what is missing
  "none", // conversation, patient talk, anything that is not a crew command
] as const;
export type ActionName = (typeof ACTIONS)[number];

export interface Action {
  action: ActionName;
  person: string; // a crew name, or "unknown"
  task: string; // short imperative for assign_task ("repeat blood pressure"), else ""
  task_id: string; // an existing task ("T2") or finding ("F1") id the line refers to, else ""
  result: string; // reported finding / corrected value, else ""
  seconds: number; // timer length, else 0
  clarify: string; // for "unclear": what is missing, e.g. "who that task is for"
}

export interface InterpretContext {
  crew: string[];
  speaker: string; // who said the newest line, from diarization ("Person 1", or "unknown")
  newest: string;
  recent: Array<{ speaker: string; text: string }>; // earlier lines, oldest first (context only)
  openTasks: Array<{ id: string; assignee: string; description: string; status: string; result?: string }>;
  findings?: Array<{ id: string; finding: string }>;
}

export interface OpenAiConfig {
  apiKey: string;
  model: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  onUsage?: (u: { inputTokens: number; outputTokens: number }) => void; // tokens billed for one request
}

export class InterpretError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "InterpretError";
  }
}

export function actionSchema(crew: string[]) {
  const str = { type: "string" };
  return {
    type: "object",
    additionalProperties: false,
    required: ["action", "person", "task", "task_id", "result", "seconds", "clarify"],
    properties: {
      action: { type: "string", enum: [...ACTIONS] },
      person: { type: "string", enum: [...crew, "unknown"] },
      task: str,
      task_id: str,
      result: str,
      seconds: { type: "integer" },
      clarify: str,
    },
  };
}

export function instructions(crew: string[]): string {
  const roster = crew.length ? crew.join(", ") : "(none entered yet)";
  return [
    "You are Relay, the coordination system of an EMS ambulance crew. Crew members (the only valid names): " + roster + ".",
    "Speech-to-text may spell a name slightly differently (\"Marc\" for \"Mark\"): map it to the crew name it clearly means.",
    "Classify ONLY the NEWEST line into exactly one action. Earlier lines are context (for example the newest line",
    "may finish a sentence started in the previous line). Never act on an earlier line again.",
    "Actions:",
    "- assign_task: someone tells a crew member to do something (\"Mark, repeat the BP\", \"ask Mark to record the BP\").",
    "  person = the assignee. task = a short imperative of at most 8 words, without the name (\"record blood pressure\").",
    "- accept_task: a crew member acknowledges a task (\"on it\", \"got it\", \"copy\"). person = who accepts.",
    "- complete_task: a crew member reports one of the open tasks done, or the finding it asked for (\"BP 110 over 70\",",
    "  \"done\"). person = who reports. result = the finding as said, or \"\" if none.",
    "- log_finding: a clinical finding or event is stated that answers NO open task (\"blood pressure is normal\",",
    "  \"aspirin given\", \"patient is alert\"). result = the finding, short and as said (\"blood pressure normal\").",
    "- start_timer: a timer for a crew member. person = who it is for. seconds = its length.",
    "- correct_result: a reported value is corrected (\"correction, 100 over 70 not 110\"). result = the new value;",
    "  task_id = the task (T..) or finding (F..) being corrected, if clear.",
    "- handoff: someone asks for the handoff / summary for the hospital.",
    "- unclear: ONLY for a complete instruction to a crew member where the assignee or the task is missing or is not",
    "  a crew member (\"record the blood pressure\" with no name). clarify = what is missing, phrased to follow",
    "  \"Sorry, I didn't catch\" (\"who that task is for\").",
    "- none: everything else: greetings, tests (\"hello, testing\"), fragments (\"report what\"), questions, talking to",
    "  the patient, thinking aloud, half sentences. When in doubt between unclear and none, choose none.",
    "task_id: when the line refers to one of the open tasks or findings, its id; otherwise \"\".",
    "The speaker label comes from automatic voice separation and is often wrong for very short phrases",
    "(\"on it\", \"done\"): a name said in the line and the open tasks are better evidence of who is meant.",
    "Speech-to-text may write numbers as words (\"person two\" means Person 2).",
    "Use \"unknown\" for person when no crew member is named and the speaker is unknown. Never invent findings,",
    "names, numbers or tasks that were not said. Unused fields: \"\" for text, 0 for seconds.",
  ].join("\n");
}

export function buildInput(ctx: InterpretContext): string {
  const tasks = ctx.openTasks.length
    ? ctx.openTasks.map((t) => `${t.id} | ${t.assignee} | ${t.description} | ${t.status}${t.result ? ` | result: ${t.result}` : ""}`).join("\n")
    : "(none)";
  const recent = ctx.recent.length ? ctx.recent.map((l) => `${l.speaker}: ${l.text}`).join("\n") : "(none)";
  const findings = ctx.findings?.length ? ctx.findings.map((f) => `${f.id} | ${f.finding}`).join("\n") : "(none)";
  return `Tasks (id | assignee | task | status):\n${tasks}\n\nFindings logged (id | finding):\n${findings}\n\nEarlier lines (context only):\n${recent}\n\nNEWEST line, said by ${ctx.speaker}:\n${ctx.newest}`;
}

/** Messages for refused requests: the status number and our own sentence, never the key or the request. */
function refusal(status: number, code: string): string {
  if (status === 429 && code === "insufficient_quota") return "OpenAI key's budget is used up (status 429)";
  const said: Record<number, string> = {
    400: "OpenAI did not understand the request — check OPENAI_MODEL",
    401: "OpenAI does not accept the key — check OPENAI_API_KEY in .env",
    403: "OpenAI key may not use this model",
    404: "OpenAI does not know this model — check OPENAI_MODEL",
    429: "Too many OpenAI requests — wait a few seconds",
  };
  return `${said[status] ?? "OpenAI could not answer just now"} (status ${status}${code ? ", " + code : ""})`;
}

/** Parses a Responses API answer into an Action, or throws. Exported for tests. */
export function parseAnswer(answer: any, crew: string[]): Action {
  if (!answer || !Array.isArray(answer.output)) throw new InterpretError("OpenAI answer had an unexpected shape");
  if (answer.status === "incomplete") throw new InterpretError("OpenAI answer was cut off");
  const pieces = answer.output.filter((o: any) => o?.type === "message").flatMap((o: any) => o.content ?? []);
  if (pieces.some((p: any) => p?.type === "refusal")) throw new InterpretError("OpenAI declined to answer");
  const text = pieces.filter((p: any) => p?.type === "output_text").map((p: any) => String(p.text ?? "")).join("");
  let a: any;
  try { a = JSON.parse(text); } catch { throw new InterpretError("OpenAI answer was not JSON"); }
  // Strict schema should guarantee this; check anyway — nothing unchecked reaches the task state.
  if (!a || !ACTIONS.includes(a.action)) throw new InterpretError("OpenAI returned an unknown action");
  const s = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const person = [...crew, "unknown"].includes(a.person) ? a.person : "unknown";
  const seconds = Number.isInteger(a.seconds) ? a.seconds : 0;
  return {
    action: a.action,
    person,
    task: s(a.task, 80),
    task_id: s(a.task_id, 8),
    result: s(a.result, 80),
    seconds,
    clarify: s(a.clarify, 80),
  };
}

export async function interpret(ctx: InterpretContext, cfg: OpenAiConfig): Promise<Action> {
  if (!cfg.apiKey) throw new InterpretError("Turning speech into tasks needs OPENAI_API_KEY in .env (then restart)");
  const doFetch = cfg.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs ?? 15000);
  let res: Response;
  try {
    res = await doFetch(OPENAI_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: cfg.model,
        store: false, // OpenAI does not keep the answer
        instructions: instructions(ctx.crew),
        input: buildInput(ctx),
        text: { format: { type: "json_schema", name: "crew_action", strict: true, schema: actionSchema(ctx.crew) } },
      }),
      redirect: "error", // the key goes to this one address, never on to another
      signal: controller.signal,
    });
  } catch (err) {
    const aborted = (err as Error).name === "AbortError";
    throw new InterpretError(aborted ? "OpenAI request timed out" : "Could not reach api.openai.com");
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    let code = "";
    try { code = String((await res.json())?.error?.code ?? ""); } catch { /* no body */ }
    if (!/^[a-z_]{1,40}$/.test(code)) code = "";
    throw new InterpretError(refusal(res.status, code), res.status);
  }
  const answer = await res.json();
  const u = answer?.usage;
  if (u) cfg.onUsage?.({ inputTokens: Number(u.input_tokens) || 0, outputTokens: Number(u.output_tokens) || 0 });
  return parseAnswer(answer, ctx.crew);
}
