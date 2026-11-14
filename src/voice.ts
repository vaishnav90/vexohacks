// Voice service: cache + spending guard in front of MiniMax.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { synthesize, type MiniMaxConfig, MiniMaxError } from "./minimax.js";

export interface VoiceOptions extends MiniMaxConfig {
  cacheDir: string;
  charBudget: number;
}

export interface SpokenLine {
  id: string;
  text: string;
  kind: string;
  at: string; // ISO timestamp
  cached: boolean;
  latencyMs: number;
  durationMs: number | null;
  audioUrl: string;
}

export class VoiceService {
  private usagePath: string;
  private usedChars = 0;
  private loaded = false;

  constructor(private opts: VoiceOptions) {
    this.usagePath = path.join(opts.cacheDir, "usage.json");
  }

  private async init() {
    if (this.loaded) return;
    await mkdir(this.opts.cacheDir, { recursive: true });
    try {
      this.usedChars = JSON.parse(await readFile(this.usagePath, "utf8")).usedChars ?? 0;
    } catch {
      this.usedChars = 0;
    }
    this.loaded = true;
  }

  key(text: string) {
    return createHash("sha256")
      .update(`${this.opts.model}|${this.opts.voiceId}|${text.trim()}`)
      .digest("hex")
      .slice(0, 24);
  }

  audioPath(id: string) {
    if (!/^[0-9a-f]{24}$/.test(id)) throw new Error("bad audio id");
    return path.join(this.opts.cacheDir, `${id}.mp3`);
  }

  async usage() {
    await this.init();
    return { usedChars: this.usedChars, budgetChars: this.opts.charBudget, model: this.opts.model, voiceId: this.opts.voiceId };
  }

  /** Returns mp3 bytes for text, from cache when possible. */
  async speak(text: string): Promise<{ id: string; audio: Buffer; cached: boolean; latencyMs: number; durationMs: number | null }> {
    await this.init();
    const started = Date.now();
    const id = this.key(text);
    const file = this.audioPath(id);
    try {
      const audio = await readFile(file);
      return { id, audio, cached: true, latencyMs: Date.now() - started, durationMs: null };
    } catch {
      /* cache miss */
    }

    const chars = text.trim().length;
    if (this.usedChars + chars > this.opts.charBudget) {
      throw new MiniMaxError(
        `Character budget reached (${this.usedChars}/${this.opts.charBudget}). Raise MINIMAX_CHAR_BUDGET to continue.`
      );
    }

    const result = await synthesize(text, this.opts);
    this.usedChars += result.charsBilled ?? chars;
    await writeFile(this.usagePath, JSON.stringify({ usedChars: this.usedChars }));
    await writeFile(file, result.audio);
    return { id, audio: result.audio, cached: false, latencyMs: Date.now() - started, durationMs: result.durationMs };
  }
}
