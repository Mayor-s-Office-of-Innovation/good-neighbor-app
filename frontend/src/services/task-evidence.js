/*
  task-evidence — hydrate home worklist tasks with their source artifact
  (place name, georeferenced address, and a signed media URL).

  Both lookups are memoised per page load: check artifacts by checkId, media
  URLs by checkId:artifactId. A failed lookup is evicted so the next render
  retries.
*/
import { getCheck, getMediaUrl } from "./api.js";
import { taskArtifactIds } from "../domain/home-tasks.js";

const CHECK_ARTIFACTS_CACHE = new Map();
const MEDIA_URL_CACHE = new Map();

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
  };
  if (artifact.s3Key && artifact.contentType?.startsWith?.("image/")) {
    try {
      const { downloadUrl, thumbnailUrl } = await cachedMediaUrls(
        task.checkId,
        artifact.artifactId,
      );
      return {
        ...task,
        evidence,
        mediaUrl: downloadUrl,
        // Cards show the small variant when the worker has stored one; the
        // original is the fallback (and always the lightbox source).
        thumbnailUrl: thumbnailUrl || downloadUrl,
      };
    } catch (err) {
      console.warn("Could not hydrate task media", {
        checkId: task.checkId,
        artifactId: artifact.artifactId,
        err,
      });
    }
  }
  return { ...task, evidence };
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
 * @typedef {{ downloadUrl: string, thumbnailUrl?: string }} MediaUrls
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
  if (!MEDIA_URL_CACHE.has(key)) {
    MEDIA_URL_CACHE.set(
      key,
      getMediaUrl(checkId, artifactId)
        .then((media) => ({
          downloadUrl: media.downloadUrl,
          ...(media.thumbnailUrl ? { thumbnailUrl: media.thumbnailUrl } : {}),
        }))
        .catch((err) => {
          MEDIA_URL_CACHE.delete(key);
          throw err;
        }),
    );
  }
  return MEDIA_URL_CACHE.get(key);
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
  return Boolean(
    task?.checkId &&
      taskArtifactIds(task).length &&
      !task?.evidence?.artifactId &&
      !task?.mediaUrl &&
      !task?.thumbnailUrl,
  );
}

export function mergeHydratedTasks(tasks, hydratedTasks) {
  const hydratedById = new Map(
    hydratedTasks
      .filter((task) => task?.taskId)
      .map((task) => [task.taskId, task]),
  );
  return tasks.map((task) => hydratedById.get(task.taskId) || task);
}
