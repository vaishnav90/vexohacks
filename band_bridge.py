#!/usr/bin/env python3
"""
Relay band bridge — connects band #26 (Vaishnav) to the Express server.

Usage:
    python3 band_bridge.py          # real Bluetooth band
    python3 band_bridge.py --sim    # pretend band (development / testing)

The bridge does four things:
  1. Subscribes to the Express server's SSE stream (/api/events).
  2. On every "band_notify" event addressed to Vaishnav: sets the LED.
  3. On every double-tap: POSTs /api/band/vaishnav/tap so the server can
     record the acknowledgment, play the MiniMax confirmation, and send back
     the green-LED command over SSE.
  4. On every single-tap: toggles the microphone.
       First tap  → mic on (band goes solid blue), Deepgram listens.
       Second tap → mic off, transcript parsed by OpenAI, command dispatched
                    to /api/band/vaishnav/notify if a band action is found.

Prerequisites (real band):
    python3 -m pip install bleak
Environment variables needed for speech (in .env or shell):
    DEEPGRAM_API_KEY=...
    OPENAI_API_KEY=...
    OPENAI_MODEL=gpt-4o-mini   (the kit default "gpt-6-luna" is fictional)
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
# (ai.py reads MODEL from os.environ when the module loads, not from .env itself)
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
BAND = 26          # Vaishnav's band number — never change this to 42
CREW_ID = "vaishnav"
SERVER_URL = "http://localhost:3000"

# ── LED helpers ──────────────────────────────────────────────────────────────
_led_version = [0]  # single-element list so threads can mutate it via closure

def _apply_led(band: "Band", color: str, pattern: str, period, duration_ms) -> None:
    """
    Set the LED and schedule auto-off when duration_ms is given.
    Silently ignores errors from the microphone lock (blue-LED rule).
    """
    _led_version[0] += 1
    my_version = _led_version[0]

    try:
        if pattern == "off":
            band.led_off()
            return
        if pattern == "blink":
            band.set_led(color, brightness=1.0, pattern="blink", period=period)
        else:  # steady
            band.set_led(color, brightness=1.0)
    except Exception as e:
        # The band refuses LED commands while the microphone is on (blue-light rule).
        # Queue the command so it replays the moment the mic turns off.
        print(f"[led] blocked (mic on) — queued for replay: {e}", file=sys.stderr)
        global _queued_led
        _queued_led = (band, color, pattern, period, duration_ms)
        return

    if duration_ms:
        def _turn_off():
            time.sleep(duration_ms / 1000)
            if _led_version[0] == my_version:  # a newer command superseded us
                try:
                    band.led_off()
                except Exception:
                    pass
        threading.Thread(target=_turn_off, daemon=True).start()


def _handle_band_notify(band: "Band", data: dict) -> None:
    """Dispatch a band_notify SSE event to the LED if it is addressed to us."""
    if data.get("crewId") != CREW_ID:
        return
    _apply_led(
        band,
        color=data.get("color", "#ffffff"),
        pattern=data.get("pattern", "steady"),
        period=data.get("period"),
        duration_ms=data.get("durationMs"),
    )


# ── speech / intent helpers ───────────────────────────────────────────────────
_mic_active = False
_mic_pending = False   # set by single-tap handler; consumed by main loop
_ears = None           # active DeepgramSpeech session
_queued_led = None     # LED command blocked by mic-on rule; replayed when mic turns off

# Tools the AI chooses among when interpreting a transcript.
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
    """Parse intent from a transcript and POST the matching band command to the server."""
    try:
        action, details = ai.choose(text, _INTENT_TOOLS, instructions=_INTENT_INSTRUCTIONS)
        if action == "none":
            print("[intent] no band action — ignoring")
            return
        print(f"[intent] dispatching: state={action} {details}")
        body = json.dumps({"state": action, **details}).encode()
        req = urllib.request.Request(
            f"{SERVER_URL}/api/band/{CREW_ID}/notify",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=10):
            pass
    except Exception as e:
        print(f"[intent] error: {e}", file=sys.stderr)


def _on_transcript(text: str, final: bool) -> None:
    """Called by Deepgram on each partial (final=False) or settled (final=True) transcript."""
    if not final:
        return
    text = text.strip()
    if not text:
        return
    print(f"[speech] heard: {text}")
    threading.Thread(target=_dispatch_transcript, args=(text,), daemon=True).start()


def _start_mic(band: "Band") -> None:
    """Turn the band microphone on and start streaming to Deepgram."""
    global _mic_active, _ears
    _mic_active = True
    print("[mic] on — speak your command (single-tap to stop)")
    _ears = speech.create().start(_on_transcript)
    band.on("audio", _ears.feed)
    band.configure(audio=True)   # LED goes solid blue; LED commands blocked until mic off


def _stop_mic(band: "Band") -> None:
    """Turn the band microphone off, flush remaining transcript, replay any queued LED."""
    global _mic_active, _ears, _queued_led
    _mic_active = False
    print("[mic] off — processing last words...")
    band.configure(audio=False)
    band.off("audio", _ears.feed)
    _ears.stop()
    _ears = None
    # Replay any LED command that was blocked while the mic was on
    if _queued_led:
        cmd, _queued_led = _queued_led, None
        _apply_led(*cmd)


# ── server communication ─────────────────────────────────────────────────────
def _post_tap() -> None:
    """
    POST the double-tap acknowledgment to the Express server.
    Runs in its own daemon thread so the band's event handler returns quickly.
    """
    url = f"{SERVER_URL}/api/band/{CREW_ID}/tap"
    body = json.dumps({}).encode()
    req = urllib.request.Request(
        url, data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=5):
            pass
        print("[tap] acknowledgment posted to server")
    except Exception as e:
        print(f"[tap] POST failed: {e}", file=sys.stderr)


def _sse_loop(band: "Band") -> None:
    """
    Background thread: maintains a persistent SSE connection to the Express
    server and drives the LED whenever a band_notify event arrives.
    Reconnects automatically on failure.
    """
    url = f"{SERVER_URL}/api/events"
    while True:
        try:
            req = urllib.request.Request(url)
            with urllib.request.urlopen(req, timeout=None) as response:
                print("[sse] connected to server event stream")
                event_name = ""
                while True:
                    raw = response.readline()
                    if not raw:
                        break  # server closed the connection
                    line = raw.decode("utf-8").rstrip("\r\n")
                    if line.startswith("event:"):
                        event_name = line[6:].strip()
                    elif line.startswith("data:"):
                        data_str = line[5:].strip()
                        if event_name == "band_notify":
                            try:
                                _handle_band_notify(band, json.loads(data_str))
                            except Exception as e:
                                print(f"[sse] parse error: {e}", file=sys.stderr)
                        event_name = ""
                    elif line == "" or line.startswith(":"):
                        event_name = ""  # blank line or ping — reset for next event
        except Exception as e:
            print(f"[sse] disconnected: {e}", file=sys.stderr)
        print("[sse] reconnecting in 3 s...")
        time.sleep(3)


# ── main ─────────────────────────────────────────────────────────────────────
def main() -> None:
    global _mic_pending

    use_sim = "--sim" in sys.argv

    print(f"Connecting to band {BAND} ({'simulator' if use_sim else 'Bluetooth'})...")
    print("Double-tap the band first if using Bluetooth (makes it discoverable for 60 s).")

    if use_sim:
        band = Band.connect(BAND, transport="sim", auto_reconnect=True)
    else:
        band = Band.connect(BAND, auto_reconnect=True)
    print(f"Connected to {band.name}")

    band.on("double-tap", lambda _e: _handle_double_tap(band))
    band.on("tap", lambda _e: _set_mic_pending())
    band.configure(events=True)

    sse_thread = threading.Thread(target=_sse_loop, args=(band,), daemon=True)
    sse_thread.start()

    print(f"\nBridge running.")
    print(f"  Band #{BAND} single-tap   →  toggle mic (Deepgram + OpenAI intent)")
    print(f"  Band #{BAND} double-tap   →  POST {SERVER_URL}/api/band/{CREW_ID}/tap")
    print(f"  Server band_notify SSE   →  LED on band #{BAND}")
    print("Press Ctrl+C to stop.\n")

    try:
        while True:
            band.wait(0.1)
            if _mic_pending:
                _mic_pending = False
                if not _mic_active:
                    _start_mic(band)
                else:
                    _stop_mic(band)
    except KeyboardInterrupt:
        if _mic_active:
            _stop_mic(band)
        print("\nStopping bridge...")
        band.disconnect()


def _set_mic_pending():
    global _mic_pending
    _mic_pending = True


def _handle_double_tap(band: "Band"):
    global _mic_pending
    # Clear pending mic toggle and stop active mic session before posting the tap.
    # A double-tap on a real band may fire two "tap" events first; without this guard
    # those would turn the mic on and block the green-LED acceptance response.
    _mic_pending = False
    if _mic_active:
        _stop_mic(band)
    threading.Thread(target=_post_tap, daemon=True).start()


if __name__ == "__main__":
    main()
