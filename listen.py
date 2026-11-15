#!/usr/bin/env python3
"""
Relay coordinator listener — laptop mic push-to-talk that dispatches band commands.

The coordinator speaks naturally ("assign repeat blood pressure to Vaishnav") and the
transcript is parsed by OpenAI into a band command, then POSTed to the Express server.

Usage:
    python3 listen.py                      # real laptop mic (requires sounddevice)
    python3 listen.py --say "assign BP check to Vaishnav"   # bypass mic for testing

Prerequisites:
    python3 -m pip install sounddevice     # for real mic (macOS: brew install portaudio first)
Environment variables (in .env or shell):
    DEEPGRAM_API_KEY=...
    OPENAI_API_KEY=...
    OPENAI_MODEL=gpt-4o-mini
Run the Express server first.
"""

import sys
import json
import threading
import urllib.request
from pathlib import Path

# ── library paths ─────────────────────────────────────────────────────────────
_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(_ROOT / "vexo-open-kit" / "python"))
sys.path.insert(0, str(_ROOT / "vexo-open-kit" / "examples" / "python"))

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
SERVER_URL = "http://localhost:3000"
CREW_ID = "vaishnav"          # only crew member with a band right now
SAMPLE_RATE = 16000           # Deepgram expects 16 kHz mono

# ── speaking suppression ─────────────────────────────────────────────────────
_server_speaking = False  # True while afplay is running on the server


def _speaking_guard_loop() -> None:
    """Background thread: watches SSE speaking_start/end to suppress mic feedback."""
    global _server_speaking
    import time as _time
    while True:
        _server_speaking = False
        try:
            req = urllib.request.Request(f"{SERVER_URL}/api/events")
            with urllib.request.urlopen(req, timeout=None) as resp:
                event_name = ""
                while True:
                    raw = resp.readline()
                    if not raw:
                        break
                    line = raw.decode("utf-8").rstrip("\r\n")
                    if line.startswith("event:"):
                        event_name = line[6:].strip()
                    elif line.startswith("data:"):
                        if event_name == "speaking_start":
                            _server_speaking = True
                        elif event_name == "speaking_end":
                            _server_speaking = False
                        event_name = ""
                    elif line == "" or line.startswith(":"):
                        event_name = ""
        except Exception:
            pass
        _time.sleep(3)

# ── intent tools (same set as band_bridge.py) ────────────────────────────────
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


def _dispatch(text: str) -> None:
    """Parse intent from text and POST the matching band command to the server."""
    text = text.strip()
    if not text:
        return
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
        body = json.dumps({"state": action, **details}).encode()
        req = urllib.request.Request(
            f"{SERVER_URL}/api/band/{CREW_ID}/notify",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=10):
            pass
        print("[intent] dispatched successfully")
    except Exception as e:
        print(f"[intent] error: {e}", file=sys.stderr)


def _run_say_mode(text: str) -> None:
    """Bypass mic — dispatch a literal phrase directly (for testing)."""
    print(f"[say] using: {text!r}")
    _dispatch(text)


def _run_mic_mode() -> None:
    """Push-to-talk: Enter to start recording, Enter to stop."""
    try:
        import sounddevice as sd
    except ImportError:
        print(
            "sounddevice is not installed. Install it with:\n"
            "  python3 -m pip install sounddevice\n"
            "On macOS, install portaudio first:  brew install portaudio\n"
            "\nAlternatively, test without a mic:\n"
            '  python3 listen.py --say "assign repeat blood pressure to Vaishnav"',
            file=sys.stderr,
        )
        sys.exit(1)

    def _run_session() -> None:
        # Only print partials for feedback; dispatch once at the end with the
        # full transcript so Deepgram's mid-sentence utterance splits don't
        # create multiple tasks from a single spoken command.
        def _on_transcript(text: str, final: bool) -> None:
            if text.strip():
                print(f"[speech] {'heard' if final else '...'}: {text!r}")

        ears = speech.create(send="pcm").start(_on_transcript)

        def _audio_cb(indata, frames, time_info, status):
            # indata: numpy array (frames, 1) int16 — send raw bytes to Deepgram
            ears.feed_pcm(bytes(indata))

        stream = sd.InputStream(
            samplerate=SAMPLE_RATE,
            channels=1,
            dtype="int16",
            callback=_audio_cb,
        )

        with stream:
            print("Recording... Press Enter to stop.")
            input()

        final_text = ears.stop()
        if final_text.strip():
            print(f"[speech] dispatching full transcript: {final_text!r}")
            _dispatch(final_text)

    while True:
        try:
            input("Press Enter to start recording (Ctrl+C to quit)...")
        except (KeyboardInterrupt, EOFError):
            print("\nDone.")
            break
        _run_session()


def main() -> None:
    threading.Thread(target=_speaking_guard_loop, daemon=True).start()
    say_text = None
    args = sys.argv[1:]
    if "--say" in args:
        idx = args.index("--say")
        if idx + 1 < len(args):
            say_text = args[idx + 1]
        else:
            print('--say requires a quoted phrase, e.g. --say "assign BP check to Vaishnav"', file=sys.stderr)
            sys.exit(1)

    if say_text is not None:
        _run_say_mode(say_text)
    else:
        print("Coordinator listener ready. Speak naturally:")
        print('  e.g. "Assign repeat blood pressure to Vaishnav"')
        print('  e.g. "Vaishnav, two-minute timer is up"')
        print('  e.g. "Hey Vaishnav, clarify who that task is for"\n')
        _run_mic_mode()


if __name__ == "__main__":
    main()
