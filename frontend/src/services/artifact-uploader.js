// @ts-nocheck -- lenient migration baseline (checkJs). See memory step2-gnp-port-scope.
/*
  artifact-uploader — eager, background upload of capture photos to S3.

  The problem it solves: photos used to upload only at submit, so a many-photo walk
  pushed a big parallel batch of bytes over (often cellular) at the worst moment —
  slow and fragile. Here each photo starts uploading the instant it is captured, so
  by submit time the bytes are already in S3 and submit only has to register the
  cheap metadata (services/submit-check.js `uploadPlannedArtifacts`).

  We do ONLY the byte transfer eagerly (presign → PUT), NOT register:
    - register enqueues the analysis and must run after createCheck (backend
      invariant, handlers/artifacts.js), which submit owns; and
    - deferring register means a photo deleted before submit is simply never
      registered — no orphaned analysis.
  On success we also swap the item's full-res dataUrl for a thumbnail
  (services/image.js) so the draft stops carrying the full image.

  Failures degrade gracefully: an item left un-uploaded (offline, or a 4xx) keeps
  its full-res dataUrl and is picked up by submit's normal full uploadArtifact path.
*/
import {
  presignArtifact,
  putMedia,
  dataUrlToBlob,
  contentTypeFromDataUrl,
} from "./api.js";
import { downscaleDataUrl } from "./image.js";
import {
  getCurrentCheck,
  markItemUploaded,
  setItemUploadStatus,
} from "../state/check-session.js";
import { span } from "./instrument.js";

const MAX_CONCURRENT = 2;
const MAX_ATTEMPTS = 3;
const THUMB_MAX_DIM = 640;
const THUMB_QUALITY = 0.6;

/** itemIds queued or in flight, so one photo is never uploaded twice at once. */
const inFlight = new Set();
/** @type {Array<() => Promise<void>>} */
const queue = [];
let active = 0;

/**
 * Locate a photo item by side + id on the active session. Returns null if the
 * session changed underneath us or the item was deleted mid-upload.
 * @param {string} checkId
 * @param {string} side
 * @param {string} itemId
 */
function findItem(checkId, side, itemId) {
  const check = getCurrentCheck();
  if (!check || check.id !== checkId) return null;
  const sideState = check.sides?.[side];
  if (!sideState) return null;
  return sideState.items.find((it) => it.id === itemId) || null;
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry only transient failures: network (status 0/undefined) and 5xx. A 4xx
 * (e.g. 413 too-large, 400 bad request) fails identically on retry, so give up and
 * let submit surface it.
 * @param {any} err
 */
function isRetryable(err) {
  const status = err?.status;
  if (!status) return true;
  return status >= 500;
}

/**
 * Queue a captured photo for eager presign+PUT to S3. Fire-and-forget; safe to
 * call again for the same item (a no-op while it is queued, in flight, or done).
 * @param {string} checkId
 * @param {string} side
 * @param {string} itemId
 */
export function enqueueUpload(checkId, side, itemId) {
  if (!checkId || !itemId || inFlight.has(itemId)) return;
  const item = findItem(checkId, side, itemId);
  if (!item || item.upload?.status === "uploaded") return;
  inFlight.add(itemId);
  queue.push(() => runUpload(checkId, side, itemId));
  pump();
}

/** Start queued jobs up to the concurrency cap; re-pumps as each finishes. */
function pump() {
  while (active < MAX_CONCURRENT && queue.length) {
    const job = queue.shift();
    active += 1;
    void job().finally(() => {
      active -= 1;
      pump();
    });
  }
}

/**
 * Presign + PUT one photo's bytes with bounded retry. On success record the
 * artifact coordinates on the item and swap in a thumbnail; on terminal failure
 * mark it failed so submit falls back to a full upload.
 */
async function runUpload(checkId, side, itemId) {
  try {
    setItemUploadStatus(side, itemId, "uploading");
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const item = findItem(checkId, side, itemId);
      // Gone (deleted) or already uploaded+thumbnailed elsewhere: nothing to do.
      if (!item || !item.dataUrl || item.upload?.status === "uploaded") return;
      try {
        await uploadOnce(checkId, side, item);
        return;
      } catch (err) {
        if (!isRetryable(err) || attempt === MAX_ATTEMPTS) {
          setItemUploadStatus(side, itemId, "failed");
          return;
        }
        await sleep(2 ** (attempt - 1) * 1000); // 1s, 2s
      }
    }
  } finally {
    inFlight.delete(itemId);
  }
}

/**
 * One presign → PUT → record cycle. contentType is read from the FULL-RES dataUrl
 * before the thumbnail swap, so it describes the object actually in S3.
 */
async function uploadOnce(checkId, side, item) {
  const done = span("eager-upload", { art: `${side}:${item.id}` });
  const contentType = contentTypeFromDataUrl(item.dataUrl);
  const { artifactId, s3Key, uploadUrl } = await presignArtifact(checkId, {
    side,
    contentType,
  });
  const blob = await dataUrlToBlob(item.dataUrl);
  await putMedia(uploadUrl, blob, contentType);
  const thumbUrl = await downscaleDataUrl(item.dataUrl, {
    maxDim: THUMB_MAX_DIM,
    quality: THUMB_QUALITY,
  });
  markItemUploaded(side, item.id, { artifactId, s3Key, contentType, thumbUrl });
  done({ artifactId });
}

/**
 * Re-enqueue every capture photo on the active in-progress session that hasn't
 * finished uploading. Called when a capture screen mounts (a reload mid-walk, or
 * returning from the describe screen) so interrupted uploads resume on their own.
 */
export function resumePendingUploads() {
  const check = getCurrentCheck();
  if (!check || check.status !== "in-progress") return;
  for (const side of check.sideOrder || []) {
    const items = check.sides?.[side]?.items || [];
    for (const it of items) {
      if (
        it.kind === "photo" &&
        it.dataUrl &&
        it.upload?.status !== "uploaded"
      ) {
        enqueueUpload(check.id, side, it.id);
      }
    }
  }
}
