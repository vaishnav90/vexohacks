// MiniMax T2A v2 client (non-streaming). Docs: https://platform.minimax.io/docs/api-reference/speech-t2a-http
export const MINIMAX_URL = "https://api.minimax.io/v1/t2a_v2";
export const MAX_TEXT_CHARS = 3000; // MiniMax allows 10k; we keep requests short and cheap.

export interface MiniMaxConfig {
  apiKey: string;
  model: string;
  voiceId: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface SynthesisResult {
  audio: Buffer; // mp3 bytes
  durationMs: number | null;
  charsBilled: number | null;
  traceId: string | null;
}

export class MiniMaxError extends Error {
  constructor(message: string, readonly statusCode?: number, readonly traceId?: string | null) {
    super(message);
    this.name = "MiniMaxError";
  }
}

const STATUS_HINTS: Record<number, string> = {
  1001: "MiniMax timed out",
  1002: "MiniMax rate limit exceeded",
  1004: "MiniMax authentication failed — check MINIMAX_API_KEY",
  1008: "MiniMax account balance insufficient",
  1039: "MiniMax tokens-per-minute limit exceeded",
  1042: "Text has too many invalid characters",
  2013: "Invalid request parameters (check model / voice_id)",
};

export async function synthesize(text: string, cfg: MiniMaxConfig): Promise<SynthesisResult> {
  const clean = text.trim();
  if (!clean) throw new MiniMaxError("Text is empty");
  if (clean.length > MAX_TEXT_CHARS) throw new MiniMaxError(`Text exceeds ${MAX_TEXT_CHARS} characters`);
  if (!cfg.apiKey) throw new MiniMaxError("MINIMAX_API_KEY is not set");

  const doFetch = cfg.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs ?? 15000);

  let res: Response;
  try {
    res = await doFetch(MINIMAX_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: cfg.model,
        text: clean,
        stream: false,
        output_format: "hex",
        language_boost: "English",
        voice_setting: { voice_id: cfg.voiceId, speed: 1.05, vol: 1, pitch: 0 },
        audio_setting: { sample_rate: 32000, bitrate: 128000, format: "mp3", channel: 1 },
      }),
      signal: controller.signal,
    });
  } catch (err) {
    const aborted = (err as Error).name === "AbortError";
    throw new MiniMaxError(aborted ? "MiniMax request timed out" : `MiniMax network error: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new MiniMaxError(`MiniMax HTTP ${res.status}: ${body.slice(0, 300)}`, res.status);
  }

  const json = (await res.json()) as any;
  const traceId: string | null = json?.trace_id ?? null;
  const code: number | undefined = json?.base_resp?.status_code;
  if (code !== 0) {
    const msg = json?.base_resp?.status_msg ?? "unknown error";
    const hint = code !== undefined ? STATUS_HINTS[code] : undefined;
    throw new MiniMaxError(`${hint ?? "MiniMax error"} (code ${code}: ${msg})`, code, traceId);
  }

  const hex: unknown = json?.data?.audio;
  if (typeof hex !== "string" || hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new MiniMaxError("MiniMax returned no valid audio", code, traceId);
  }

  return {
    audio: Buffer.from(hex, "hex"),
    durationMs: json?.extra_info?.audio_length ?? null,
    charsBilled: json?.extra_info?.usage_characters ?? null,
    traceId,
  };
}
