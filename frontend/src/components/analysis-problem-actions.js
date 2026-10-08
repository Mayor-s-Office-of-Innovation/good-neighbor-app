/*
  analysis-problem-actions — the pieces of the analysis-card action flows that
  today-view, perimeter-check, and problem-report share verbatim: reading a
  problem off a card, the "can't act on this card" copy, and the reject
  (delete) round trip with its local-fallback rules.

  The rest of each flow (edit, resolve, answer) deliberately stays in the
  elements: they differ in how failures surface (inline error vs toast vs
  local delete) and how they refresh afterwards (re-render vs full reload).
*/
import { ApiError, rejectAnalysisCondition } from "../services/api.js";
import { refreshEvidenceAnalysis } from "../services/photo-analysis.js";
import { getCurrentCheck } from "../state/check-session.js";
import { t } from "../i18n/i18n.js";

/**
 * @typedef {object} CardProblem
 * @property {string} itemId
 * @property {string} checkId
 * @property {string} artifactId
 * @property {string} taskId
 * @property {string} conditionId
 * @property {string} actionKind
 * @property {string} title
 * @property {string} description
 */

/**
 * Read the problem coordinates an analysis card carries in its data-* attrs.
 * @param {Element} card
 * @returns {CardProblem}
 */
export function problemFromCard(card) {
  return {
    itemId: card.getAttribute("data-item-id") || "",
    checkId: card.getAttribute("data-check-id") || "",
    artifactId: card.getAttribute("data-artifact-id") || "",
    taskId: card.getAttribute("data-task-id") || "",
    conditionId: card.getAttribute("data-condition-id") || "",
    actionKind: card.getAttribute("data-action-kind") || "",
    title:
      card.getAttribute("data-card-title") || t("card.title.problemFallback"),
    description: card.getAttribute("data-card-description") || "",
  };
}

/**
 * Why a card cannot be deleted / edited: no condition behind it, or a
 * condition whose evidence coordinates are missing.
 * @param {{ conditionId?: string }} problem
 * @param {"deleted" | "edited"} action which flow was attempted; selects the
 *   sentence (each is a whole translated sentence, not a verb spliced in)
 * @returns {string}
 */
export function missingConditionMessage(problem, action) {
  if (!problem.conditionId) {
    return t(`analysis.missingCondition.noCondition.${action}`);
  }
  return t(`analysis.missingCondition.noCoordinates.${action}`);
}

/**
 * Reject a condition on the backend, then reconcile the local session:
 * - 404 (already gone): drop it locally if this is the current check
 * - no assessment in the reply: drop it locally
 * - otherwise refresh the item's analysis from the reply; if that refresh
 *   fails, hand off to `onRefreshFailure`
 * Any other API error propagates to the caller's dialog error handling.
 * @param {CardProblem} problem
 * @param {{ requestId: string, deleteLocally: () => void, onRefreshFailure: () => void }} handlers
 */
export async function rejectProblemCondition(
  problem,
  { requestId, deleteLocally, onRefreshFailure },
) {
  let result;
  try {
    result = await rejectAnalysisCondition(
      problem.checkId,
      problem.artifactId,
      problem.conditionId,
      {
        reason: { key: "not_a_problem" },
        ...(problem.taskId ? { taskId: problem.taskId } : {}),
        caller: { request_id: requestId },
      },
    );
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 404) throw err;
    if (getCurrentCheck()?.id === problem.checkId) deleteLocally();
    return;
  }
  if (!result?.assessment) {
    deleteLocally();
    return;
  }
  if (getCurrentCheck()?.id === problem.checkId && problem.itemId) {
    await refreshEvidenceAnalysis(problem.itemId, result, {
      rejectedConditionId: problem.conditionId,
    }).catch((error) => {
      console.error("refresh after saved deletion failed", error);
      onRefreshFailure();
    });
  }
}
