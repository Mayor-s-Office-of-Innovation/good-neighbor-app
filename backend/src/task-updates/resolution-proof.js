import { readUpdateById } from "./task-update-store.js";

/** @param {Record<string, any>} task */
export function canAddResolutionProof(task) {
  return (
    task.status === "completed" &&
    (task.canBeInProgress === false ||
      task.completionMethod === "site_team_resolved" ||
      task.latestUpdateLabel === "Resolved" ||
      Boolean(task.resolvedAt || task.resolved_at))
  );
}

/** Recognize legacy evidence attached to the completion, never earlier updates.
 * Saved proof carries the summary directly, avoiding additional worklist reads.
 * @param {string} table @param {string} siteId @param {Record<string, any>} task
 */
export async function withResolutionProof(table, siteId, task) {
  if (!canAddResolutionProof(task) || task.proofAddedAt) return task;
  const update = task.latestUpdateId
    ? await readUpdateById(table, siteId, task.taskId, task.latestUpdateId)
    : null;
  const completion =
    update &&
    [
      "issue_resolved",
      "presence_resolved",
      "additional_action_resolved",
      "task_completed",
      "resolution_proof",
      ...(task.canBeInProgress === false
        ? ["311_ticket_filed", "escalation_action_taken"]
        : []),
    ].includes(update.type);
  const hasContent =
    completion &&
    ((update.notes || []).some((/** @type {unknown} */ note) =>
      String(note).trim(),
    ) ||
      update.photoKeys?.length);
  return {
    ...task,
    proofAddedAt: hasContent ? update.documentedAt || update.occurredAt : null,
  };
}

/** Enrich list responses without unbounded concurrent legacy lookups.
 * @param {string} table @param {string} siteId @param {Record<string, any>[]} tasks
 */
export async function withResolutionProofForTasks(table, siteId, tasks) {
  const result = [];
  for (let i = 0; i < tasks.length; i += 10)
    result.push(
      ...(await Promise.all(
        tasks
          .slice(i, i + 10)
          .map((task) => withResolutionProof(table, siteId, task)),
      )),
    );
  return result;
}
