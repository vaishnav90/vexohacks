import "dotenv/config";
import path from "node:path";

export const config = {
  port: Number(process.env.PORT ?? 3000),
  minimax: {
    apiKey: process.env.MINIMAX_API_KEY ?? "",
    model: process.env.MINIMAX_MODEL || "speech-2.8-turbo",
    voiceId: process.env.MINIMAX_VOICE_ID || "English_expressive_narrator",
    charBudget: Number(process.env.MINIMAX_CHAR_BUDGET ?? 150000),
    cacheDir: path.resolve(".cache/tts"),
  },
};
