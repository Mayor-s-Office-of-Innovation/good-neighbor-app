import { taskArtifactIds } from "./home-tasks.js";

/** Artifact identity paired with hydrated task media. @param {Record<string, any>} task */
export function taskMediaArtifactId(task) {
  return task.evidence?.artifactId || taskArtifactIds(task)[0] || "";
}

/**
 * Return the best already-hydrated media URL for a task.
 * @param {Record<string, any>} task
 * @returns {string}
 */
export function taskMediaUrl(task) {
  return (
    task.thumbnailUrl ||
    task.thumbUrl ||
    task.mediaUrl ||
    task.photoUrl ||
    task.imageUrl ||
    ""
  );
}
