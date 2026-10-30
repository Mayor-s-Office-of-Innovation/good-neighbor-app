// Keep mutation notifications independent of the polling/UI dependency graph.
const listeners = new Set();

/** @param {(originSiteId?: string) => void} listener */
export function onDuplicateInvalidation(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** @param {string} [originSiteId] */
export function invalidateDuplicateIssues(originSiteId) {
  for (const listener of listeners) listener(originSiteId);
}

/**
 * Server task changes that can invalidate a duplicate's evidence or original.
 * @param {{updatedAt?:string,status?:string,resolvedAt?:string,assessmentId?:string,checkId?:string,conditionId?:string,sourceArtifactIds?:string[]}} task
 * @returns {string}
 */
export function duplicateTaskVersion(task) {
  return JSON.stringify([
    task.updatedAt,
    task.status,
    task.resolvedAt,
    task.assessmentId,
    task.checkId,
    task.conditionId,
    task.sourceArtifactIds,
  ]);
}

// Keep observed task versions for the same session as the duplicate cache, so a
// changed worklist after navigation is still evidence of invalidation.
let versionsSite;
const versions = new Map();
/**
 * @param {string} siteId
 * @param {(Parameters<typeof duplicateTaskVersion>[0] & {taskId?: string})[]} tasks
 * @returns {void}
 */
export function observeDuplicateTasks(siteId, tasks) {
  if (versionsSite !== siteId) {
    versions.clear();
    versionsSite = siteId;
  }
  let changed = false;
  for (const task of tasks) {
    if (!task.taskId) continue;
    const version = duplicateTaskVersion(task);
    if (versions.has(task.taskId) && versions.get(task.taskId) !== version)
      changed = true;
    versions.set(task.taskId, version);
  }
  if (changed) invalidateDuplicateIssues(siteId);
}
