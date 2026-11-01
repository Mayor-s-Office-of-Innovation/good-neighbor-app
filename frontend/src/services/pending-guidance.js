import { hydratePendingQuestionEvidence } from "./task-evidence.js";
import { listPendingGuidance, getAssessmentGuidance } from "./api.js";

/** Read every bounded page, including empty filtered pages.
 * @param {(items: any[]) => void} [onPage]
 * @param {() => boolean} [shouldContinue]
 */
export async function loadPendingQuestionItems(
  onPage,
  shouldContinue = () => true,
) {
  const items = new Map();
  const seen = new Set();
  let nextToken = null;
  do {
    if (!shouldContinue()) break;
    const page = await listPendingGuidance(nextToken);
    if (!shouldContinue()) break;
    for (const { assessment, conditions } of page.guidance || []) {
      for (const condition of conditions || []) {
        const id = `pending:${assessment.assessmentId}:${condition.conditionId}`;
        items.set(id, {
          id,
          kind: "unknown",
          evidenceArtifactId: condition.activeArtifactId,
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
    onPage?.([...items.values()]);
    if (items.size) {
      const hydrated = await hydratePendingQuestionEvidence([
        ...items.values(),
      ]);
      if (!shouldContinue()) return [];
      const changed = hydrated.some((item) => items.get(item.id) !== item);
      for (const item of hydrated) items.set(item.id, item);
      if (changed) onPage?.(hydrated);
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
  const questions = pendingItems.map((item) => {
    const artifactId = item.analysis?.artifactId;
    const local = localItems.find(
      (candidate) =>
        artifactId &&
        (candidate.analysis?.artifactId || candidate.upload?.artifactId) ===
          artifactId,
    );
    if (!local) return item;
    // Keep server guidance authoritative while retaining the captured preview.
    return {
      ...item,
      kind: local.kind || item.kind,
      ...(local.media
        ? { media: local.media, checkId: local.checkId || item.checkId }
        : {}),
      dataUrl: local.dataUrl || item.dataUrl,
      fullDataUrl: local.fullDataUrl || item.fullDataUrl,
      placeName: local.placeName || item.placeName,
      georeferencedAddress:
        local.georeferencedAddress || item.georeferencedAddress,
    };
  });
  return [...merged, ...questions];
}

/** Revalidate server-backed local evidence without waiting for historical pagination.
 * Four concurrent reads bound load even for a retained check with many artifacts.
 * Failed reads propagate: the caller keeps unverified cards non-actionable.
 * @param {any[]} items
 * @param {() => boolean} [shouldContinue]
 */
export async function reconcileLocalGuidance(
  items,
  shouldContinue = () => true,
) {
  const originals = items.map((item) => ({
    item,
    assessmentId: item.analysis?.assessment?.assessmentId,
    revision: item.analysis?.assessment?.assessmentRevision || 0,
  }));
  const ids = [
    ...new Set(
      originals.map(({ assessmentId }) => assessmentId).filter(Boolean),
    ),
  ];
  const guidance = new Map();
  for (let start = 0; start < ids.length; start += 4) {
    if (!shouldContinue()) return [];
    await Promise.all(
      ids.slice(start, start + 4).map(async (id) => {
        try {
          guidance.set(id, await getAssessmentGuidance(id));
        } catch (error) {
          if (error?.status !== 404) throw error;
          guidance.set(id, null);
        }
      }),
    );
  }
  return originals.flatMap(({ item, assessmentId: id, revision }) => {
    if (!id) return [item];
    // An answer or edit can advance the held item during the read. Never
    // mistake that new identity for a missing assessment or roll it back.
    const held = item.analysis?.assessment;
    if (held?.assessmentId !== id || (held?.assessmentRevision || 0) > revision)
      return [item];
    const current = guidance.get(id);
    if (
      current?.assessment?.assessmentId === id &&
      (current.assessment.assessmentRevision || 0) <
        (held?.assessmentRevision || 0)
    )
      return [item];
    if (!current?.assessment) return [];
    return [{ ...item, analysis: { ...item.analysis, ...current } }];
  });
}
