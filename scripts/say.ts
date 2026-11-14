// Usage: npm run say -- "Repeat blood pressure assigned to Alex."   -> writes out/say.mp3
import { mkdir, writeFile } from "node:fs/promises";
import { config } from "../src/config.js";
import { VoiceService } from "../src/voice.js";

const text = process.argv.slice(2).join(" ") || "Repeat blood pressure assigned to Alex.";
const voice = new VoiceService({ ...config.minimax });
const r = await voice.speak(text);
await mkdir("out", { recursive: true });
await writeFile("out/say.mp3", r.audio);
console.log(`ok: ${r.audio.length} bytes, cached=${r.cached}, ${r.latencyMs}ms -> out/say.mp3`);
console.log(await voice.usage());
