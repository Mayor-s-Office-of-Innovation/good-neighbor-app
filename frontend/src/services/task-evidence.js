/*
  task-evidence — hydrate home worklist tasks with their source artifact
  (place name, georeferenced address, and a signed media URL).

  Check artifacts are memoised per page load. Signed media URLs are shared
  by checkId:artifactId only until their renewal deadline. Failures use a short
  backoff; failed hydration remains eligible for later retry.

  When the deployment serves photos behind CloudFront signed cookies
  (notes/media-signed-cookies-plan.md), the server puts plain `mediaPath` /
  `thumbnailPath` values on task evidence and check artifacts. Those are
  registered here as never-expiring entries, so no signing request is made for
  them; the cookie, renewed with the session, is the only bearer. An image that
  fails on such a path (a stale cookie) is invalidated like any other and falls
  back to the presign route for a while, so photos keep working either way.
*/
import { getCheck, getCheckEvidenceBatch, getMediaUrl } from "./api.js";
import { taskArtifactIds } from "../domain/home-tasks.js";

const CHECK_ARTIFACTS_CACHE = new Map();
const MEDIA_URL_CACHE = new Map();
const MEDIA_FAILURES = new Map();
/** Keys whose server path recently failed to load; presign is used until then. */
const MEDIA_PATH_COOLDOWN = new Map();
/** Matches the cookie renewal cadence (token refresh every 15 minutes). */
const MEDIA_PATH_COOLDOWN_MS = 15 * 60 * 1000;

export async function hydrateTaskEvidence(tasks, { batch = false } = {}) {
  // Register server-provided paths before anything awaits, so a card that
  // mounts in the same tick finds them and never starts a signing request.
  const direct = new Map();
  for (const task of tasks) {
    const hydrated = hydrateTaskFromPaths(task);
    if (hydrated) direct.set(task, hydrated);
  }
  const remaining = tasks.filter((task) => !direct.has(task));
  const artifactsByCheck = remaining.length
    ? await loadArtifactsForChecks(
        remaining.map((task) => task?.checkId),
        batch,
      )
    : new Map();
  return Promise.all(
    tasks.map(
      (task) =>
        direct.get(task) ??
        hydrateTaskFromArtifacts(
          task,
          artifactsByCheck.get(task?.checkId) || [],
        ),
    ),
  );
}

/**
 * A task whose evidence already names its viewer paths needs no check read:
 * register the paths and report the media ready. While a path is cooling down
 * after a failed load, the photo is signed directly instead (the evidence
 * already carries the place and street, so the check read is still skipped).
 * Returns null when the evidence has no usable path.
 * @param {Record<string, any>} task
 * @returns {Record<string, any> | Promise<Record<string, any>> | null}
 */
function hydrateTaskFromPaths(task) {
  const evidence = task?.evidence;
  if (!task?.checkId || !evidence?.mediaPath || !evidence.artifactId)
    return null;
  const urls = registerMediaPaths(task.checkId, evidence.artifactId, evidence);
  if (urls) return withMediaUrls(task, evidence, urls);
  if (!hasRegisteredMediaPath(task.checkId, evidence.artifactId)) return null;
  return withSignedMedia(task, evidence, evidence.artifactId);
}

/**
 * @param {Record<string, any>} task
 * @param {Record<string, any>} evidence
 * @param {MediaUrls} urls
 */
function withMediaUrls(task, evidence, urls) {
  return {
    ...task,
    evidence,
    mediaUrl: urls.downloadUrl,
    thumbnailUrl: urls.thumbnailUrl,
    mediaExpiresAt: urls.expiresAt,
    mediaState: "ready",
    mediaRetryAt: undefined,
  };
}

/**
 * Attach the shared-cache media URLs for one artifact to a task, or mark the
 * task for a retry when signing fails.
 * @param {Record<string, any>} task
 * @param {Record<string, any>} evidence
 * @param {string} artifactId
 */
async function withSignedMedia(task, evidence, artifactId) {
  try {
    // `taskMediaUrl` picks the thumbnail for cards when the worker has
    // stored one and falls back to the original; the original is always
    // the lightbox source.
    return withMediaUrls(
      task,
      evidence,
      await cachedMediaUrls(task.checkId, artifactId),
    );
  } catch {
    return {
      ...task,
      evidence,
      mediaUrl: undefined,
      thumbnailUrl: undefined,
      mediaState: "retry",
      mediaRetryAt: Date.now() + 5000,
    };
  }
}

/**
 * Make a server-provided path the cached answer for one artifact. Returns the
 * entry, or null while the path is cooling down after a failed load (the
 * presign route serves that artifact meanwhile).
 * @param {string} checkId
 * @param {string} artifactId
 * @param {{ mediaPath?: string, thumbnailPath?: string }} paths
 * @returns {MediaUrls | null}
 */
export function registerMediaPaths(checkId, artifactId, paths) {
  const mediaPath = paths?.mediaPath;
  if (typeof mediaPath !== "string" || !mediaPath.startsWith("/")) return null;
  const key = `${checkId}:${artifactId}`;
  const cooldown = MEDIA_PATH_COOLDOWN.get(key);
  if (cooldown > Date.now()) return null;
  MEDIA_PATH_COOLDOWN.delete(key);
  const urls = {
    downloadUrl: mediaPath,
    thumbnailUrl:
      typeof paths.thumbnailPath === "string" &&
      paths.thumbnailPath.startsWith("/")
        ? paths.thumbnailPath
        : undefined,
    expiresAt: Infinity,
  };
  const current = MEDIA_URL_CACHE.get(key);
  if (current?.fromPath && current.promise) return urls;
  MEDIA_URL_CACHE.set(key, {
    controller: new AbortController(),
    consumers: 0,
    pending: false,
    fromPath: true,
    expiresAt: Infinity,
    promise: Promise.resolve(urls),
  });
  MEDIA_FAILURES.delete(key);
  return urls;
}

/** @param {string} checkId @param {string} artifactId */
export function hasRegisteredMediaPath(checkId, artifactId) {
  const key = `${checkId}:${artifactId}`;
  return (
    Boolean(MEDIA_URL_CACHE.get(key)?.fromPath) ||
    MEDIA_PATH_COOLDOWN.get(key) > Date.now()
  );
}

/**
 * Same hydration for tasks whose check detail the caller already holds
 * (the reports day view fetches each check for its photo strip), so the
 * check is not fetched a second time. Media URLs still go through the
 * shared cache.
 * @param {Record<string, any>[]} tasks
 * @param {{ artifacts?: any[], analyses?: any[], checkId?: string, check?: { checkId?: string } } | null | undefined} detail
 */
export function hydrateTaskEvidenceFromCheck(tasks, detail) {
  const artifacts = artifactsWithAddresses({
    ...(detail || {}),
    checkId: detail?.checkId || detail?.check?.checkId || tasks[0]?.checkId,
  });
  return Promise.all(
    tasks.map((task) => hydrateTaskFromArtifacts(task, artifacts)),
  );
}

/**
 * @param {Record<string, any>} task
 * @param {Record<string, any>[]} artifacts the task's check's artifacts
 */
async function hydrateTaskFromArtifacts(task, artifacts) {
  const artifact = firstTaskArtifact(task, artifacts);
  if (!artifact) return task;
  // `positionDescriptor` is not a fallback here: since ADR 0014 it is a
  // fixed literal, not a location. Only pre-Phase-2 rows carry a place
  // name; the card falls back to the site name otherwise.
  const evidence = {
    artifactId: artifact.artifactId || "",
    placeName: artifact.placeName || task.placeName || task.location || "",
    georeferencedAddress: artifact.georeferencedAddress || "",
    text: artifact.text || "",
    kind: artifact.contentType?.startsWith?.("image/") ? "photo" : "text",
  };
  if (artifact.s3Key && artifact.contentType?.startsWith?.("image/")) {
    if (artifact.mediaPath)
      registerMediaPaths(task.checkId, artifact.artifactId, artifact);
    return withSignedMedia(task, evidence, artifact.artifactId);
  }
  return { ...task, evidence, mediaState: "none" };
}

/**
 * A check's artifacts with the street each analysis georeferenced folded in.
 * Artifacts that carry server media paths are registered on the way through.
 * @param {{ artifacts?: any[], analyses?: any[], checkId?: string }} result
 */
function artifactsWithAddresses(result) {
  const addresses = new Map(
    (result.analyses || []).map((analysis) => [
      analysis.artifactId,
      analysis.georeferencedAddress || "",
    ]),
  );
  return (result.artifacts || []).map((artifact) => {
    if (artifact.mediaPath && result.checkId)
      registerMediaPaths(result.checkId, artifact.artifactId, artifact);
    return {
      ...artifact,
      georeferencedAddress:
        addresses.get(artifact.artifactId) ||
        artifact.georeferencedAddress ||
        "",
    };
  });
}

/** Start every batch immediately. Cache promises per check so overlapping task
 * and question loads share in-flight reads as well as successful results.
 * @param {string[]} ids @param {boolean} batch
 */
async function loadArtifactsForChecks(ids, batch) {
  const checkIds = [...new Set(ids.filter(Boolean))];
  const missing = checkIds.filter((id) => !CHECK_ARTIFACTS_CACHE.has(id));
  const size = batch ? 5 : 1;
  for (let offset = 0; offset < missing.length; offset += size) {
    const group = missing.slice(offset, offset + size);
    const response = group.length > 1 ? getCheckEvidenceBatch(group) : null;
    for (const id of group) {
      const detail = response
        ? response.then(({ results }) => {
            const row = results.find((result) => result.checkId === id);
            if (row?.status !== 200)
              throw new Error("Check evidence unavailable");
            return row;
          })
        : getCheck(id);
      CHECK_ARTIFACTS_CACHE.set(
        id,
        detail
          .then((result) => artifactsWithAddresses({ ...result, checkId: id }))
          .catch((err) => {
            console.warn("Could not hydrate task evidence", {
              checkId: id,
              err,
            });
            CHECK_ARTIFACTS_CACHE.delete(id);
            return [];
          }),
      );
    }
  }
  const artifacts = new Map();
  await Promise.all(
    checkIds.map(async (id) => {
      artifacts.set(id, await CHECK_ARTIFACTS_CACHE.get(id));
    }),
  );
  return artifacts;
}

/**
 * @typedef {{ downloadUrl: string, thumbnailUrl?: string, expiresAt:number }} MediaUrls
 *   `downloadUrl` is the original; `thumbnailUrl` the small card variant when
 *   the backend has one for this photo.
 */

/**
 * Presigned URLs for one artifact, memoised per page load.
 * @param {string} checkId
 * @param {string} artifactId
 * @param {{signal?: AbortSignal}} [options]
 * @returns {Promise<MediaUrls>}
 */
export async function cachedMediaUrls(checkId, artifactId, options = {}) {
  const { signal } = options;
  if (signal?.aborted)
    throw new DOMException("Photo read cancelled", "AbortError");
  const key = `${checkId}:${artifactId}`;
  const failure = MEDIA_FAILURES.get(key);
  if (failure?.retryAt > Date.now()) throw failure.error;
  const cached = MEDIA_URL_CACHE.get(key);
  if (cached && (cached.pending || cached.expiresAt > Date.now()))
    return consumeMedia(cached, key, signal);
  const started = Date.now();
  const controller = new AbortController();
  const entry = {
    controller,
    consumers: 0,
    pending: true,
    expiresAt: 0,
    diagnosticStatus: failure?.diagnosticStatus,
    promise: /** @type {Promise<MediaUrls>} */ (null),
  };
  let timer;
  let onCancel;
  const deadline = new Promise((_, reject) => {
    onCancel = () =>
      reject(new DOMException("Photo signing cancelled", "AbortError"));
    controller.signal.addEventListener("abort", onCancel, { once: true });
    timer = setTimeout(() => {
      controller.abort();
    }, 15000);
  });
  entry.promise = Promise.race([
    getMediaUrl(checkId, artifactId, { signal: controller.signal }),
    deadline,
  ])
    .then(({ downloadUrl, thumbnailUrl, expiresIn }) => {
      // Start the clock before the request and renew 30 seconds before expiry.
      // Short TTLs keep a proportional margin instead of becoming instantly stale.
      const ttl =
        Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1000 : 300000;
      entry.expiresAt = started + ttl - Math.min(30000, ttl / 10);
      entry.pending = false;
      if (MEDIA_URL_CACHE.get(key) === entry) MEDIA_FAILURES.delete(key);
      return { downloadUrl, thumbnailUrl, expiresAt: entry.expiresAt };
    })
    .catch((error) => {
      if (MEDIA_URL_CACHE.get(key) === entry) {
        MEDIA_URL_CACHE.delete(key);
        if (controller.signal.aborted) throw error;
        const status = Number.isInteger(error?.status) ? error.status : 0;
        // One diagnostic per artifact/status until a successful signing resets it.
        // Never include raw errors: network messages can contain signed URLs.
        if (entry.diagnosticStatus !== status)
          console.warn("Photo signing failed", { checkId, artifactId, status });
        MEDIA_FAILURES.set(key, {
          error,
          retryAt: Date.now() + 5000,
          diagnosticStatus: status,
        });
      }
      throw error;
    })
    .finally(() => {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", onCancel);
      entry.pending = false;
    });
  MEDIA_URL_CACHE.set(key, entry);
  return consumeMedia(entry, key, signal);
}

/**
 * A caller can release its request without cancelling other photo consumers.
 * @param {{consumers: number, pending: boolean, controller: AbortController, promise: Promise<MediaUrls>}} entry
 * @param {string} key
 * @param {AbortSignal} [signal]
 */
function consumeMedia(entry, key, signal) {
  entry.consumers++;
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () =>
      reject(new DOMException("Photo read cancelled", "AbortError"));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
  return Promise.race([entry.promise, aborted]).finally(() => {
    signal?.removeEventListener("abort", onAbort);
    if (--entry.consumers === 0 && entry.pending) {
      if (MEDIA_URL_CACHE.get(key) === entry) MEDIA_URL_CACHE.delete(key);
      entry.controller.abort();
    }
  });
}

/** Invalidate one failed image, never another artifact or an in-flight signer.
 * @param {string} checkId @param {string} artifactId
 */
export function invalidateMediaUrls(
  checkId,
  artifactId,
  { retryFailures = false } = {},
) {
  const key = `${checkId}:${artifactId}`;
  const current = MEDIA_URL_CACHE.get(key);
  // A server path that failed to load means the media cookie is missing or
  // stale. Use the presign route for this photo until the next cookie renewal
  // window rather than re-registering the same path on every list refresh.
  if (current?.fromPath)
    MEDIA_PATH_COOLDOWN.set(key, Date.now() + MEDIA_PATH_COOLDOWN_MS);
  if (!current?.pending) MEDIA_URL_CACHE.delete(key);
  if (retryFailures && MEDIA_FAILURES.get(key)?.error?.status !== 404)
    MEDIA_FAILURES.delete(key);
}

/** Share a transient image-error cooldown across remounts. An img error does
 * not expose an HTTP status, so it must remain recoverable on reconnect.
 * @param {string} checkId @param {string} artifactId
 */
export function deferMediaRecovery(checkId, artifactId) {
  const key = `${checkId}:${artifactId}`;
  MEDIA_FAILURES.set(key, {
    error: Object.assign(new Error("Image temporarily unavailable"), {
      status: 0,
    }),
    retryAt: Date.now() + 5000,
  });
}

/** Avoid repeating doomed requests on each card rerender. Missing media may be
 * restored, so this negative result expires rather than becoming permanent.
 * @param {string} checkId @param {string} artifactId
 */
export function markMediaUnavailable(checkId, artifactId) {
  const key = `${checkId}:${artifactId}`;
  MEDIA_URL_CACHE.delete(key);
  MEDIA_FAILURES.set(key, {
    error: Object.assign(new Error("Image unavailable"), { status: 404 }),
    retryAt: Date.now() + 60000,
  });
}

function firstTaskArtifact(task, artifacts) {
  const sourceIds = new Set(taskArtifactIds(task));
  return (
    artifacts.find(
      (artifact) =>
        artifact.artifactId === task.evidence?.artifactId &&
        sourceIds.has(String(artifact.artifactId)),
    ) ||
    artifacts.find((artifact) =>
      sourceIds.has(String(artifact.artifactId || "")),
    ) ||
    null
  );
}

export function needsTaskEvidenceHydration(task) {
  if (
    !task?.checkId ||
    !taskArtifactIds(task).length ||
    task.mediaState === "none"
  )
    return false;
  if (task.mediaRetryAt > Date.now()) return false;
  if (task.evidence?.mediaPath && task.evidence.artifactId)
    return !hasRegisteredMediaPath(task.checkId, task.evidence.artifactId);
  if (task.mediaUrl || task.thumbnailUrl)
    return (
      Number.isFinite(task.mediaExpiresAt) && task.mediaExpiresAt <= Date.now()
    );
  return task.evidence?.kind !== "text";
}

export function mergeHydratedTasks(tasks, hydratedTasks) {
  const hydratedById = new Map(
    hydratedTasks
      .filter((task) => task?.taskId)
      .map((task) => [task.taskId, task]),
  );
  return tasks.map((task) => {
    const hydrated = hydratedById.get(task.taskId);
    if (
      !hydrated ||
      hydrated.checkId !== task.checkId ||
      taskArtifactIds(hydrated).join() !== taskArtifactIds(task).join()
    )
      return task;
    // Hydration owns evidence only. Current status, edits and guidance may have
    // changed while signing was in flight; removed tasks must stay removed.
    const evidence = {};
    for (const key of [
      "evidence",
      "mediaUrl",
      "thumbnailUrl",
      "mediaExpiresAt",
      "mediaState",
      "mediaRetryAt",
    ])
      if (Object.hasOwn(hydrated, key)) evidence[key] = hydrated[key];
    return { ...task, ...evidence };
  });
}

/** Restore photo/text identity for server-backed pending questions. Media signing
 * remains owned by artifact-photo, including retries after reconnecting.
 * @param {any[]} items
 */
export async function hydratePendingQuestionEvidence(items) {
  const checks = await loadArtifactsForChecks(
    items.map((item) => item.checkId),
    true,
  );
  return items.map((item) => {
    const artifact = (checks.get(item.checkId) || []).find(
      (entry) =>
        entry.artifactId ===
        (item.evidenceArtifactId || item.analysis?.artifactId),
    );
    if (!artifact) return item;
    return {
      ...item,
      kind: artifact.contentType?.startsWith("image/") ? "photo" : "text",
      placeName: artifact.placeName || item.placeName,
      georeferencedAddress:
        artifact.georeferencedAddress || item.georeferencedAddress,
      text: artifact.text || item.text,
    };
  });
}
