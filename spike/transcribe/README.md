# Transcription spike (throwaway)

Proves the **client-direct** live-transcription pipeline before we touch the app or build the
backend — see `../../docs/todo/transcription-architecture.md` §5.1.

```
mic ─getUserMedia─▶ AudioContext ─▶ pcm-worklet (16 kHz Int16 PCM)
   ─▶ pushable async stream ─▶ StartStreamTranscription (AudioStream)
   ─▶ TranscriptResultStream ─▶ live partials + final text in the UI
```

No `npm install`, no bundler — `main.js` imports the AWS SDK via a native ESM URL
(`https://esm.sh/@aws-sdk/client-transcribe-streaming@3`). The SDK's browser build streams over a
SigV4-signed WebSocket, so it needs a **secure context** — `localhost` qualifies.

## Run

**1. Serve the folder over localhost** (any static server; must be localhost/HTTPS for mic + worklet):

```sh
npx http-server /Users/aaron.hans/dev/gnp/spike/transcribe -p 8080 -c-1
# then open http://localhost:8080
```

**2. Mint temporary AWS credentials** on an identity allowed to call Transcribe streaming.
Simplest for a spike (uses your own permissions for 1 hour):

```sh
aws sts get-session-token --duration-seconds 3600
```

Paste the returned `AccessKeyId`, `SecretAccessKey`, and `SessionToken` into the page. Keep
`Region` = `us-west-2` (or wherever Transcribe streaming is enabled for you).

> The real app will not do this — the `/transcribe-credentials` endpoint (backend workstream)
> will vend scoped, single-action, short-TTL creds. `get-session-token` here is broad on purpose
> for a quick local test; treat the pasted creds as sensitive and let them expire.

**3. Click _Start recording_ and talk.** Interim text appears in **Partial**; finalized phrases
move to **Final transcript**. _Stop_ (or the 180 s cap) ends the stream cleanly.

## What this de-risks

- **Hand-rolled AudioWorklet** producing 16 kHz signed-16-bit-LE PCM frames (the "bulk of the
  work" the plan flagged) — no `MediaRecorder`, no blobs.
- Bridging the worklet's push-based `port` to the SDK's pull-based `AudioStream` async iterable.
- Live partial vs. final result handling.
- That a browser can hold a direct Transcribe streaming session with pasted temp creds — i.e.
  audio never needs to touch our compute.

## Decision notes

- **microphone-stream vs. hand-rolled worklet:** built hand-rolled here to see the whole pipeline
  with no hidden magic and zero deps. If the worklet proves fussy across the real device matrix,
  `microphone-stream` is the drop-in alternative (§6.1 of the architecture doc). Record the
  outcome of this spike below.
- **Known rough edge (fine for a spike, fix for prod):** the worklet does nearest-neighbour
  decimation per render quantum (matches care-connect), which drifts slightly off exactly 16 kHz
  and has no anti-alias filter. Production should use a proper resampler.

### Spike result (fill in after testing)

- Browser/OS tested:
- Context sample rate reported:
- Live partials worked? (y/n):
- Latency felt like:
- Chose worklet or microphone-stream:
- Notes:

## Cleanup

Throwaway — delete the whole `spike/` folder once the outcome is recorded in the architecture doc.
