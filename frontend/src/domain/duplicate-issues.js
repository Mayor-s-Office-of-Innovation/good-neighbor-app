import { hasSubmitted311Ticket } from "./task-actions.js";
import { duplicateUiEnabled } from "../services/feature-flags.js";
/** @typedef {Record<string, any>} Issue */
/** Derive presentation from the original's current action state; never discard evidence.
 * @param {Issue[]} tasks @param {Map<string, Issue>} links @param {number} [now]
 * @returns {Issue[]}
 */
export function projectDuplicateTasks(tasks, links, now = Date.now()) {
  if (!duplicateUiEnabled())
    return tasks.map((task) => ({
      ...task,
      duplicate: undefined,
      duplicateHidden: false,
      duplicateCheckState: undefined,
    }));
  const all = new Map(tasks.map((t) => [t.taskId, t]));
  const sourceIds = new Set(tasks.map((task) => task.taskId));
  for (const [sourceId, link] of links)
    if (sourceIds.has(sourceId) && link.state === "matched" && link.original) {
      const current = all.get(link.original.taskId);
      // A cached link must not undo a newer filing/worklist response.
      const latest =
        current?.updatedAt &&
        (!link.original.updatedAt ||
          current.updatedAt > link.original.updatedAt)
          ? current
          : link.original;
      const merged = { ...current, ...link.original, ...latest };
      if (current?.updatedAt === link.original.updatedAt) {
        // Background integration writes do not advance the task timestamp.
        // Keep the newest integration snapshot, including its summary status.
        const currentResults = current?.appActionResults || [];
        const linkedResults = link.original.appActionResults || [];
        const integration =
          integrationTime(currentResults) > integrationTime(linkedResults) ||
          (currentResults.length > 0 && linkedResults.length === 0)
            ? current
            : link.original;
        merged.appActionResults = integration.appActionResults || [];
        merged.appActionStatus = integration.appActionStatus;
      }
      all.set(link.original.taskId, merged);
    }
  const sightings = new Map();
  for (const [sourceId, link] of links) {
    if (
      link.state !== "matched" ||
      !link.original ||
      sourceId === link.original.taskId
    )
      continue;
    const ids =
      sightings.get(link.original.taskId) || new Set([link.original.taskId]);
    ids.add(sourceId);
    sightings.set(link.original.taskId, ids);
  }
  return [...all.values()].flatMap((task) => {
    const link = links.get(task.taskId);
    if (link?.state !== "matched")
      return [
        {
          ...task,
          duplicate: undefined,
          duplicateSeenCount: sightings.get(task.taskId)?.size || 1,
          duplicateCheckState: link?.state,
        },
      ];
    const original = all.get(link.original.taskId) ?? link.original;
    const acted = original.status !== "open";
    const actionAt = Date.parse(
      original.inProgressAt || original.completedAt || original.updatedAt || "",
    );
    const reportedAt = Date.parse(link.generatedAt || task.createdAt || "");
    // A filed group has one actionable original, even when a related
    // observation arrived after the filing started.
    if (
      hasSubmitted311Ticket(original) &&
      original.inProgressActionKind === "311_filed"
    )
      return [];
    const compact =
      acted &&
      task.status === "open" &&
      original.status === "in_progress" &&
      reportedAt > actionAt &&
      now - reportedAt < 3 * 60 * 60 * 1000;
    if (acted && !compact) return [];
    const sharedActions = acted
      ? {}
      : Object.fromEntries(
          [
            "buttons",
            "appActions",
            "guidance",
            "kind",
            "phoneNumber",
            "canBeInProgress",
          ].map((key) => [key, original[key]]),
        );
    return [
      {
        ...task,
        ...sharedActions,
        duplicateSeenCount: 1,
        duplicateCheckState: "matched",
        duplicate: {
          original,
          compact,
          detectedAt: link.detectedAt,
          sourceRevision: link.sourceRevision,
        },
      },
    ];
  });
}
/** @param {Issue[]} tasks */
export function duplicateCounts(tasks) {
  const duplicate = tasks.filter((t) => t.duplicate).length;
  return { newCount: tasks.length - duplicate, duplicateCount: duplicate };
}

/** @param {Array<{recordedAt?: string}>} results */
function integrationTime(results) {
  return results.reduce(
    (latest, result) =>
      result.recordedAt && result.recordedAt > latest
        ? result.recordedAt
        : latest,
    "",
  );
}
