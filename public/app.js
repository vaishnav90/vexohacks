// Relay dashboard: transcript, task board, timers and Relay's voice, all fed by the server's SSE stream.
// Everything that came from speech is untrusted text: rendered with textContent, never innerHTML.
const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const time = (iso) => new Date(iso).toLocaleTimeString();

// ---------------- Relay's voice (earpiece) ----------------
const logEl = $("#log"), nowEl = $("#now"), errEl = $("#err");
let earpieceOn = false;
const queue = [];
let playing = null;
const audio = new Audio();

function showError(msg) { errEl.textContent = msg; errEl.hidden = !msg; }
function speaking(on) { window.dispatchEvent(new CustomEvent("relay-speaking", { detail: on })); } // listen.js pauses the mic

function renderLine(line) {
  const li = el("li");
  li.id = "line-" + line.id;
  li.append(el("div", "text", line.text));
  const meta = el("div", "meta");
  meta.append(el("span", null, time(line.at)), el("span", "kind", line.kind),
    line.cached ? el("span", "cached", "cached · $0") : el("span", null, `${line.latencyMs} ms`));
  const replay = el("button", "replay", "▶");
  replay.title = "Replay";
  replay.onclick = () => enqueue(line, true);
  li.append(meta, replay);
  logEl.prepend(li); // column-reverse => newest at bottom
}

function enqueue(line, force = false) {
  if (!earpieceOn && !force) return;
  queue.push(line);
  if (!playing) playNext();
}

function playNext() {
  document.querySelectorAll(".log li.playing").forEach((e) => e.classList.remove("playing"));
  const line = queue.shift();
  if (!line) { playing = null; speaking(false); nowEl.className = "now idle"; nowEl.textContent = "Silent"; return; }
  playing = line;
  speaking(true);
  nowEl.className = "now speaking";
  nowEl.textContent = line.text;
  document.getElementById("line-" + line.id)?.classList.add("playing");
  audio.src = line.audioUrl;
  audio.play().catch((e) => { showError("Audio blocked: " + e.message + " — click 'Earpiece' to enable."); playNext(); });
}
audio.onended = () => setTimeout(playNext, 250); // a short tail so the mic does not catch the end of Relay's voice
audio.onerror = () => { showError("Could not play audio for: " + (playing?.text ?? "")); playNext(); };

function setEarpiece(on) {
  earpieceOn = on;
  const b = $("#earpiece");
  b.setAttribute("aria-pressed", String(on));
  b.textContent = on ? "🔊 Earpiece on" : "🔇 Earpiece off";
  if (!on) { queue.length = 0; audio.pause(); playNext(); }
}
// The click itself is the user gesture browsers require before audio can autoplay.
$("#earpiece").onclick = () => setEarpiece(!earpieceOn);
window.addEventListener("relay-earpiece", (e) => { if (e.detail && !earpieceOn) setEarpiece(true); });

function renderUsage(u) {
  const est = (u.usedChars / 1e6) * 60; // speech-2.8-turbo ~ $60 / 1M chars (estimate)
  $("#usage").textContent = `MiniMax ${u.model} · ${u.usedChars.toLocaleString()} / ${u.budgetChars.toLocaleString()} chars · ~$${est.toFixed(3)}`;
}

// ---------------- transcript ----------------
const transcriptEl = $("#transcript"), interimEl = $("#interim");
const utterEls = new Map();

// ---------------- crew roster and voices ----------------
let crew = [], voices = [null, null];
function speakerClass(name) {
  if (name === "Voice 1" || (name && name === voices[0])) return "p1";
  if (name === "Voice 2" || (name && name === voices[1])) return "p2";
  return "pu";
}
const crewErr = (msg) => { const x = $("#crew-err"); x.textContent = msg || ""; x.hidden = !msg; };
async function postJson(url, body) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
  return d;
}
function renderCrew() {
  const box = $("#crew");
  box.replaceChildren();
  if (!crew.length) box.append(el("span", "hint", "No crew yet — add the names you will say (\"Ask Mark to…\")."));
  for (const name of crew) {
    const chip = el("span", "chip " + speakerClass(name), name);
    const x = el("button", "x", "×");
    x.title = `Remove ${name}`;
    x.onclick = () => postJson("/api/crew", { crew: crew.filter((n) => n !== name) }).then(() => crewErr("")).catch((e) => crewErr(e.message));
    chip.append(x);
    box.append(chip);
  }
  document.querySelectorAll("select[data-voice]").forEach((sel) => {
    const i = Number(sel.dataset.voice);
    sel.replaceChildren(new Option("— not set —", ""), ...crew.map((n) => new Option(n, n)));
    sel.value = voices[i] ?? "";
  });
}
$("#crew-add").onsubmit = async (e) => {
  e.preventDefault();
  const name = $("#crew-name").value.trim();
  if (!name) return;
  try {
    await postJson("/api/crew", { crew: [...crew, name] });
    $("#crew-name").value = "";
    crewErr(listeningNow ? "Name added. Deepgram will be primed with it from the next time you start listening." : "");
  } catch (err) { crewErr(err.message); }
};
document.querySelectorAll("select[data-voice]").forEach((sel) => {
  sel.onchange = () => postJson("/api/voices", { index: Number(sel.dataset.voice), name: sel.value || null }).then(() => crewErr("")).catch((e) => crewErr(e.message));
});
let listeningNow = false;

function renderUtterance(u) {
  const li = el("li");
  li.append(el("span", "t", time(u.at)), el("span", "who " + speakerClass(u.speaker), u.speaker === "unknown" ? "?" : u.speaker));
  li.title = "Voice labels on very short phrases can be wrong.";
  li.append(el("span", "said", u.text));
  const decision = el("div", "decision", "…");
  li.append(decision);
  utterEls.set(u.id, decision);
  transcriptEl.prepend(li);
}

function renderDecision(d) {
  const target = utterEls.get(d.utterance);
  if (!target) return;
  const a = d.action;
  const label = {
    assign_task: `→ task for ${a.person}: ${a.task}`, accept_task: "→ accepted", complete_task: `→ reported done${a.result ? ": " + a.result : ""}`,
    start_timer: `→ ${a.seconds}s timer for ${a.person}`, correct_result: `→ correction: ${a.result}`, handoff: "→ handoff",
    log_finding: `→ logged: ${a.result}`,
    unclear: "→ asked to repeat", none: "",
  }[a.action];
  target.textContent = d.outcome?.startsWith("asked") ? `→ ${d.outcome}` : label ?? "";
  target.classList.toggle("none", a.action === "none");
}

// ---------------- tasks, timers, alerts ----------------
let timers = [];
function renderFindings(findings) {
  const col = $("#col-findings");
  col.replaceChildren();
  for (const f of findings) {
    const li = el("li", "card");
    const top = el("div", "card-top");
    top.append(el("span", "id", f.id), el("span", "t", time(f.at)));
    li.append(top, el("div", "result", f.finding));
    for (const h of f.history.filter((x) => x.kind === "corrected")) li.append(el("div", "was", `was ${h.from} (corrected ${time(h.at)})`));
    const src = el("details", "src");
    src.append(el("summary", null, "source"));
    for (const h of f.history) src.append(el("div", null, `${time(h.at)} ${h.kind} — ${h.by}: “${h.said}”`));
    li.append(src);
    col.append(li);
  }
}
function renderTasks(tasks) {
  for (const s of ["pending", "accepted", "done"]) $("#col-" + s).replaceChildren();
  for (const t of tasks) {
    const li = el("li", "card");
    const top = el("div", "card-top");
    top.append(el("span", "id", t.id), el("span", "who " + speakerClass(t.assignee), t.assignee));
    li.append(top, el("div", "desc", t.description));
    if (t.result) li.append(el("div", "result", t.result));
    for (const h of t.history.filter((x) => x.kind === "corrected")) li.append(el("div", "was", `was ${h.from} (corrected ${time(h.at)})`));
    const src = el("details", "src");
    src.append(el("summary", null, "source"));
    for (const h of t.history) src.append(el("div", null, `${time(h.at)} ${h.kind} — ${h.by}: “${h.said}”`));
    li.append(src);
    $("#col-" + t.status).append(li);
  }
}

function renderTimers() {
  const box = $("#timers");
  box.replaceChildren();
  for (const t of timers) {
    const left = Math.max(0, Math.round((new Date(t.endsAt) - Date.now()) / 1000));
    const d = el("div", "timer " + t.state, t.state === "expired" ? `⏰ ${t.person}: ${t.seconds}s timer is up` : `⏱ ${t.person}: ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`);
    box.append(d);
  }
}
setInterval(renderTimers, 1000);

function alertFor(a) {
  const d = el("div", "alert " + speakerClass(a.person), `⏰ ${a.person}: timer is up`);
  $("#alerts").prepend(d);
  setTimeout(() => d.remove(), 15000);
}

// ---------------- server events ----------------
const es = new EventSource("/api/events");
es.onopen = () => $("#conn").classList.add("live");
es.onerror = () => $("#conn").classList.remove("live");
es.addEventListener("snapshot", (e) => {
  const s = JSON.parse(e.data);
  logEl.replaceChildren(); s.voiceLog.forEach(renderLine);
  crew = s.crew; voices = s.voices; renderCrew();
  transcriptEl.replaceChildren(); utterEls.clear(); s.utterances.forEach(renderUtterance);
  renderTasks(s.tasks); renderFindings(s.findings); timers = s.timers; renderTimers();
  listeningNow = Boolean(s.listening?.on);
});
es.addEventListener("crew", (e) => { const d = JSON.parse(e.data); crew = d.crew; voices = d.voices; renderCrew(); });
es.addEventListener("transcript", (e) => {
  const t = JSON.parse(e.data);
  interimEl.textContent = t.isFinal ? "" : `${t.speakerName === "unknown" ? "" : t.speakerName + ": "}${t.text}`;
});
es.addEventListener("utterance", (e) => { interimEl.textContent = ""; renderUtterance(JSON.parse(e.data)); });
es.addEventListener("action", (e) => renderDecision(JSON.parse(e.data)));
es.addEventListener("tasks", (e) => { const d = JSON.parse(e.data); renderTasks(d.tasks); renderFindings(d.findings); timers = d.timers; renderTimers(); });
es.addEventListener("alert", (e) => alertFor(JSON.parse(e.data)));
es.addEventListener("listening", (e) => { const d = JSON.parse(e.data); listeningNow = d.on; if (!d.on) interimEl.textContent = ""; });
es.addEventListener("spoken", (e) => { const line = JSON.parse(e.data); showError(""); renderLine(line); enqueue(line); });
es.addEventListener("usage", (e) => renderUsage(JSON.parse(e.data)));
es.addEventListener("voice_error", (e) => showError(JSON.parse(e.data).message));
const listenErr = (msg) => { const x = $("#listen-err"); x.textContent = msg; x.hidden = false; };
es.addEventListener("stt_error", (e) => listenErr(JSON.parse(e.data).message));
es.addEventListener("task_error", (e) => listenErr(JSON.parse(e.data).message));
fetch("/api/voice/usage").then((r) => r.json()).then(renderUsage);
$("#handoff").onclick = async (ev) => {
  const btn = ev.currentTarget; // currentTarget is null after an await
  setEarpiece(true);
  btn.disabled = true;
  try {
    const r = await fetch("/api/handoff", { method: "POST" });
    if (!r.ok) showError((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
  } finally { btn.disabled = false; }
};
