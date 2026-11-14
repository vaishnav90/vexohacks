// Lists English system voices on your MiniMax account (free call).
import { config } from "../src/config.js";
const res = await fetch("https://api.minimax.io/v1/get_voice", {
  method: "POST",
  headers: { Authorization: `Bearer ${config.minimax.apiKey}`, "Content-Type": "application/json" },
  body: JSON.stringify({ voice_type: "system" }),
});
const json: any = await res.json();
if (json?.base_resp?.status_code !== 0) { console.error(json?.base_resp ?? json); process.exit(1); }
for (const v of json.system_voice ?? []) {
  if (/english/i.test(v.voice_id) || /english/i.test(v.voice_name ?? "")) console.log(`${v.voice_id}\t${v.voice_name}\t${(v.description ?? []).join(" ")}`);
}
