# ADR 0009: Drop in-browser voice transcription

## Status

Accepted (2026-09-02). Supersedes the earlier in-browser transcription
direction (Web Speech implementation;

## Context

The field app's "Describe instead" screen offered voice capture so contributors
could speak a description instead of typing. Two implementations shipped or
were planned:

1. **In-browser speech recognition (Web Speech API)** — `SpeechRecognition`
   running client-side, zero backend. This shipped.

Web Speech was chosen to avoid backend cost and complexity, it worked great on Android

## Decision

**Remove voice transcription entirely.** User testing showed poor accuracy: Users would say "Encampment" and the transcription would output "Camp" along with other issues.

Removed (2026-09-02, branch `remove/transcription`):

- `web-speech-transcribe.js` (+ test) — the Web Speech session layer
- The describe screen's voice button, live preview, and status/error UI
- Dead legacy plumbing: `transcribe.js` (mock), `capture-audio.js` (the
  pre–Web Speech record-a-blob component)

Kept: the describe screen's plain textarea (dictation still works there via
the system keyboard), and the `inputSource` field on saved descriptions
(normalized to `"typed"`), so the persisted data contract is unchanged.