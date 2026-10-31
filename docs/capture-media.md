# Perimeter capture media and performance

Perimeter capture uploads the camera's original File directly to S3. The browser
neither recompresses it nor wraps new perimeter photos in base64. Backend analysis
still normalizes and resizes its own copy to a 1568-pixel long edge, encodes JPEG
quality 80, and converts that result to the analyzer's base64 request format
([ADR 0012](adr/0012-sharp-downscale.md)). Server-generated 480-pixel WebP
thumbnails are separate from the original.

## Local data lifetime

IndexedDB version 7 adds `captureMedia`, separate from draft/review metadata.
Each media record is scoped to its site, check, and item. New check items carry a
small `media` reference with original byte length and content type, not image data.

Browsers that reject IndexedDB Blob/File storage with the specific WebKit
preparation error retry using binary ArrayBuffers. Conversion happens outside the
transaction, one photo at a time; no base64 is produced. Reads reconstruct Blobs
with their original media type. Blob-capable browsers keep their existing path,
and quota or other storage errors still fail admission. The fallback also covers
thumbnail caching and retains the same original-release and deletion rules.

- Admission atomically saves the original Blob and its draft reference before
  announcing a saved photo. A storage failure removes the pending item and offers
  translated guidance to retake it after addressing storage availability.
- Pending originals survive app close and interrupted uploads. The persisted
  initial state is queued so a reload before upload starts is recoverable.
- After upload **and artifact registration** succeed and the acknowledgement is
  persisted, the original is deleted locally. Thumbnail readiness does not delay
  this cleanup. Interrupted registration retains the original and existing upload
  reservation identity so retry remains possible.
- A visible capture tile queues a local JPEG preview while requesting the server
  thumbnail independently. One worker job per tab decodes an already-local original,
  shrinks its long edge to at most 480 pixels, and encodes JPEG at quality 0.75.
  Queue entries contain keys, not Files. The full bitmap is closed before encoding;
  workers terminate when idle, hidden, or after a five-second timeout.
- Local previews (at most 256 KiB each) live in separate IndexedDB records and
  survive offline reloads without loading originals for display. A successful
  server-thumbnail cache write atomically deletes the local preview. The component
  replaces and revokes its old object URL. Neither preview path delays uploads.
- Unsupported workers/codecs, timeouts, or preview failures leave the existing
  placeholder/server-thumbnail path working. There is no main-thread resizing
  fallback and no full-original download for a tile. Server thumbnails use bounded
  retries and are cached locally.
- A lightbox action obtains the original from S3 on demand. Offline, an unsent
  original or cached thumbnail can be used; thumbnail-only viewing is labeled.
  Closing/removing the lightbox releases its image reference and any object URL.
- Removing an item, clearing a completed/discarded check, and sign-out clean up
  the applicable media records. Switching sites preserves outstanding drafts.

If best-effort local generation fails or upload cleanup wins the race before it
starts, a check can temporarily have no preview before its server thumbnail arrives. A subsequent loss of connectivity does not
restore the original locally: the evidence is safely registered in S3 and the
thumbnail can be fetched when connectivity returns.

Legacy inline-data-URL drafts remain readable. Resume migrates one photo at a
time with atomic reference replacement; failure preserves the legacy copy.
Registered legacy originals are converted to metadata without decoding the full
image. Migration shares the per-item upload lock where Web Locks is available.
New problem-report captures currently retain their existing intake path; shared
rendering/submission readers also understand migrated media references.

## Rendering and resource ownership

The perimeter grid retains keyed photo elements when status changes or new photos
arrive. Session notifications schedule one render per animation frame; background
checks do not repaint the active capture. Footer/results updates preserve matching
DOM rather than replacing the full tray. Thumbnail elements own and revoke their
object URLs. Hidden tiles avoid network refresh work. Grid/card thumbnail requests
share in-flight requests and a short failure backoff; each component has bounded
retry attempts, and fetches have a time limit.

Status saves write check metadata only. Original bytes are read for pending
uploads, one-at-a-time worker preview generation, or explicit full-image viewing,
not loaded into the session or copied on
each analysis notification. No image contents or signed URLs are persisted in
check metadata or emitted by the performance harness.

## Verification

From the repository root, start a fresh development server (restart it after
source edits so Vite's hot-reload module versions cannot split session singletons):

```sh
npm run dev --workspace frontend -- --port 5179
```

In another terminal:

```sh
node e2e/capture-performance.mjs
node e2e/capture-performance.mjs --binary
node e2e/capture-performance.mjs --thumbnails
node e2e/capture-performance.mjs --thumbnails --twenty
node_modules/.bin/playwright test -c e2e/capture-media.config.js
```

The first mode exercises legacy inline photos. Binary mode uses durable pending
originals and metadata references. Thumbnail mode seeds server-equivalent cached
thumbnails and releases originals before measuring. Fixture JPEG generation is
outside the timed sections. The default 11-photo fixture uses 4032 by 3024 JPEGs
of about 3.4 MiB each. The 20-photo fixture uses lower JPEG quality to remain under
the existing 50 MiB admission limit; do not compare its timings as if its file
sizes matched the 11-photo fixture.

The harness reports render duration, synchronous IndexedDB put time, total save
latency, upload-preparation time, and HTML size. Its first sample at each count
includes inserting additional tiles; subsequent samples measure status updates.
It is a desktop microbenchmark, not a phone RAM or camera-launch measurement.
Use browser/device profiling for image/graphics memory, full event-loop traces,
and real camera handoffs. Verify a 20-photo walk on a Pixel and an older Android,
including weak connectivity and app close/reopen, before production promotion.

The capture browser suite covers durable admission, metadata-only saves, immediate
original cleanup, interrupted registration, cached thumbnails, no original
fallback, legacy migration, quota failure, deletion races, multi-check cleanup,
stable image/focus identity, and a mounted offline capture view.

## Local-preview cost experiment

`e2e/preview-cost.mjs` is an isolated synthetic benchmark, not a production
preview feature. It requires the existing Playwright Chromium installation and
no app server, account, uploaded photos, or network service. It compares base64,
full-size Blob URLs, a 480-pixel main-thread canvas thumbnail, and 480/320-pixel
worker thumbnails using `createImageBitmap` and `OffscreenCanvas`. The worker
fully decodes the source before drawing a small canvas, matching the production
path that must discover source dimensions. Older experiment results used known
fixture dimensions and resize-at-decode; do not compare those as identical code.

```sh
mkdir -p e2e/test-results/preview-cost
node e2e/preview-cost.mjs --rates=1,4 --repeats=3 --count=11 > e2e/test-results/preview-cost/12mp.json
node e2e/preview-cost.mjs --rates=1,4 --repeats=3 --count=3 --size=6000x4000 > e2e/test-results/preview-cost/24mp.json
```

Inputs are deterministic noise JPEGs (quality 0.35); generation is excluded from
measurements. Each strategy uses a fresh browser context, processes photos
sequentially, and retains all preview elements until completion to simulate
slow uploads. Mode ordering rotates between repetitions. Source files are held
identically in all modes. Worker startup is included in the first photo's time;
bitmaps, canvases, workers, and object URLs are released after use. Output image
dimensions are checked. The script prints progress to stderr and JSON to stdout.

Results separate preparation time from decoding/display time (two animation
frames after image decode), and report animation-frame gaps, 16 ms timer lateness,
and main-thread long tasks. These are wall-clock and responsiveness measurements,
not CPU utilization, energy use, or actual tap/camera-launch latency. Retained
preview payload sizes are measured; decoded pixel-byte figures are arithmetic
estimates, **not RAM/GPU measurements**. Original-file storage, uploads, and the
old full-grid rerenders are excluded, so this isolates preview strategies rather
than reproducing the entire former application.

CPU throttling is a main-thread stress experiment, not an older-phone emulator;
worker and native decoder throttling can differ. A worker avoiding long tasks
still consumes CPU and transient decode memory. Real Android/iOS device profiling
with concurrent uploads is required before claiming phone performance or peak
memory improvements. Lower-resolution thumbnails reduce retained bytes but may
not substantially reduce source-image decoding time.

## Deployment compatibility

Version 7 readers and writers ship together. Older open connections receive a
version-change notification and close; a blocked upgrade surfaces an error.
**Do not roll back to a pre-version-7 client while new-format drafts are pending.**
Such a client cannot read the new database version or media references. Rollback
must retain these storage readers and recovery paths, or pending drafts must be
safely drained first. The existing S3 GET CORS and CSP policies cover thumbnail
fetches and object-URL display; no infrastructure change is needed.

The capture route JavaScript budget is 13.5 kB Brotli (previously 13 kB) to cover
incremental rendering. Separate 2.5 kB JavaScript and 300-byte CSS limits cover the
lazy capture media/thumbnail modules; a 600-byte limit covers the worker. The
worker is a same-origin asset included in the offline-shell precache. No dependency was added.
