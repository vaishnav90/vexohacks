import { describe, it, expect, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { VoiceService } from "../src/voice.js";

const okFetch = () =>
  vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: { audio: "aabb" }, base_resp: { status_code: 0 } }) });

async function svc(fetchImpl: any, charBudget = 1000) {
  const cacheDir = await mkdtemp(path.join(tmpdir(), "relay-tts-"));
  return new VoiceService({ apiKey: "k", model: "m", voiceId: "v", fetchImpl, cacheDir, charBudget });
}

describe("VoiceService", () => {
  it("caches identical text so MiniMax is only billed once", async () => {
    const f = okFetch();
    const v = await svc(f);
    const a = await v.speak("Two-minute timer started for Alex.");
    const b = await v.speak("Two-minute timer started for Alex.");
    expect(a.cached).toBe(false);
    expect(b.cached).toBe(true);
    expect(f).toHaveBeenCalledTimes(1);
    expect((await v.usage()).usedChars).toBe("Two-minute timer started for Alex.".length);
  });

  it("refuses new synthesis past the character budget", async () => {
    const f = okFetch();
    const v = await svc(f, 10);
    await expect(v.speak("This sentence is longer than ten characters.")).rejects.toThrow(/budget/);
    expect(f).not.toHaveBeenCalled();
  });

  it("rejects path-traversal audio ids", async () => {
    const v = await svc(okFetch());
    expect(() => v.audioPath("../../etc/passwd")).toThrow();
  });
});
