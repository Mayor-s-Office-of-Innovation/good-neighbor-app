# TODO: real `sharp` media downscale (analyze worker)

*[index](../README.md) · follow-up to the analyze worker
([architecture.md](../architecture.md))*

**Status:** Deferred — **explicitly out of the current MVP** (decided 2026-08-19). The seam ships
as a passthrough; this doc captures the real implementation for when we pick it up. · **Owner:** team

## What

Replace the passthrough in [`backend/src/media/downscale.js`](../../backend/src/media/downscale.js)
with a real `sharp` resize: fit the long edge within **~1568px** and re-encode to JPEG, before the
analyze worker base64-encodes the media for the analyzer.

The seam is already in place — [`downscaleImage(bytes, contentType)`](../../backend/src/media/downscale.js)
is called by the worker at
[`workers/analyze-artifact.js`](../../backend/src/workers/analyze-artifact.js) and today returns the
input unchanged. This is a drop-in swap: no worker or handler changes, just a real body + its tests.

## Why it's deferred (not in this MVP)

- **`sharp` ships a native binary**, which is a Lambda packaging concern — the esbuild bundler in
  [`build-lambdas.mjs`](../../backend/scripts/build-lambdas.mjs) intentionally does **not** pull it
  in yet (it would need a platform-correct binary / Lambda layer for `linux-x64`/`arm64`).
- The MVP analyze path works without it: current capture sizes have not hit the analyzer's image
  limit. Note the safety net is thinner than it sounds — a `413` is **not** retryable (it isn't in
  the client's `RETRYABLE_STATUS`, and re-sending the same oversized bytes would just 413 again), so
  if one ever came back the worker would `markFailed` that artifact (a permanent "failed" ANALYSIS#
  marker), dropping that photo's analysis rather than recovering. Acceptable for disposable test
  data, but that dropped analysis is exactly what the real downscale prevents. The passthrough is
  honest and covered by a test.

## Why we'll want it eventually

- **Avoid `413 input_too_large`** from the analyzer on large phone photos (Bedrock caps the working
  image size).
- **Cut cost + latency** — a smaller base64 payload means less to encode, transfer, and bill on the
  analyzer/model side.
- Keeps our media-at-rest (full-res in S3, ~7-day lifecycle) decoupled from what we send the model.

## Done when

- `downscaleImage` fits the long edge to ~1568px and re-encodes to JPEG, preserving orientation.
- The Lambda bundle includes a platform-correct `sharp` (layer or bundled binary); `build:lambdas`
  and a dev apply stay green.
- Unit tests cover an oversized image (downscaled) and an already-small image (passthrough / no
  upscaling); the worker path stays green.
