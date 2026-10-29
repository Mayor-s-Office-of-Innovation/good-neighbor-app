import { listPendingGuidance } from "./api.js";

/** Read every bounded page, including empty filtered pages. */
export async function loadPendingQuestionItems() {
  const items = new Map();
  const seen = new Set();
  let nextToken = null;
  do {
    const page = await listPendingGuidance(nextToken);
    for (const { assessment, conditions } of page.guidance || []) {
      for (const condition of conditions || []) {
        const id = `pending:${assessment.assessmentId}:${condition.conditionId}`;
        items.set(id, {
          id,
          kind: "text",
          checkId: assessment.checkId,
          createdAt: condition.createdAt,
          analysis: {
            status: "analyzed",
            checkId: assessment.checkId,
            artifactId: condition.source?.artifactIds?.[0] || "",
            assessment,
            conditions: [condition],
            tasks: [],
          },
        });
      }
    }
    nextToken = page.nextToken || null;
    if (nextToken && seen.has(nextToken))
      throw new Error("Repeated guidance cursor");
    if (nextToken) seen.add(nextToken);
  } while (nextToken);
  return [...items.values()];
}

/** Keep local in-flight results, but render server-backed cards only once.
 * @param {any[]} localItems @param {any[]} pendingItems @param {any[]} tasks
 */
export function mergePendingQuestionItems(localItems, pendingItems, tasks) {
  const questionKeys = new Set(
    pendingItems.flatMap((item) =>
      item.analysis.conditions.map(
        (condition) =>
          `${item.analysis.assessment.assessmentId}:${condition.conditionId}`,
      ),
    ),
  );
  const merged = localItems.flatMap((item) => {
    if (item.analysis?.status !== "analyzed") return [item];
    const analysis = item.analysis;
    const represented = (conditionId) =>
      tasks.some(
        (task) =>
          task.conditionId === conditionId &&
          task.assessmentId === analysis.assessment?.assessmentId,
      );
    const conditions = (analysis.conditions || []).filter(
      (condition) =>
        !["completed", "rejected"].includes(condition.status) &&
        !questionKeys.has(
          `${analysis.assessment?.assessmentId}:${condition.conditionId}`,
        ) &&
        !represented(condition.conditionId),
    );
    const localTasks = (analysis.tasks || []).filter(
      (task) => !tasks.some((saved) => saved.taskId === task.taskId),
    );
    if (
      (analysis.conditions?.length || analysis.tasks?.length) &&
      !conditions.length &&
      !localTasks.length
    )
      return [];
    return [
      { ...item, analysis: { ...analysis, conditions, tasks: localTasks } },
    ];
  });
  return [...merged, ...pendingItems];
}
