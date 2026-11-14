// Relay dashboard: receives spoken lines over SSE and plays them sequentially (no overlap).
const $ = (s) => document.querySelector(s);
const logEl = $("#log"), nowEl = $("#now"), errEl = $("#err");
let earpieceOn = false;
const queue = [];
let playing = null;
const audio = new Audio();

function showError(msg) { errEl.textContent = msg; errEl.hidden = !msg; }

function renderLine(line) {
  const li = document.createElement("li");
  li.id = "line-" + line.id;
  const t = new Date(line.at).toLocaleTimeString();
  li.innerHTML = `<div class="text"></div>
    <div class="meta"><span>${t}</span><span class="kind"></span>
    ${line.cached ? '<span class="cached">cached · $0</span>' : `<span>${line.latencyMs} ms</span>`}</div>
    <button class="replay" title="Replay">▶</button>`;
  li.querySelector(".text").textContent = line.text;
  li.querySelector(".kind").textContent = line.kind;
  li.querySelector(".replay").onclick = () => enqueue(line, true);
  logEl.prepend(li); // column-reverse => newest at bottom
}

function enqueue(line, force = false) {
  if (!earpieceOn && !force) return;
  queue.push(line);
  if (!playing) playNext();
}

function playNext() {
  document.querySelectorAll(".log li.playing").forEach((el) => el.classList.remove("playing"));
  const line = queue.shift();
  if (!line) { playing = null; nowEl.className = "now idle"; nowEl.textContent = "Silent"; return; }
  playing = line;
  nowEl.className = "now speaking";
  nowEl.textContent = line.text;
  document.getElementById("line-" + line.id)?.classList.add("playing");
  audio.src = line.audioUrl;
  audio.play().catch((e) => { showError("Audio blocked: " + e.message + " — click 'Earpiece' to enable."); playNext(); });
}
audio.onended = playNext;
audio.onerror = () => { showError("Could not play audio for: " + (playing?.text ?? "")); playNext(); };

$("#earpiece").onclick = (e) => {
  earpieceOn = !earpieceOn;
  e.currentTarget.setAttribute("aria-pressed", String(earpieceOn));
  e.currentTarget.textContent = earpieceOn ? "🔊 Earpiece on" : "🔇 Earpiece off";
  // The click itself is the user gesture browsers require before audio can autoplay.
  if (!earpieceOn) { queue.length = 0; audio.pause(); playNext(); }
};

function renderUsage(u) {
  const est = (u.usedChars / 1e6) * 60; // speech-2.8-turbo ~ $60 / 1M chars (estimate)
  $("#usage").textContent = `MiniMax ${u.model} · ${u.usedChars.toLocaleString()} / ${u.budgetChars.toLocaleString()} chars · ~$${est.toFixed(3)}`;
}

const es = new EventSource("/api/events");
es.onopen = () => $("#conn").classList.add("live");
es.onerror = () => $("#conn").classList.remove("live");
es.addEventListener("snapshot", (e) => { logEl.innerHTML = ""; JSON.parse(e.data).voiceLog.forEach(renderLine); });
es.addEventListener("spoken", (e) => { const line = JSON.parse(e.data); showError(""); renderLine(line); enqueue(line); });
es.addEventListener("usage", (e) => renderUsage(JSON.parse(e.data)));
es.addEventListener("voice_error", (e) => showError(JSON.parse(e.data).message));
fetch("/api/voice/usage").then((r) => r.json()).then(renderUsage);

async function post(url, body) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) showError((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
}
document.querySelectorAll(".samples button").forEach((b) => {
  b.onclick = async () => { b.disabled = true; try { await post("/api/voice/sample/" + b.dataset.kind); } finally { b.disabled = false; } };
});
$("#custom").onsubmit = async (e) => {
  e.preventDefault();
  const text = $("#text").value.trim();
  if (!text) return;
  await post("/api/speak", { text });
  $("#text").value = "";
};
