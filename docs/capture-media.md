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

- Admission atomically saves the original Blob and its draft reference before
  announcing a saved photo. A storage failure removes the pending item and offers
  translated guidance to retake it after addressing storage availability.
- Pending originals survive app close and interrupted uploads. The persisted
  initial state is queued so a reload before upload starts is recoverable.
- After upload **and artifact registration** succeed and the acknowledgement is
  persisted, the original is deleted locally. Thumbnail readiness does not delay
  this cleanup. Interrupted registration retains the original and existing upload
  reservation identity so retry remains possible.
- A visible capture tile requests only the server thumbnail. Missing thumbnails
  show a placeholder and use bounded retries; they never trigger a full-original
  download. Successful thumbnails are cached locally as small Blobs.
- A lightbox action obtains the original from S3 on demand. Offline, an unsent
  original or cached thumbnail can be used; thumbnail-only viewing is labeled.
  Closing/removing the lightbox releases its image reference and any object URL.
- Removing an item, clearing a completed/discarded check, and sign-out clean up
  the applicable media records. Switching sites preserves outstanding drafts.

An online check can temporarily have no local preview after original cleanup and
before its server thumbnail arrives. A subsequent loss of connectivity does not
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
uploads or explicit full-image viewing, not loaded into the session or copied on
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

## Deployment compatibility

Version 7 readers and writers ship together. Older open connections receive a
version-change notification and close; a blocked upgrade surfaces an error.
**Do not roll back to a pre-version-7 client while new-format drafts are pending.**
Such a client cannot read the new database version or media references. Rollback
must retain these storage readers and recovery paths, or pending drafts must be
safely drained first. The existing S3 GET CORS and CSP policies cover thumbnail
fetches and object-URL display; no infrastructure change is needed.

The capture route JavaScript budget is 13.5 kB Brotli (previously 13 kB) to cover
incremental rendering. Separate 2 kB JavaScript and 300-byte CSS limits cover the
lazy capture media/thumbnail modules. No dependency was added.
