/*
  task-evidence — hydrate home worklist tasks with their source artifact
  (place name, georeferenced address, and a signed media URL).

  Check artifacts are memoised per page load. Signed media URLs are shared
  by checkId:artifactId only until their renewal deadline. Failures use a short
  backoff; failed hydration remains eligible for later retry.
*/
import { getCheck, getMediaUrl } from "./api.js";
import { taskArtifactIds } from "../domain/home-tasks.js";

const CHECK_ARTIFACTS_CACHE = new Map();
const MEDIA_URL_CACHE = new Map();
const MEDIA_FAILURES = new Map();

export async function hydrateTaskEvidence(tasks) {
  const checkIds = [
    ...new Set(tasks.map((task) => task?.checkId).filter(Boolean)),
  ];
  if (!checkIds.length) return tasks;

  const artifactsByCheck = new Map();
  await Promise.all(
    checkIds.map(async (checkId) => {
      artifactsByCheck.set(checkId, await cachedCheckArtifacts(checkId));
    }),
  );

  return Promise.all(
    tasks.map((task) =>
      hydrateTaskFromArtifacts(task, artifactsByCheck.get(task?.checkId) || []),
    ),
  );
}

/**
 * Same hydration for tasks whose check detail the caller already holds
 * (the reports day view fetches each check for its photo strip), so the
 * check is not fetched a second time. Media URLs still go through the
 * shared cache.
 * @param {Record<string, any>[]} tasks
 * @param {{ artifacts?: any[], analyses?: any[] } | null | undefined} detail
 */
export function hydrateTaskEvidenceFromCheck(tasks, detail) {
  const artifacts = artifactsWithAddresses(detail || {});
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
    try {
      const { downloadUrl, thumbnailUrl, expiresAt } = await cachedMediaUrls(
        task.checkId,
        artifact.artifactId,
      );
      // `taskMediaUrl` picks the thumbnail for cards when the worker has
      // stored one and falls back to the original; the original is always
      // the lightbox source.
      return {
        ...task,
        evidence,
        mediaUrl: downloadUrl,
        thumbnailUrl,
        mediaExpiresAt: expiresAt,
        mediaState: "ready",
        mediaRetryAt: undefined,
      };
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
  return { ...task, evidence, mediaState: "none" };
}

/**
 * A check's artifacts with the street each analysis georeferenced folded in.
 * @param {{ artifacts?: any[], analyses?: any[] }} result
 */
function artifactsWithAddresses(result) {
  const addresses = new Map(
    (result.analyses || []).map((analysis) => [
      analysis.artifactId,
      analysis.georeferencedAddress || "",
    ]),
  );
  return (result.artifacts || []).map((artifact) => ({
    ...artifact,
    georeferencedAddress:
      addresses.get(artifact.artifactId) || artifact.georeferencedAddress || "",
  }));
}

async function cachedCheckArtifacts(checkId) {
  if (!CHECK_ARTIFACTS_CACHE.has(checkId)) {
    CHECK_ARTIFACTS_CACHE.set(
      checkId,
      getCheck(checkId)
        .then(artifactsWithAddresses)
        .catch((err) => {
          console.warn("Could not hydrate task evidence", { checkId, err });
          CHECK_ARTIFACTS_CACHE.delete(checkId);
          return [];
        }),
    );
  }
  return CHECK_ARTIFACTS_CACHE.get(checkId);
}

/**
 * @typedef {{ downloadUrl: string, thumbnailUrl?: string, expiresAt:number }} MediaUrls
 *   `downloadUrl` is the original; `thumbnailUrl` the small card variant when
 *   the backend has one for this photo.
 */

/**
 * Presigned URLs for one artifact, memoised per page load.
 * @param {string} checkId @param {string} artifactId
 * @returns {Promise<MediaUrls>}
 */
export async function cachedMediaUrls(checkId, artifactId) {
  const key = `${checkId}:${artifactId}`;
  const failure = MEDIA_FAILURES.get(key);
  if (failure?.retryAt > Date.now()) throw failure.error;
  MEDIA_FAILURES.delete(key);
  const cached = MEDIA_URL_CACHE.get(key);
  if (cached && (cached.pending || cached.expiresAt > Date.now()))
    return cached.promise;
  const started = Date.now();
  const entry = {
    pending: true,
    expiresAt: 0,
    promise: /** @type {Promise<MediaUrls>} */ (null),
  };
  entry.promise = getMediaUrl(checkId, artifactId)
    .then(({ downloadUrl, thumbnailUrl, expiresIn }) => {
      // Start the clock before the request and renew 30 seconds before expiry.
      // Short TTLs keep a proportional margin instead of becoming instantly stale.
      const ttl =
        Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1000 : 300000;
      entry.expiresAt = started + ttl - Math.min(30000, ttl / 10);
      entry.pending = false;
      return { downloadUrl, thumbnailUrl, expiresAt: entry.expiresAt };
    })
    .catch((error) => {
      if (MEDIA_URL_CACHE.get(key) === entry) {
        MEDIA_URL_CACHE.delete(key);
        MEDIA_FAILURES.set(key, { error, retryAt: Date.now() + 5000 });
      }
      throw error;
    });
  MEDIA_URL_CACHE.set(key, entry);
  return entry.promise;
}

/** Invalidate one failed image, never another artifact or an in-flight signer.
 * @param {string} checkId @param {string} artifactId
 */
export function invalidateMediaUrls(checkId, artifactId) {
  const key = `${checkId}:${artifactId}`;
  if (!MEDIA_URL_CACHE.get(key)?.pending) MEDIA_URL_CACHE.delete(key);
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
    artifacts.find((artifact) =>
      sourceIds.has(String(artifact.artifactId || "")),
    ) || null
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
  return tasks.map((task) => hydratedById.get(task.taskId) || task);
}
