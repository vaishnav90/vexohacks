// Relay dashboard: task board, band lights, alerts and Relay's voice — all fed by the server's SSE stream.
// Text that came from speech is untrusted: always rendered with textContent, never innerHTML.
const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const time = (iso) => new Date(iso).toLocaleTimeString();
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---------------- Relay's voice ----------------
// The server already plays every line on the laptop speakers (afplay). Browser audio is optional, for another device.
const logEl = $("#log"), nowEl = $("#now"), errEl = $("#err");
let browserAudio = false;
const queue = [];
let playing = null;
let lastSpoken = "";
const audio = new Audio();

function showError(msg) { errEl.textContent = msg; errEl.hidden = !msg; }

function renderLine(line) {
  const li = el("li");
  li.id = "line-" + line.id;
  li.append(el("div", "text", line.text));
  const meta = el("div", "meta");
  meta.append(el("span", null, time(line.at)), el("span", "kind", line.kind),
    line.cached ? el("span", "cached", "cached · $0") : el("span", null, `${line.latencyMs} ms`));
  const replay = el("button", "replay", "▶");
  replay.title = "Play in browser";
  replay.onclick = () => enqueue(line, true);
  li.append(meta, replay);
  logEl.prepend(li);
}

function showNow(text, speaking) {
  nowEl.className = speaking ? "now speaking" : "now idle";
  nowEl.textContent = text || "Silent";
}

function enqueue(line, force = false) {
  if (!browserAudio && !force) return;
  queue.push(line);
  if (!playing) playNext();
}

function playNext() {
  document.querySelectorAll(".log li.playing").forEach((e) => e.classList.remove("playing"));
  const line = queue.shift();
  if (!line) { playing = null; showNow(lastSpoken, false); return; }
  playing = line;
  showNow(line.text, true);
  document.getElementById("line-" + line.id)?.classList.add("playing");
  audio.src = line.audioUrl;
  audio.play().catch((e) => { showError("Audio blocked: " + e.message); playNext(); });
}
audio.onended = playNext;
audio.onerror = () => { showError("Could not play audio for: " + (playing?.text ?? "")); playNext(); };

$("#earpiece").onclick = (e) => {
  browserAudio = !browserAudio;
  e.currentTarget.setAttribute("aria-pressed", String(browserAudio));
  e.currentTarget.textContent = browserAudio ? "🔊 Browser audio on" : "🔇 Browser audio off";
  if (!browserAudio) { queue.length = 0; audio.pause(); playNext(); }
};

function renderUsage(u) {
  const est = (u.usedChars / 1e6) * 60; // speech-2.8-turbo ~ $60 / 1M chars (estimate)
  $("#usage").textContent = `MiniMax · ${u.usedChars.toLocaleString()} / ${u.budgetChars.toLocaleString()} chars · ~$${est.toFixed(3)}`;
}

// ---------------- bands (LED mirror) ----------------
// Same colours as src/band.ts, so the screen shows what the physical band is doing.
const LED_MEANING = { "#ff8800": "task assigned", "#ff0000": "timer up", "#8800ff": "asked to repeat", "#ffffff": "task sent", "#00ffff": "result logged", "#00ff00": "accepted" };
const ledMeaning = (c) => LED_MEANING[(c || "").toLowerCase()] ?? c;
let bands = [];
const ledTimers = new Map();

function renderBands() {
  const box = $("#bands");
  box.replaceChildren();
  if (!bands.length) box.append(el("span", "hint", "No bands configured (BAND_CREW in .env)."));
  for (const b of bands) {
    const pill = el("div", "band");
    const led = el("span", "led");
    const state = el("span", "state", "idle");
    const l = b.led;
    const expired = l?.durationMs && Date.now() > new Date(l.at).getTime() + l.durationMs;
    if (l && l.pattern !== "off" && !expired) {
      led.classList.add("on");
      led.style.setProperty("--led", l.color);
      if (l.pattern === "blink") { led.classList.add("blink"); led.style.setProperty("--period", `${l.period ?? 500}ms`); }
      state.textContent = ledMeaning(l.color) + (l.pattern === "blink" ? " · blinking" : "");
    }
    const label = el("div");
    label.append(el("div", "name", b.name), el("div", "num", `band #${b.band}`));
    pill.append(led, label, state);
    box.append(pill);
    // Steady lights with a duration switch themselves off, like the band does.
    clearTimeout(ledTimers.get(b.crewId));
    if (l?.durationMs && !expired) ledTimers.set(b.crewId, setTimeout(renderBands, new Date(l.at).getTime() + l.durationMs - Date.now() + 50));
  }
}

function logBand(d) {
  const b = bands.find((x) => x.crewId === d.crewId);
  const li = el("li");
  const sw = el("span", "swatch");
  sw.style.background = d.color;
  li.append(sw, el("span", null, `${b?.name ?? d.crewId} · ${ledMeaning(d.color)}${d.pattern === "blink" ? " (blinking)" : ""}`), el("span", "t", time(new Date().toISOString())));
  $("#band-log").prepend(li);
}

function alertFor(a) {
  const d = el("div", "alert " + (a.kind === "timer" ? "timer" : "clarify"), (a.kind === "timer" ? "⏰ " : "? ") + a.text);
  $("#alerts").prepend(d);
  setTimeout(() => d.remove(), 15000);
}

// ---------------- task board ----------------
// Cards are keyed by id and reused, so a task that changes status slides to its new column (FLIP).
const taskCards = new Map(); // id -> { li, sig, task }
const STATUS_ORDER = ["pending", "accepted", "done"];
const KIND_WORD = { assigned: "assigned", sent: "sent", accepted: "accepted", completed: "done" };

function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
function ageText(t) {
  if (t.status === "done") return `done ${time(t.updatedAt)}`;
  return `${t.status === "pending" ? "waiting" : "working"} ${clock(Date.now() - new Date(t.updatedAt))}`;
}
function fillTaskCard(li, t) {
  li.replaceChildren();
  const top = el("div", "card-top");
  top.append(el("span", "who", t.assignee), el("span", "id", t.id), el("span", "age", ageText(t)));
  li.append(top, el("div", "desc", t.description));
  if (t.result) li.append(el("div", "result", t.result));
  const trail = el("div", "trail");
  for (const h of t.history) trail.append(el("span", null, `${KIND_WORD[h.kind] ?? h.kind} ${time(h.at)}${h.kind === "sent" && h.detail ? " " + h.detail : ""}`));
  li.append(trail);
}

/** Measure every card, update the DOM, then animate each card from where it was to where it is now. */
function flip(update) {
  const before = new Map();
  if (!reduceMotion) for (const [id, c] of taskCards) before.set(id, c.li.getBoundingClientRect());
  update();
  if (reduceMotion) return;
  for (const [id, c] of taskCards) {
    const a = before.get(id);
    if (!a || !c.li.isConnected) continue;
    const b = c.li.getBoundingClientRect();
    const dx = a.left - b.left, dy = a.top - b.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
    c.li.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: 560, easing: "cubic-bezier(.2,.8,.2,1)" });
  }
}

function renderTasks(tasks) {
  // Pending/accepted: longest-waiting first (most urgent on top). Done: newest first.
  const t0 = (x) => new Date(x.updatedAt).getTime();
  const ordered = [...tasks].sort((a, b) =>
    STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || (a.status === "done" ? t0(b) - t0(a) : t0(a) - t0(b)));
  flip(() => {
    const seen = new Set();
    for (const t of ordered) {
      seen.add(t.id);
      const sig = JSON.stringify([t.status, t.result, t.description, t.assignee, t.history.length]);
      let c = taskCards.get(t.id);
      if (!c) {
        c = { li: el("li", "card enter"), sig: "" };
        const li = c.li;
        li.addEventListener("animationend", () => li.classList.remove("enter", "flash"));
        taskCards.set(t.id, c);
      }
      if (c.sig !== sig) {
        fillTaskCard(c.li, t);
        if (c.sig) { c.li.classList.remove("flash"); void c.li.offsetWidth; c.li.classList.add("flash"); }
        c.sig = sig;
      }
      c.task = t;
      $("#col-" + t.status).append(c.li); // moves the node; keeps its identity
    }
    for (const [id, c] of taskCards) if (!seen.has(id)) { c.li.remove(); taskCards.delete(id); }
  });
  for (const s of STATUS_ORDER) $("#count-" + s).textContent = tasks.filter((t) => t.status === s).length;
}
setInterval(() => {
  for (const c of taskCards.values()) { const a = c.li.querySelector(".age"); if (a && c.task) a.textContent = ageText(c.task); }
}, 1000);

// ---------------- server events ----------------
const es = new EventSource("/api/events");
es.onopen = () => $("#conn").classList.add("live");
es.onerror = () => $("#conn").classList.remove("live");
es.addEventListener("snapshot", (e) => {
  const s = JSON.parse(e.data);
  logEl.replaceChildren();
  (s.voiceLog ?? []).forEach(renderLine);
  lastSpoken = s.voiceLog?.at(-1)?.text ?? "";
  if (!playing) showNow(lastSpoken, false);
  bands = s.bands ?? []; renderBands();
  renderTasks(s.tasks ?? []);
});
es.addEventListener("spoken", (e) => {
  const line = JSON.parse(e.data);
  showError(""); renderLine(line);
  lastSpoken = line.text;
  if (!playing) showNow(lastSpoken, false);
  enqueue(line);
});
es.addEventListener("board", (e) => renderTasks(JSON.parse(e.data).tasks));
es.addEventListener("bands", (e) => { bands = JSON.parse(e.data).bands; renderBands(); });
es.addEventListener("band_notify", (e) => logBand(JSON.parse(e.data)));
es.addEventListener("band_alert", (e) => alertFor(JSON.parse(e.data)));
es.addEventListener("usage", (e) => renderUsage(JSON.parse(e.data)));
es.addEventListener("voice_error", (e) => showError(JSON.parse(e.data).message));
fetch("/api/voice/usage").then((r) => r.json()).then(renderUsage).catch(() => {});

// ---------------- voice test ----------------
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
