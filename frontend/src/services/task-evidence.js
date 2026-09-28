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
    tasks.map(async (task) => {
      const artifact = firstTaskArtifact(task, artifactsByCheck);
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
          const downloadUrl = await cachedMediaUrl(
            task.checkId,
            artifact.artifactId,
          );
          return {
            ...task,
            evidence,
            mediaUrl: downloadUrl,
            thumbnailUrl: downloadUrl,
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
    }),
  );
}

async function cachedCheckArtifacts(checkId) {
  if (!CHECK_ARTIFACTS_CACHE.has(checkId)) {
    CHECK_ARTIFACTS_CACHE.set(
      checkId,
      getCheck(checkId)
        .then((result) => {
          const addresses = new Map(
            (result.analyses || []).map((analysis) => [
              analysis.artifactId,
              analysis.georeferencedAddress || "",
            ]),
          );
          return (result.artifacts || []).map((artifact) => ({
            ...artifact,
            georeferencedAddress:
              addresses.get(artifact.artifactId) ||
              artifact.georeferencedAddress ||
              "",
          }));
        })
        .catch((err) => {
          console.warn("Could not hydrate task evidence", { checkId, err });
          CHECK_ARTIFACTS_CACHE.delete(checkId);
          return [];
        }),
    );
  }
  return CHECK_ARTIFACTS_CACHE.get(checkId);
}

async function cachedMediaUrl(checkId, artifactId) {
  const key = `${checkId}:${artifactId}`;
  if (!MEDIA_URL_CACHE.has(key)) {
    MEDIA_URL_CACHE.set(
      key,
      getMediaUrl(checkId, artifactId)
        .then((media) => media.downloadUrl)
        .catch((err) => {
          MEDIA_URL_CACHE.delete(key);
          throw err;
        }),
    );
  }
  return MEDIA_URL_CACHE.get(key);
}

function firstTaskArtifact(task, artifactsByCheck) {
  const artifacts = artifactsByCheck.get(task?.checkId) || [];
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
