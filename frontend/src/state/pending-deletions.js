import { showToast } from "./toasts.js";

/**
 * @typedef {object} DeletedProblem
 * @property {string} [checkId]
 * @property {string} artifactId
 * @property {string} conditionId
 * @property {string} [taskId]
 * @property {string} [title]
 * @property {string} [reference]
 */

/** @type {Map<string, {problem: DeletedProblem, status: string}>} */
const deletions = new Map();
/** @type {Map<string, Promise<unknown>>} */
const saves = new Map();
/** @type {Set<(status: string) => void>} */
const listeners = new Set();

/** @param {DeletedProblem} problem */
function key(problem) {
  return JSON.stringify([
    problem.checkId,
    problem.artifactId,
    problem.conditionId,
  ]);
}

/** @param {string} status */
function emit(status) {
  listeners.forEach((listener) => listener(status));
}

/** @param {(status: string) => void} listener */
export function onDeletionsChange(listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * A temporary overlay, never a mutation of the persisted check. Successful
 * deletions stay hidden for this page lifetime to cover stale backend reads.
 * @param {DeletedProblem} problem
 * @param {() => Promise<unknown> | void} commit
 */
export function stageDeletion(problem, commit) {
  const id = key(problem);
  if (deletions.has(id)) return null;
  const entry = { problem, status: "pending" };
  deletions.set(id, entry);
  emit("pending");
  return {
    undo() {
      if (entry.status !== "pending") return;
      entry.status = "undone";
      deletions.delete(id);
      emit("undone");
    },
    async save() {
      if (entry.status !== "pending") return;
      entry.status = "saving";
      const artifactKey = JSON.stringify([problem.checkId, problem.artifactId]);
      const previous = saves.get(artifactKey) || Promise.resolve();
      const saving = previous.catch(() => {}).then(commit);
      saves.set(artifactKey, saving);
      try {
        await saving;
        entry.status = "saved";
        emit("saved");
      } catch (error) {
        deletions.delete(id);
        entry.status = "failed";
        emit("failed");
        console.error("save pending deletion failed", error);
        showToast({
          title: "Couldn't delete item",
          message: `“${problem.title || "Item"}” has been restored. Please try again.`,
          icon: "triangle-exclamation",
          tone: "error",
          duration: 0,
        });
      } finally {
        if (saves.get(artifactKey) === saving) saves.delete(artifactKey);
      }
    },
  };
}

/**
 * @param {{checkId?: string, artifactId?: string}} evidence
 * @returns {string[]}
 */
export function pendingDeletedConditionIds({ checkId, artifactId }) {
  if (!artifactId) return [];
  return [...deletions.values()]
    .filter(
      ({ problem }) =>
        problem.artifactId === artifactId &&
        (!checkId || problem.checkId === checkId),
    )
    .map(({ problem }) => problem.conditionId);
}

/** @param {{taskId?: string, checkId?: string, conditionId?: string, sourceArtifactIds?: string[], evidence?: {artifactId?: string}}} task */
export function isTaskPendingDeletion(task) {
  return [...deletions.values()].some(
    ({ problem }) =>
      (problem.taskId && problem.taskId === task.taskId) ||
      (problem.checkId === task.checkId &&
        problem.conditionId === task.conditionId &&
        (task.sourceArtifactIds?.includes(problem.artifactId) ||
          task.evidence?.artifactId === problem.artifactId)),
  );
}
