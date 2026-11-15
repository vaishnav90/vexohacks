import "dotenv/config";
import path from "node:path";

function parseBandCrew(raw: string | undefined): Record<string, number> {
  if (!raw) return { vaishnav: 26 };
  try {
    return JSON.parse(raw) as Record<string, number>;
  } catch {
    throw new Error(`BAND_CREW is not valid JSON: ${raw}`);
  }
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  minimax: {
    apiKey: process.env.MINIMAX_API_KEY ?? "",
    model: process.env.MINIMAX_MODEL || "speech-2.8-turbo",
    voiceId: process.env.MINIMAX_VOICE_ID || "English_expressive_narrator",
    charBudget: Number(process.env.MINIMAX_CHAR_BUDGET ?? 150000),
    cacheDir: path.resolve(".cache/tts"),
  },
  bandCrew: parseBandCrew(process.env.BAND_CREW),
};
