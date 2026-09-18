# ADR 0012: sharp for worker image downscale

## Status

Accepted (2026-09-16). Completes the deferred "Step E/F" TODO in
`backend/src/media/downscale.js`; no prior ADR covered it.

## Context

The analyze worker sent uploads to the analyzer untouched — `downscaleImage()`
was a placeholder passthrough. Camera photos (12–48 MP, 5–15 MB) were rejected
by the analyzer's provider with HTTP 413 `input_too_large` (observed in the
field 2026-09-16), which is non-retryable, so those artifacts failed
permanently. Photo size, not site or registration, was the variable: smaller
photos succeeded on identical flows.

The fix point is the worker: capture is deliberately a plain
`<input type="file" capture="environment">` (no client-side canvas pipeline),
and the analyzer's documented working size is a 1568 px long edge — pixels
beyond that are pure upload cost.

## Decision

- **sharp** in the worker's downscale leg only: EXIF-orient → fit 1568 px long
  edge (`withoutEnlargement`) → JPEG q80. Bounded payload (~<1 MB base64) and
  normalized encoding regardless of camera.
- **Packaging: node_modules copy, not a Lambda layer.** sharp is a native
  addon, so esbuild keeps it `external` (worker entry only) and
  `build-lambdas.mjs` copies `sharp` + `@img/*` into `dist/worker/`; npm's
  os/cpu-gated optionalDependencies put the linux-x64 binaries in place at
  `npm ci` time on the deploy runner. The worker zip grows ~1.4 MB (of a 50 MB
  budget) — api/authorizer bundles are untouched.
- The 413 path is now bounded upstream: the worker can no longer emit an
  oversized analyze request.

## Alternatives weighed

- **Client-side resize** (canvas): saves worker CPU but duplicates image
  policy across two codebases, degrades capture simplicity (the
  `capture="environment"` plainness is a feature), and leaves already-uploaded
  S3 objects unanalyzable.
- **Pure-JS (jimp)**: no native binary to package, but 10–50× slower and
  memory-heavy on 40+ MP frames inside a 1024 MB / batch-10 worker.
- **Official `@sharp/lambda` layer**: works, but pins a maintainer-published
  ARN per region, adds a deploy-order precondition (layer before function), and
  a second artifact to track — for ~1 MB saved. Declined; revisit if bundle
  size ever matters.

## Consequences

- Deploy builds must run `npm ci` before `build:lambdas` (they do —
  `.github/workflows/deploy.yml`), so the runner resolves `@img/sharp-linux-*`;
  the copied zip self-contains whatever binaries npm installed, with
  `@img/sharp-wasm32` riding along as fallback insurance.
- The copy includes sharp's **JS runtime dependencies** (`detect-libc`,
  `semver`) — sharp imports them at module load and the zip has no parent
  node_modules to fall back to; the build script reads them from sharp's
  `package.json` and fails the build if any is missing (cold-start crash
  prevention, not a warning).
- A non-decodable upload (corrupt/truncated bytes behind an image
  content-type) is a **permanent failure**: `downscaleImage` throws
  `DownscaleError`, which the worker maps to an `undecodable_input` ANALYSIS#
  failed marker rather than redelivering to the DLQ. Alpha channels composite
  onto white before the JPEG encode (a naive encode turns transparency black).
- First deploy must be watched: if Lambda logs a bindings error, the fix is in
  the copy step, not the app code.
- Local dev uses the same code path (darwin binaries via npm) — no harness
  divergence.
- Worst-case decode memory (10 records × big frames at 1024 MB) is
  unmeasured; if OOMs appear, serialize decodes or bump memory.