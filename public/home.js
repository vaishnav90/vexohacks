// Home page: the "pick a step" demo. Static examples that mirror what the server actually does (src/band.ts).
const STEPS = {
  assign: {
    says: "Assign repeat blood pressure to Vaishnav.",
    action: "assigned · task “repeat blood pressure” → Vaishnav",
    band: { color: "#ff8800", blink: 500, label: "Orange blink: new task" },
    voice: "Repeat blood pressure assigned to Vaishnav.",
    board: "New card in Pending",
  },
  accept: {
    says: "(Vaishnav double-taps the band)",
    action: "tap · latest pending task accepted",
    band: { color: "#00ff00", label: "Green for 3 seconds" },
    voice: "Vaishnav accepted: repeat blood pressure.",
    board: "Card slides to Accepted",
  },
  report: {
    says: "Blood pressure 110 over 70.",
    action: "completed · result “110 over 70” linked to the task",
    band: { color: "#00ffff", label: "Cyan for 2 seconds" },
    voice: "Vaishnav reports 110 over 70. Repeat blood pressure complete.",
    board: "Card slides to Reported done, with the result",
  },
  send: {
    says: "Alex, start an IV in the left arm.",
    action: "taskSent · “start an IV in the left arm” → Alex",
    band: { color: "#ffffff", label: "White for 1 second" },
    voice: "Start an IV in the left arm assigned to Alex.",
    board: "New card for Alex in Pending",
  },
  timer: {
    says: "Vaishnav, two-minute timer is up.",
    action: "timerExpired · label “two-minute”",
    band: { color: "#ff0000", blink: 200, label: "Red fast blink" },
    voice: "Vaishnav, two-minute timer is up.",
    board: "Alert banner on the board",
  },
};

const flow = document.getElementById("flow");
const row = (term, build) => {
  const dt = document.createElement("dt");
  dt.textContent = term;
  const dd = document.createElement("dd");
  build(dd);
  flow.append(dt, dd);
};
const text = (t, cls) => (dd) => { dd.textContent = t; if (cls) dd.className = cls; };

function show(step) {
  const s = STEPS[step];
  flow.replaceChildren();
  row("Medic says", text(s.says, "said"));
  row("Relay decides", text(s.action, "mono"));
  row("Band", (dd) => {
    const lamp = document.createElement("span");
    lamp.className = "lamp" + (s.band.blink ? " blink" : "");
    lamp.style.setProperty("--led", s.band.color);
    if (s.band.blink) lamp.style.setProperty("--period", s.band.blink + "ms");
    dd.append(lamp, " " + s.band.label);
    dd.className = "band-row";
  });
  row("Relay says", text(`“${s.voice}”`, "voice"));
  row("Crew board", text(s.board));
  flow.classList.remove("swap"); void flow.offsetWidth; flow.classList.add("swap");
  document.querySelectorAll(".tab").forEach((t) => t.setAttribute("aria-selected", String(t.dataset.step === step)));
}
document.querySelectorAll(".tab").forEach((t) => (t.onclick = () => show(t.dataset.step)));
show("assign");
