// Listening: the Vexo band's microphone (double-tap the band to toggle) or, without the band, the
// computer's microphone (Listen button). Either way the audio streams to /api/listen; the server sends it
// to Deepgram (the key never reaches this page) and pushes transcripts / tasks back over SSE (app.js).
const $ = (s) => document.querySelector(s);
const statusEl = $("#listen-status"), errEl = $("#listen-err"), noticeEl = $("#mic-notice");
const bandBtn = $("#band-connect"), micBtn = $("#mic-toggle"), stopBtn = $("#listen-stop");

let BAND = null;        // the team's band number, from /api/config (one place: src/config.ts)
let lib = null;         // the Vexo kit's module, loaded on first band connect
let band = null;
let mic = null;         // { stream, ctx, node } while the computer mic is open
let ws = null;          // the current listening session's socket
let source = null;      // "band" | "mic" while listening
let busy = false;       // a toggle is in progress
let closing = null;     // resolves when the previous session's socket has closed (one session at a time)
let relaySpeaking = false; // app.js tells us; audio is not sent while Relay talks (no echo into the transcript)

const say = (t) => { statusEl.textContent = t; };
const showErr = (t) => { errEl.textContent = t || ""; errEl.hidden = !t; };
const bandName = () => `Vexo-HACK-${String(BAND).padStart(2, "0")}`;

function render() {
  const listening = Boolean(source);
  bandBtn.disabled = busy || Boolean(band?.connected) || source === "mic";
  micBtn.disabled = busy || Boolean(band?.connected);
  micBtn.textContent = source === "mic" ? "■ Stop mic" : "🎙 Listen with computer mic";
  micBtn.classList.toggle("danger", source === "mic");
  stopBtn.hidden = source !== "band"; // the band toggles by double-tap; this is the on-screen way out
  noticeEl.hidden = !listening; // required by the Vexo kit: say so the whole time audio leaves the laptop
  document.body.classList.toggle("listening", listening);
}

window.addEventListener("relay-speaking", (e) => { relaySpeaking = Boolean(e.detail); });

function sendAudio(bytes) {
  if (relaySpeaking) return;
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(bytes);
}

async function loadConfig() {
  const cfg = await (await fetch("/api/config")).json();
  BAND = cfg.band;
  const missing = [!cfg.deepgramKey && "DEEPGRAM_API_KEY", !cfg.openaiKey && "OPENAI_API_KEY", !cfg.minimaxKey && "MINIMAX_API_KEY"].filter(Boolean);
  if (missing.length) showErr(`Missing in .env: ${missing.join(", ")} (then restart the server).`);
  if (!cfg.kitAvailable) { bandBtn.disabled = true; bandBtn.title = "Run `npm run kit` on the server first"; }
  say(`Not listening. Connect ${bandName()} (double-tap it first), or use the computer mic.`);
}

// ---------------- the band ----------------
async function connectBand() {
  showErr("");
  busy = true; render();
  earpieceOn();
  try {
    lib ??= await import("/vexo/index.js");
    say(`Double-tap the band (it blinks blue), then pick ${bandName()} in the list…`);
    // Bluetooth starts only from a click: this runs inside the button handler.
    band = await lib.Band.connect(BAND, { autoReconnect: true });
    band.on("double-tap", () => { if (busy) return; source === "band" ? stopListening() : startListening("band"); });
    band.on("audio", (a) => { if (source === "band") sendAudio(a.opus); });
    band.on("reconnecting", () => say(`${band.name}: link lost, reconnecting…`));
    band.on("reconnected", () => say(`${band.name}: reconnected. ${source ? "Listening." : "Double-tap to listen."}`));
    band.on("disconnect", (e) => { // with autoReconnect this comes only when the link is gone for good
      if (source === "band") endSession();
      band = null;
      say(`Band disconnected (${e.reason}${e.reconnect ? ", " + e.reconnect : ""}).`);
      render();
    });
    await band.configure({ events: true });              // nothing arrives until configured
    await band.setLed("#00ff00", { brightness: 0.15 });  // dim green = connected, not listening
    say(`Connected to ${band.name}. Double-tap the band to start listening.`);
  } catch (e) {
    band = null;
    say("Band not connected.");
    showErr(e.message); // the kit's messages say what to do next
  } finally {
    busy = false; render();
  }
}

// ---------------- the computer mic ----------------
async function openMic() {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const ctx = new AudioContext({ sampleRate: 16000 }); // the browser resamples the mic to 16 kHz
  await ctx.audioWorklet.addModule("/pcm-worklet.js");
  const node = new AudioWorkletNode(ctx, "pcm-chunker", { processorOptions: { rate: ctx.sampleRate } });
  node.port.onmessage = (e) => { if (source === "mic") sendAudio(e.data); };
  ctx.createMediaStreamSource(stream).connect(node);
  if (ctx.sampleRate !== 16000) throw new Error(`This browser could not open the mic at 16 kHz (got ${ctx.sampleRate}). Use Chrome or Edge.`);
  mic = { stream, ctx, node };
}

function closeMic() {
  if (!mic) return;
  mic.stream.getTracks().forEach((t) => t.stop()); // the browser's mic indicator goes off
  mic.node.port.onmessage = null;
  mic.ctx.close().catch(() => {});
  mic = null;
}

// ---------------- a listening session (either source) ----------------
function openSocket(src) {
  return new Promise((resolve, reject) => {
    const s = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/listen?source=${src}`);
    s.binaryType = "arraybuffer";
    const t = setTimeout(() => { s.close(); reject(new Error("Could not reach the Relay server")); }, 5000);
    s.onopen = () => { clearTimeout(t); resolve(s); };
    s.onerror = () => { clearTimeout(t); reject(new Error("Could not reach the Relay server")); };
  });
}

async function startListening(src) {
  busy = true; showErr(""); render();
  earpieceOn();
  try {
    if (closing) { say("Finishing the previous transcript…"); await closing; }
    if (src === "mic") await openMic(); // asks for mic permission the first time
    const s = await openSocket(src);
    s.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === "error") showErr(m.message);
    };
    s.onclose = (ev) => {
      if (ws !== s) return;
      ws = null;
      if (ev.code === 4409) showErr("Another page is already listening. Stop it there first.");
      if (source) { const was = source; source = null; releaseAudio(was); say("Stopped listening."); render(); }
    };
    ws = s;
    source = src;
    if (src === "band") await band.configure({ audio: true }); // the band's light goes solid blue
    say(src === "band" ? `${band.name}: listening. Double-tap again to stop.` : "Listening with the computer mic. Speak normally.");
  } catch (e) {
    showErr(e.name === "NotAllowedError" ? "Microphone permission was denied. Allow it in the address bar, then try again." : e.message);
    endSession();
  } finally {
    busy = false; render();
  }
}

function releaseAudio(src) {
  if (src === "mic") closeMic();
  if (src === "band" && band?.connected) band.configure({ audio: false }).catch(() => {});
}

async function stopListening() {
  busy = true; render();
  const was = source;
  source = null; // stop forwarding at once
  releaseAudio(was);
  const old = ws;
  ws = null;
  if (old && old.readyState === WebSocket.OPEN) {
    // The server flushes the last words from Deepgram (up to ~3 s), then closes the socket.
    closing = new Promise((done) => {
      const t = setTimeout(() => { try { old.close(); } catch {} done(); }, 5000);
      old.addEventListener("close", () => { clearTimeout(t); done(); });
    }).finally(() => { closing = null; });
    old.send(JSON.stringify({ type: "stop" }));
  }
  say(was === "band" ? `${band?.name ?? "Band"}: stopped. Double-tap to listen.` : "Stopped listening.");
  busy = false; render();
}

function endSession() {
  const was = source;
  source = null;
  releaseAudio(was);
  closeMic();
  if (ws) { try { ws.close(); } catch {} ws = null; }
}

// Clicking Connect/Listen is the user gesture browsers need before Relay's voice can autoplay.
function earpieceOn() { window.dispatchEvent(new CustomEvent("relay-earpiece", { detail: true })); }

bandBtn.onclick = () => connectBand();
micBtn.onclick = () => { if (busy) return; source === "mic" ? stopListening() : startListening("mic"); };
stopBtn.onclick = () => { if (source && !busy) stopListening(); };
window.addEventListener("pagehide", () => { endSession(); band?.disconnect().catch(() => {}); });

if (location.protocol === "file:") say("Open this page from the Relay server (npm run dev), not as a file.");
else loadConfig().catch((e) => showErr("Could not load /api/config: " + e.message));
render();
