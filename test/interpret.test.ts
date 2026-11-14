import { describe, it, expect, vi } from "vitest";
import { interpret, parseAnswer, actionSchema, buildInput, OPENAI_URL, type InterpretContext } from "../src/interpret.js";

const crew = ["Person 1", "Person 2"];
const ctx: InterpretContext = {
  crew, speaker: "Person 1", newest: "Person 2, repeat the blood pressure.", recent: [{ speaker: "Person 2", text: "Pulse is 88." }],
  openTasks: [{ id: "T1", assignee: "Person 2", description: "check pulse", status: "done", result: "88" }],
};
const answer = (obj: unknown) => ({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(obj) }] }] });
const full = { action: "assign_task", person: "Person 2", task: "repeat blood pressure", task_id: "", result: "", seconds: 0, clarify: "" };
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

describe("interpret", () => {
  it("sends the kit's Responses API request: store false, strict JSON schema, Bearer key", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok(answer(full)));
    const a = await interpret(ctx, { apiKey: "k", model: "gpt-6-luna", fetchImpl });
    expect(a).toEqual(full);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(OPENAI_URL);
    expect(init.headers.Authorization).toBe("Bearer k");
    expect(init.redirect).toBe("error");
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ model: "gpt-6-luna", store: false });
    expect(body.text.format).toMatchObject({ type: "json_schema", strict: true });
    expect(body.text.format.schema.required).toEqual(Object.keys(body.text.format.schema.properties));
    expect(body.input).toContain("NEWEST line, said by Person 1:\nPerson 2, repeat the blood pressure.");
  });

  it("refusals show the status and OpenAI's code word, never the key", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({ error: { code: "insufficient_quota" } }) });
    await expect(interpret(ctx, { apiKey: "secret-k", model: "m", fetchImpl })).rejects.toThrow(/budget is used up \(status 429\)/);
    const f401 = vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({ error: { code: "invalid_api_key" } }) });
    await expect(interpret(ctx, { apiKey: "secret-k", model: "m", fetchImpl: f401 })).rejects.toThrow(/OPENAI_API_KEY.*401, invalid_api_key/);
  });

  it("without a key it sends nothing", async () => {
    const fetchImpl = vi.fn();
    await expect(interpret(ctx, { apiKey: "", model: "m", fetchImpl })).rejects.toThrow(/OPENAI_API_KEY/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("parseAnswer", () => {
  it("rejects unknown actions, refusals, cut-off and non-JSON answers", () => {
    expect(() => parseAnswer(answer({ ...full, action: "launch" }), crew)).toThrow(/unknown action/);
    expect(() => parseAnswer({ output: [{ type: "message", content: [{ type: "refusal" }] }] }, crew)).toThrow(/declined/);
    expect(() => parseAnswer({ status: "incomplete", output: [] }, crew)).toThrow(/cut off/);
    expect(() => parseAnswer({ output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }] }, crew)).toThrow(/not JSON/);
  });
  it("coerces anything outside the schema to safe values", () => {
    const a = parseAnswer(answer({ ...full, person: "Dr Evil", seconds: 1.5, task: "x".repeat(200) }), crew);
    expect(a.person).toBe("unknown");
    expect(a.seconds).toBe(0);
    expect(a.task).toHaveLength(80);
  });
});

describe("schema and input", () => {
  it("limits person to the crew or unknown", () => {
    expect(actionSchema(crew).properties.person.enum).toEqual(["Person 1", "Person 2", "unknown"]);
  });
  it("lists tasks and earlier lines as context", () => {
    const s = buildInput(ctx);
    expect(s).toContain("T1 | Person 2 | check pulse | done | result: 88");
    expect(s).toContain("Person 2: Pulse is 88.");
  });
});
