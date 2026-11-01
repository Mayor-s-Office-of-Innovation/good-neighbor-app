import { answerAnalysisQuestion } from "../services/photo-analysis.js";
import { showAnswerSaveErrorToast } from "../state/toasts.js";
import {
  finishQuestionAnswerFocus,
  setQuestionAnswerBusy,
  showQuestionAnswerUpdated,
} from "./analysis-answer-controls.js";

/** Shared capture answer lifecycle: hold the card until confirmation finishes.
 * @param {HTMLElement & {_answeringConditionIds: Map<string, {itemId: string, conditionId: string, confirmed?: boolean}>, _render: () => void}} view
 * @param {{itemId?: string, conditionId?: string}} problem
 * @param {Element} button
 */
export async function answerCaptureQuestion(view, problem, button) {
  if (!(button instanceof HTMLButtonElement)) return;
  const answerKey = button.getAttribute("data-answer-key") || "";
  const answerValue = button.getAttribute("data-answer-value") === "true";
  if (!problem.itemId || !problem.conditionId || !answerKey) {
    showAnswerSaveErrorToast();
    return;
  }
  const identity = JSON.stringify([problem.itemId, problem.conditionId]);
  if (view._answeringConditionIds.has(identity)) return;

  view._answeringConditionIds.set(identity, {
    itemId: problem.itemId,
    conditionId: problem.conditionId,
  });
  setQuestionAnswerBusy(view, problem.conditionId, true, {
    itemId: problem.itemId,
  });
  let confirmationPending = false;
  const finish = (confirmed = false) => {
    if (confirmed) {
      finishQuestionAnswerFocus(view, problem.conditionId, {
        itemId: problem.itemId,
      });
      // Keep the accepted question locked until the batch can render. Another
      // answer's confirmation may still be holding the original DOM in place.
      const entry = view._answeringConditionIds.get(identity);
      if (entry) entry.confirmed = true;
    } else {
      view._answeringConditionIds.delete(identity);
      setQuestionAnswerBusy(view, problem.conditionId, false, {
        itemId: problem.itemId,
      });
    }
    if (
      [...view._answeringConditionIds.values()].some(
        (entry) => !entry.confirmed,
      )
    )
      return;
    view._answeringConditionIds.clear();
    if (view.isConnected) view._render();
  };
  try {
    await answerAnalysisQuestion(
      problem.itemId,
      problem.conditionId,
      answerKey,
      answerValue,
    );
    showQuestionAnswerUpdated(view, problem.conditionId, {
      itemId: problem.itemId,
      onComplete: () => finish(true),
    });
    confirmationPending = true;
  } catch (err) {
    console.error("answer condition failed", err);
    showAnswerSaveErrorToast();
  } finally {
    if (!confirmationPending) finish();
  }
}
