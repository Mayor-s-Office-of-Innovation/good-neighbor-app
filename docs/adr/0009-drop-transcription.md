# ADR 0009: Drop in-browser voice transcription

## Status

Accepted (2026-09-02). Supersedes the earlier in-browser transcription
direction (Web Speech implementation; a planned Amazon Transcribe /
device-token backend never shipped).

## Context

The field app's "Describe instead" screen offered voice capture so contributors
could speak a description instead of typing. Two implementations shipped or
were planned:

1. **In-browser speech recognition (Web Speech API)** — `SpeechRecognition`
   running client-side, zero backend. This shipped.
2. **Amazon Transcribe via a device-token backend** (invite codes + STS
   credential vending, record → downsample → POST) — the planned "live
   transcription workstream" in [MVP-TODO](../inprogress/MVP-TODO.md). The
   backend spike was never wired into the app.

Web Speech was chosen to avoid backend cost and complexity, but it comes with a
structural accuracy ceiling: on Chrome/Edge the audio is streamed to Google's
servers; on Safari (the field-test device) the implementation is flaky —
permission quirks and frequent `network` / `service-not-allowed` failures.

## Decision

**Remove voice transcription entirely.** User testing showed poor accuracy and
frequent failures; when it failed, testers immediately fell back to their
system keyboard's built-in dictation — which worked noticeably better (Apple's
on-device-quality engine, zero code from us, and it types straight into the
textarea). Our "Use voice" button was a worse duplicate of a native affordance
users already have.

Removed (2026-09-02, branch `remove/transcription`):

- `web-speech-transcribe.js` (+ test) — the Web Speech session layer
- The describe screen's voice button, live preview, and status/error UI
- Dead legacy plumbing: `transcribe.js` (mock), `capture-audio.js` (the
  pre–Web Speech record-a-blob component)
- The `?webcam` in-browser camera capture path (removed in the same pass; it
  was a separate opt-in experiment, not part of transcription)

Kept: the describe screen's plain textarea (dictation still works there via
the system keyboard), and the `inputSource` field on saved descriptions
(normalized to `"typed"`), so the persisted data contract is unchanged.

## Consequences

- **Positive:** one less accuracy complaint in testing; less code (~1,600
  lines); no mic-permission prompts in our flows; the describe screen is
  simpler.
- **Trade-off:** voice input is now entirely the OS keyboard's job — on devices
  without a dictation key (desktop Chrome/Firefox) there is no voice path. That
  is acceptable: field capture is mobile-first.
- **Lost optionality:** the planned Amazon Transcribe / device-token backend
  workstream is dropped with it. The device-provisioning / STS-vending backend
  it would have shared with auth (Option 3) is now auth-only — see the
  "shared dependency" note in [security-review.md](../security-review.md).
- **Reversal path:** if voice is ever re-added, native dictation is the bar to
  beat — any replacement must beat the OS keyboard, not just the Web Speech
  API.