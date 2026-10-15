/** @typedef {Record<string, any>} Issue */
/** Derive presentation from the original's current action state; never discard evidence.
 * @param {Issue[]} tasks @param {Map<string, Issue>} links @param {number} [now]
 * @returns {Issue[]}
 */
export function projectDuplicateTasks(tasks, links, now = Date.now()) {
  const all = new Map(tasks.map((t) => [t.taskId, t]));
  const sourceIds = new Set(tasks.map((task) => task.taskId));
  for (const [sourceId, link] of links)
    if (sourceIds.has(sourceId) && link.state === "matched" && link.original)
      all.set(link.original.taskId, {
        ...all.get(link.original.taskId),
        ...link.original,
      });
  return [...all.values()].flatMap((task) => {
    const link = links.get(task.taskId);
    if (link?.state !== "matched")
      return [
        { ...task, duplicate: undefined, duplicateCheckState: link?.state },
      ];
    const original = all.get(link.original.taskId) ?? link.original;
    const acted = original.status !== "open";
    const actionAt = Date.parse(
      original.inProgressAt || original.completedAt || original.updatedAt || "",
    );
    const reportedAt = Date.parse(link.generatedAt || task.createdAt || "");
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
            "canBeInProgress",
            "cannotDoReasons",
          ].map((key) => [key, original[key]]),
        );
    return [
      {
        ...task,
        ...sharedActions,
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
