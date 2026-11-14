import { describe, it, expect, vi } from "vitest";
import { synthesize, MINIMAX_URL } from "../src/minimax.js";

const cfg = (fetchImpl: any) => ({ apiKey: "k", model: "speech-2.8-turbo", voiceId: "v", fetchImpl });
const ok = (body: any) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

describe("synthesize", () => {
  it("sends the documented request and decodes hex audio", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      ok({ data: { audio: "494433", status: 2 }, extra_info: { audio_length: 900, usage_characters: 38 }, trace_id: "t1", base_resp: { status_code: 0, status_msg: "success" } })
    );
    const r = await synthesize("  Repeat blood pressure assigned to Alex.  ", cfg(fetchImpl));
    expect(r.audio.equals(Buffer.from([0x49, 0x44, 0x33]))).toBe(true);
    expect(r.durationMs).toBe(900);
    expect(r.charsBilled).toBe(38);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(MINIMAX_URL);
    expect(init.headers.Authorization).toBe("Bearer k");
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ model: "speech-2.8-turbo", text: "Repeat blood pressure assigned to Alex.", stream: false, output_format: "hex" });
    expect(body.voice_setting.voice_id).toBe("v");
    expect(body.audio_setting.format).toBe("mp3");
  });

  it("surfaces MiniMax error codes with a hint", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ base_resp: { status_code: 1004, status_msg: "auth failed" } }));
    await expect(synthesize("hi", cfg(fetchImpl))).rejects.toThrow(/authentication failed.*1004/);
  });

  it("rejects HTTP errors, missing audio, empty text, missing key", async () => {
    await expect(synthesize("hi", cfg(vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "boom" })))).rejects.toThrow(/HTTP 500/);
    await expect(synthesize("hi", cfg(vi.fn().mockResolvedValue(ok({ data: {}, base_resp: { status_code: 0 } }))))).rejects.toThrow(/no valid audio/);
    await expect(synthesize("   ", cfg(vi.fn()))).rejects.toThrow(/empty/);
    await expect(synthesize("hi", { ...cfg(vi.fn()), apiKey: "" })).rejects.toThrow(/MINIMAX_API_KEY/);
  });
});
