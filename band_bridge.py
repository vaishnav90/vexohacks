#!/usr/bin/env python3
"""
Relay band bridge — connects band #26 (Vaishnav) to the Express server.

Usage:
    python3 band_bridge.py          # real Bluetooth band
    python3 band_bridge.py --sim    # pretend band (development / testing)

Gesture flow:
  ASSIGN  — coordinator POSTs /notify (orange blink on band)
  SELECT  — wearer double-taps → server reads pending tasks aloud → mic turns on
            (band goes blue) → wearer speaks task name → double-taps again →
            AI matches → server confirms acceptance (green flash) → state = reporting
  REPORT  — wearer single-taps → mic turns on → speaks result → single-taps →
            mic off → result POSTed as "completed" with the accepted task ID

If there are no pending tasks, double-tap falls back to the legacy single-tap
acknowledgment (POST /tap with no taskId).

Prerequisites (real band):
    python3 -m pip install bleak
Environment variables needed for speech (in .env or shell):
    DEEPGRAM_API_KEY=...
    OPENAI_API_KEY=...
    OPENAI_MODEL=gpt-4o-mini
Run the Express server first, then start this bridge.
"""

import sys
import json
import threading
import time
import urllib.request
from pathlib import Path

# ── library paths ─────────────────────────────────────────────────────────────
_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(_ROOT / "vexo-open-kit" / "python"))
sys.path.insert(0, str(_ROOT / "vexo-open-kit" / "examples" / "python"))

from vexo_open.sync import Band

# Pre-load .env into os.environ so ai.py picks up OPENAI_MODEL at import time
import os as _os
try:
    with open(_ROOT / ".env") as _f:
        for _line in _f:
            _line = _line.strip()
            if "=" in _line and not _line.startswith("#"):
                _k, _, _v = _line.partition("=")
                _k = _k.strip()
                _v = _v.strip().strip("'\"")
                if _k and _k not in _os.environ:
                    _os.environ[_k] = _v
except OSError:
    pass

import speech
import ai

# ── constants ────────────────────────────────────────────────────────────────
BAND = 26
CREW_ID = "vaishnav"
SERVER_URL = "http://localhost:3000"
MAX_PENDING_ANNOUNCED = 5  # how many tasks to read aloud before truncating

# ── state machine ─────────────────────────────────────────────────────────────
# "idle"      → no active operation
# "selecting" → mic on, wearer speaking which task to accept; second double-tap confirms
# "reporting" → task accepted, single-tap toggles mic for result reporting
_state = "idle"
_pending_tasks: list = []        # [{id, description}, ...] — kept in sync via SSE
_accepted_task_id: str | None = None  # accepted task awaiting a result report

# ── tap event flags (set by band callbacks, consumed by main loop) ────────────
_mic_pending = False
_double_tap_pending = False

# ── mic / audio state ─────────────────────────────────────────────────────────
_mic_active = False
_ears = None
_queued_led = None          # LED command blocked while mic is on
_server_speaking = False    # True while afplay runs on the server

# ── LED helpers ───────────────────────────────────────────────────────────────
_led_version = [0]

def _apply_led(band: "Band", color: str, pattern: str, period, duration_ms) -> None:
    _led_version[0] += 1
    my_version = _led_version[0]
    try:
        if pattern == "off":
            band.led_off()
            return
        if pattern == "blink":
            band.set_led(color, brightness=1.0, pattern="blink", period=period)
        else:
            band.set_led(color, brightness=1.0)
    except Exception as e:
        print(f"[led] blocked (mic on) — queued for replay: {e}", file=sys.stderr)
        global _queued_led
        _queued_led = (band, color, pattern, period, duration_ms)
        return
    if duration_ms:
        def _turn_off():
            time.sleep(duration_ms / 1000)
            if _led_version[0] == my_version:
                try:
                    band.led_off()
                except Exception:
                    pass
        threading.Thread(target=_turn_off, daemon=True).start()


def _handle_band_notify(band: "Band", data: dict) -> None:
    if data.get("crewId") != CREW_ID:
        return
    _apply_led(
        band,
        color=data.get("color", "#ffffff"),
        pattern=data.get("pattern", "steady"),
        period=data.get("period"),
        duration_ms=data.get("durationMs"),
    )


# ── mic helpers ───────────────────────────────────────────────────────────────
def _start_mic(band: "Band") -> None:
    global _mic_active, _ears
    _mic_active = True
    print("[mic] on — listening (single-tap to stop)")
    _ears = speech.create().start(lambda text, final: print(f"[speech] {'heard' if final else '...'}: {text}") if text.strip() else None)
    band.on("audio", _ears.feed)
    band.configure(audio=True)


def _stop_mic(band: "Band") -> str:
    """Stop mic and return the full transcript. Does NOT dispatch anything."""
    global _mic_active, _ears, _queued_led
    _mic_active = False
    print("[mic] off — finalising transcript...")
    band.configure(audio=False)
    band.off("audio", _ears.feed)
    transcript = _ears.stop()
    _ears = None
    if _queued_led:
        cmd, _queued_led = _queued_led, None
        _apply_led(*cmd)
    return transcript


# ── intent / AI helpers ───────────────────────────────────────────────────────
_INTENT_TOOLS = [
    ai.tool("assigned",    "Assign a medical task to Vaishnav",                       task="string"),
    ai.tool("timerExpired","A timer for Vaishnav has gone off",                       label="string"),
    ai.tool("clarify",     "Ask Vaishnav to clarify something",                       what="string"),
    ai.tool("taskSent",    "Vaishnav is sending a task to another crew member",       task="string", person="string"),
    ai.tool("completed",   "Vaishnav is reporting the result of a completed task",    result="string"),
    ai.tool("none",        "Nothing here is a band command — ignore this transcript"),
]

_INTENT_INSTRUCTIONS = (
    "You are dispatching commands for an EMS wristband worn by Vaishnav. "
    "This is an emergency medical setting. Rules:\n"
    "- 'assigned': any request to perform a clinical task. "
    "  'repeat blood pressure', 'can you repeat the BP', 'check vitals', 'get an IV' all map to assigned. "
    "  'repeat X' means perform X again — it is NOT clarify. "
    "  Task field: short clean description only, e.g. 'repeat blood pressure'. "
    "  Strip 'hey Vaishnav', 'can you', 'please', 'assign', 'repeat' (when it means do-again) from the task.\n"
    "- 'clarify': only when YOU (the system) need Vaishnav to repeat or explain an ambiguous instruction.\n"
    "- 'timerExpired': a specific timer has gone off.\n"
    "- 'taskSent': Vaishnav is handing a task to someone else.\n"
    "- 'completed': Vaishnav is reporting a measurement or finding, e.g. 'blood pressure 120 over 80', 'pulse ox 98'. "
    "  Result field: the measurement or finding exactly as spoken.\n"
    "- 'none': purely ambient speech — greetings, thanks, filler. No clinical action present.\n"
    "When in doubt between assigned and none, pick assigned."
)


def _dispatch_transcript(text: str) -> None:
    """Classify text with OpenAI and POST the matching band command. No taskId."""
    if _server_speaking:
        print(f"[intent] suppressed (server speaking): {text!r}")
        return
    print(f"[intent] parsing: {text!r}")
    try:
        action, details = ai.choose(text, _INTENT_TOOLS, instructions=_INTENT_INSTRUCTIONS)
        if action == "none":
            print("[intent] no band action — ignoring")
            return
        print(f"[intent] dispatching: state={action} {details}")
        _post_notify(action, details)
    except Exception as e:
        print(f"[intent] error: {e}", file=sys.stderr)


def _dispatch_as_result(text: str, task_id: str | None) -> None:
    """POST the transcript directly as a 'completed' event with the given taskId."""
    result = text.strip()
    if not result:
        return
    print(f"[result] dispatching result={result!r} taskId={task_id}")
    payload: dict = {"state": "completed", "result": result}
    if task_id:
        payload["taskId"] = task_id
    _post_notify_raw(payload)


def _identify_task(text: str, pending: list) -> dict | None:
    """Use AI to match spoken text to one of the pending tasks. Returns task dict or None."""
    tools = [ai.tool(t["id"], f"The person is referring to: {t['description']}") for t in pending]
    tools.append(ai.tool("none", "No matching task — the speech does not refer to any pending task"))
    instructions = (
        "Match the spoken phrase to one of the pending tasks. "
        "Pick the task whose description best matches what was said. "
        "If nothing matches, return 'none'."
    )
    try:
        action, _ = ai.choose(text, tools, instructions=instructions)
        if action == "none":
            return None
        return next((t for t in pending if t["id"] == action), None)
    except Exception as e:
        print(f"[identify] error: {e}", file=sys.stderr)
        return None


# ── server communication ──────────────────────────────────────────────────────
def _post_notify(state: str, details: dict) -> None:
    _post_notify_raw({"state": state, **details})


def _post_notify_raw(payload: dict) -> None:
    body = json.dumps(payload).encode()
    req = urllib.request.Request(
        f"{SERVER_URL}/api/band/{CREW_ID}/notify",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10):
            pass
    except Exception as e:
        print(f"[notify] error: {e}", file=sys.stderr)


def _post_tap(task_id: str | None = None) -> None:
    payload: dict = {}
    if task_id:
        payload["taskId"] = task_id
    body = json.dumps(payload).encode()
    req = urllib.request.Request(
        f"{SERVER_URL}/api/band/{CREW_ID}/tap",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=5):
            pass
        print(f"[tap] acknowledgment posted (taskId={task_id})")
    except Exception as e:
        print(f"[tap] POST failed: {e}", file=sys.stderr)


def _speak_via_server(text: str) -> None:
    body = json.dumps({"text": text}).encode()
    req = urllib.request.Request(
        f"{SERVER_URL}/api/speak",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10):
            pass
    except Exception as e:
        print(f"[speak] error: {e}", file=sys.stderr)


def _wait_for_server_silent(timeout: float = 12.0) -> None:
    deadline = time.time() + timeout
    while _server_speaking and time.time() < deadline:
        time.sleep(0.05)


# ── state transition helpers ──────────────────────────────────────────────────
def _announce_and_start_mic(band: "Band", pending: list) -> None:
    """Speak pending tasks, wait for server to finish speaking, then open mic."""
    if len(pending) == 1:
        text = f"One pending task: {pending[0]['description']}. Speak to confirm, then double-tap."
    else:
        shown = pending[:MAX_PENDING_ANNOUNCED]
        task_list = "; ".join(f"{i + 1}: {t['description']}" for i, t in enumerate(shown))
        more = f" and {len(pending) - len(shown)} more" if len(pending) > len(shown) else ""
        text = f"{len(pending)} pending tasks{more}: {task_list}. Speak which one, then double-tap."
    _speak_via_server(text)
    time.sleep(0.3)
    _wait_for_server_silent(timeout=15)
    _start_mic(band)


def _identify_and_accept(band: "Band", transcript: str, pending: list) -> None:
    """Match transcript to a pending task, accept it via /tap, and move to reporting."""
    global _state, _accepted_task_id
    if len(pending) == 1:
        task = pending[0]
    else:
        task = _identify_task(transcript, pending)

    if task is None:
        names = ", ".join(t["description"] for t in pending[:3])
        suffix = " and more" if len(pending) > 3 else ""
        _speak_via_server(f"Could not identify task. Pending: {names}{suffix}. Double-tap to try again.")
        _state = "idle"
        print("[state] task not identified → idle")
        return

    print(f"[state] identified task {task['id']}: {task['description']!r}")
    _post_tap(task_id=task["id"])
    _accepted_task_id = task["id"]
    _state = "reporting"
    print(f"[state] → reporting (accepted {task['id']})")


# ── tap / double-tap action handlers (called from main loop) ─────────────────
def _handle_tap_action(band: "Band") -> None:
    global _state, _accepted_task_id, _mic_active

    if _state == "idle":
        if not _mic_active:
            _start_mic(band)
        else:
            transcript = _stop_mic(band)
            if transcript.strip():
                threading.Thread(target=_dispatch_transcript, args=(transcript,), daemon=True).start()

    elif _state == "selecting":
        # Cancel selection — stop mic if running and return to idle
        if _mic_active:
            _stop_mic(band)
        _state = "idle"
        print("[state] selection cancelled → idle")

    elif _state == "reporting":
        if not _mic_active:
            _start_mic(band)
        else:
            transcript = _stop_mic(band)
            task_id = _accepted_task_id
            _accepted_task_id = None
            _state = "idle"
            print("[state] result captured → idle")
            if transcript.strip():
                threading.Thread(target=_dispatch_as_result, args=(transcript, task_id), daemon=True).start()


def _handle_double_tap_action(band: "Band") -> None:
    global _state, _mic_pending

    _mic_pending = False  # a double-tap on hardware often fires two single-tap events first

    if _state == "idle":
        pending = list(_pending_tasks)
        if not pending:
            # No pending tasks — legacy acknowledgment
            threading.Thread(target=_post_tap, daemon=True).start()
            return
        _state = "selecting"
        print(f"[state] idle → selecting ({len(pending)} pending tasks)")
        threading.Thread(target=_announce_and_start_mic, args=(band, pending), daemon=True).start()

    elif _state == "selecting":
        # Second double-tap: stop mic and identify which task was spoken
        transcript = _stop_mic(band) if _mic_active else ""
        pending = list(_pending_tasks)
        if transcript.strip():
            print(f"[state] selection transcript: {transcript!r}")
            threading.Thread(target=_identify_and_accept, args=(band, transcript, pending), daemon=True).start()
        else:
            _state = "idle"
            print("[state] no speech heard → idle")

    elif _state == "reporting":
        # Treat double-tap like a new selection if there are still pending tasks
        pending = list(_pending_tasks)
        if pending:
            _state = "selecting"
            print(f"[state] reporting → selecting ({len(pending)} pending tasks)")
            threading.Thread(target=_announce_and_start_mic, args=(band, pending), daemon=True).start()


# ── SSE loop ──────────────────────────────────────────────────────────────────
def _sse_loop(band: "Band") -> None:
    global _server_speaking, _pending_tasks
    url = f"{SERVER_URL}/api/events"
    while True:
        _server_speaking = False
        try:
            req = urllib.request.Request(url)
            with urllib.request.urlopen(req, timeout=None) as response:
                print("[sse] connected to server event stream")
                event_name = ""
                while True:
                    raw = response.readline()
                    if not raw:
                        break
                    line = raw.decode("utf-8").rstrip("\r\n")
                    if line.startswith("event:"):
                        event_name = line[6:].strip()
                    elif line.startswith("data:"):
                        data_str = line[5:].strip()
                        try:
                            data = json.loads(data_str)
                        except Exception:
                            event_name = ""
                            continue
                        if event_name == "band_notify":
                            _handle_band_notify(band, data)
                        elif event_name in ("board", "snapshot"):
                            # Keep pending_tasks in sync with the server's task ledger
                            tasks = data.get("tasks", [])
                            _pending_tasks = [
                                {"id": t["id"], "description": t["description"]}
                                for t in tasks
                                if t.get("status") == "pending" and t.get("crewId") == CREW_ID
                            ]
                        elif event_name == "speaking_start":
                            _server_speaking = True
                            print("[mic] server speaking — dispatch suppressed")
                        elif event_name == "speaking_end":
                            _server_speaking = False
                            print("[mic] server done speaking")
                        event_name = ""
                    elif line == "" or line.startswith(":"):
                        event_name = ""
        except Exception as e:
            print(f"[sse] disconnected: {e}", file=sys.stderr)
        print("[sse] reconnecting in 3 s...")
        time.sleep(3)


# ── tap event setters (called on band callback thread) ───────────────────────
def _set_mic_pending():
    global _mic_pending
    _mic_pending = True


def _set_double_tap_pending():
    global _double_tap_pending
    _double_tap_pending = True


# ── main ──────────────────────────────────────────────────────────────────────
def main() -> None:
    global _mic_pending, _double_tap_pending

    use_sim = "--sim" in sys.argv
    print(f"Connecting to band {BAND} ({'simulator' if use_sim else 'Bluetooth'})...")
    print("Double-tap the band first if using Bluetooth (makes it discoverable for 60 s).")

    if use_sim:
        band = Band.connect(BAND, transport="sim", auto_reconnect=True)
    else:
        band = Band.connect(BAND, auto_reconnect=True)
    print(f"Connected to {band.name}")

    band.on("double-tap", lambda _e: _set_double_tap_pending())
    band.on("tap", lambda _e: _set_mic_pending())
    band.configure(events=True)

    threading.Thread(target=_sse_loop, args=(band,), daemon=True).start()

    print(f"\nBridge running.")
    print(f"  Band #{BAND} double-tap        → select pending task (speak name, double-tap to confirm)")
    print(f"  Band #{BAND} single-tap        → toggle mic (result reporting or general dispatch)")
    print(f"  Server band_notify SSE        → LED on band #{BAND}")
    print(f"  State: idle → selecting → reporting → idle")
    print("Press Ctrl+C to stop.\n")

    try:
        while True:
            band.wait(0.1)
            if _double_tap_pending:
                _double_tap_pending = False
                _handle_double_tap_action(band)
            elif _mic_pending:
                _mic_pending = False
                _handle_tap_action(band)
    except KeyboardInterrupt:
        if _mic_active:
            _stop_mic(band)
        print("\nStopping bridge...")
        band.disconnect()


if __name__ == "__main__":
    main()
