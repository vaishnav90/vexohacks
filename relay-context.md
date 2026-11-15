# Relay — Project Context

## Core Concept

Relay is a crew coordination system, not an AI scribe.

The distinctive idea: a wearable that tracks the difference between what the crew planned, what someone acknowledged, what was actually reported complete, and what the next care team needs to know.

**Competitive positioning:**
> "We coordinate and reconcile care as it happens, then generate the documentation."

Not: "We use AI to write EMS reports."

Competitors like ImageTrend already advertise EMS-specific voice-to-structured documentation, human review, audit trails, and documentation-gap checks. Those features alone are not enough to claim uniqueness.

---

## Signature Feature: Closed-Loop Action Ledger

Actions are represented as a lifecycle, not utterances:

```
Requested → Acknowledged → Reported Complete → Verified
```

### Example Interaction

| What happens | What Relay does |
|---|---|
| Crew lead says, "Alex, get a repeat BP." | Creates a **requested** task assigned to Alex. Does NOT record a BP measurement. |
| Alex says, "On it." | Marks the task **acknowledged**. |
| Alex says, "Repeat pressure 110 over 70." | Creates the measurement and links it to the task. |
| Alex corrects, "Correction, systolic 100, not 110." | Updates the current value while preserving correction history. |
| Crew prepares handoff. | Includes confirmed measurement; keeps unresolved tasks separate from completed care. |

The key innovation is not recognizing those sentences individually — it is linking them into one evolving action without turning intent into fact.

---

## Haptics: Communicate Ownership, Not Just Time

Each band operates around three explicit states:

1. A task was assigned to you.
2. A timer you explicitly started has elapsed.
3. Something you recorded needs clarification.

Personal timers route to the specific person, not the whole crew. Timer expiry never automatically documents that a rotation or treatment happened — it only alerts the right person.

Avoid complex vibration vocabularies initially. Test a few clearly distinguishable patterns with a "What was that alert?" escape hatch. Do not assume crews will reliably learn an elaborate haptic language under pressure.

---

## Continuity Handoff

Standard summaries say what happened. Relay's handoff also preserves what remains unresolved.

Three sections:

| Section | Contents |
|---|---|
| **Established** | Findings and interventions the crew has confirmed |
| **Changed** | Important trends or changes during the encounter |
| **Still open** | Pending tasks, unanswered questions, information not yet verified |

**Example output:**
> "Repeat pressure is confirmed. Medication history is patient-reported and not yet verified. A reassessment was requested but has not been documented as complete."

The system says "not documented as complete," not "not done." That distinction prevents missing documentation from being misread as an omission of care.

---

## Evidence-Linked Timeline ("Show Me Why")

Every important handoff statement is traceable to its source:

```
Recorded event:  Aspirin, 300 mg
Source:          Crew member's spoken report
Event time:      Reported as 14:32
Capture time:    14:34
Status:          Confirmed by reporting medic
Correction:      Prior extraction of 324 mg rejected
```

This is not just a transcript — it makes uncertainty and provenance visible at the point of review. ImageTrend already advertises audit trails, so the differentiator here is linking source, action lifecycle, correction, and handoff statement into a single event record.

---

## Product Summary

**Relay** is a voice-controlled wearable that helps EMS crews coordinate care without reaching for a screen. Medics assign tasks by voice, the right teammate gets a private vibration, and the system tracks what's accepted, reported complete, or still pending. At the hospital, it generates a handoff with confirmed events and unresolved tasks clearly separated.

Unlike a basic AI scribe, Relay doesn't just record the call — it helps the crew stay coordinated throughout it.

The product has three connected jobs:
1. **Coordinate** — who is handling what?
2. **Reconcile** — what was requested vs. what was reported complete?
3. **Transfer** — what does the next team need to know, including what remains uncertain?

Documentation is a by-product of that workflow, not the reason to wear the device.

---

## Feature Summary

| Feature | What it does | Difference from a basic scribe |
|---|---|---|
| Task assignment | "Alex, repeat the BP" → Alex's band vibrates, task appears as pending | Assigns work instead of only recording speech |
| Acknowledgment | "On it" → task changes to accepted | Separates hearing a request from completing it |
| Completion tracking | "BP 110 over 70" → result logged and linked to pending task | Connects the request to its reported result |
| Personal timers | "Two-minute timer for Alex" → only Alex's band alerts | Routes reminders to a specific person |
| Open-task handoff | Summary separates confirmed events from pending/unverified items | Transfers unfinished work, not just a past-event summary |
| Traceable corrections | "Correction: 100, not 110" → updates result and handoff, preserves original | Makes each fact's source and correction history reviewable |

---

## Tech Stack

| Component | What it does |
|---|---|
| **VexoBand + phone** | Captures speech, plays audio through earpiece, delivers vibrations |
| **Deepgram** | Real-time speech-to-text transcription (input side) |
| **OpenAI or Gemini** | Converts transcript into structured action: assign task, log result, correct event, or start timer |
| **Backend** | Saves events, manages task lifecycle, runs timers |
| **MiniMax** | Text-to-speech for system confirmations and handoff readback (streaming audio over HTTP or WebSocket) |

### Data Flow

```
Voice → Deepgram → OpenAI/Gemini → Backend
                                    ├→ Band haptics (VexoBand)
                                    └→ MiniMax → Earpiece
```

### Example: "Start a two-minute timer for Alex"

1. Deepgram returns the transcript.
2. LLM extracts: `start_timer`, 120 seconds, Alex.
3. Backend resolves Alex and starts the timer.
4. Only after success: MiniMax says "Two-minute timer started for Alex."
5. At expiry: backend triggers Alex's band vibration.

---

## Prototype Scope (v1)

Three commands only:
- **Assign task**
- **Mark complete**
- **Start timer**

Build order:
1. Connect phone mic → Deepgram → LLM → backend (confirm via MiniMax in earpiece).
2. Add VexoBand haptics once the voice loop works end-to-end.

Keep timers and task state in backend code, not in the AI models. If transcription is ambiguous, ask for clarification rather than executing a guessed command.

---

## Demo Script (Two Bands)

1. Crew lead assigns a repeat measurement by voice.
2. Second medic acknowledges it; band confirms task ownership via haptic.
3. Medic reports a result.
4. Speech system mishears a number.
5. Medic corrects it.
6. A separate task remains unresolved.
7. Generated handoff shows corrected result and explicitly separates the unresolved task.
8. Receiving clinician acknowledges the handoff.

Three things the screen must make immediately visible:
- Task changing state.
- Correction propagating into every downstream output.
- Unresolved task remaining unresolved (not invented away).

---

## What to Remove from the Pitch

- General protocol Q&A — pulls toward a different problem
- "Multiple AI agents" — an implementation detail, not customer value
- Generic timer reminders — useful infrastructure, not the headline
- "Automatically catches missed care" — too strong; Relay identifies unresolved recorded requests, it cannot infer omitted care
- "First" or "only" claims — not supportable without exhaustive competitive review
- Offline operation, monitor integration, required-field reminders alone — ImageTrend already advertises these
