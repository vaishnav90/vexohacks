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
  deepgram: {
    apiKey: process.env.DEEPGRAM_API_KEY ?? "",
    model: process.env.DEEPGRAM_MODEL || "nova-3",
    language: "en",
    endpointingMs: 100, // measured best for the band's mic in vexo-open-kit/docs/deepgram.md
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY ?? "",
    model: process.env.OPENAI_MODEL || "gpt-6-luna", // the Vexo kit's default: small, fast, cheap
  },
  vexo: {
    // The team's band (Vexo-HACK-26). The ONE place this number lives; the page reads it from /api/config.
    // Never change it to another team's band.
    band: 26,
    kitDir: path.resolve("vexo-open-kit"),
  },
};
