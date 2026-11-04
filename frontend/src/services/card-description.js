import { editAnalysisCondition, updateTaskAction } from "./api.js";
import {
  getCurrentCheck,
  getCheck as getHeldCheck,
  updateItemAnalysis,
} from "../state/check-session.js";

/** Save an observation correction without analysis or guidance evaluation.
 * @param {Record<string, any>} problem @param {string} description
 */
export async function saveCardDescription(problem, description) {
  if (problem.taskId)
    await updateTaskAction(problem.taskId, undefined, description);
  else
    await editAnalysisCondition(
      problem.checkId,
      problem.artifactId,
      problem.conditionId || "__summary__",
      { description },
    );
  const current = getCurrentCheck();
  const check =
    current?.id === problem.checkId ? current : getHeldCheck(problem.checkId);
  const item = check?.items?.find((entry) => entry.id === problem.itemId);
  if (!item?.analysis) return;
  const patch = (record) =>
    record.conditionId === problem.conditionId
      ? { ...record, description, descriptionEdited: true }
      : record;
  updateItemAnalysis(item.id, {
    ...(!problem.conditionId
      ? {
          noIssuesDescription: description,
          sourceAnalysis: {
            ...item.analysis.sourceAnalysis,
            gradeDescription: description,
            descriptionEdited: true,
          },
        }
      : {}),
    conditions: (item.analysis.conditions || []).map(patch),
    tasks: (item.analysis.tasks || []).map((task) =>
      !problem.taskId || task.taskId === problem.taskId ? patch(task) : task,
    ),
  });
}

/** Reflect a saved edit in a held capture session without another analysis.
 * @param {Record<string,any>} problem @param {Record<string,any>} result
 * @param {Record<string,any>} fields
 */
export function syncCardDetails(problem, result, fields) {
  const current = getCurrentCheck();
  const check =
    current?.id === problem.checkId ? current : getHeldCheck(problem.checkId);
  const item = check?.items?.find((entry) => entry.id === problem.itemId);
  if (!item?.analysis) return;
  const patch = {
    description: fields.description,
    descriptionEdited: true,
    ...(fields.title !== undefined
      ? { userFriendlyLabel: fields.title, titleEdited: true }
      : {}),
  };
  const sharedActionPatch = result.task
    ? Object.fromEntries(
        [
          "category",
          "actionOverride",
          "buttons",
          "appActions",
          "appActionStatus",
          "appActionResults",
          "guidance",
          "kind",
          "type",
          "label",
          "phoneNumber",
          "category311",
          "canBeInProgress",
          "primaryInProgressAgency",
          "maxAcceptableResponseHours",
        ]
          .filter((key) => result.task[key] !== undefined)
          .map((key) => [key, result.task[key]]),
      )
    : {};
  const tasks = (item.analysis.tasks || []).map((task) =>
    task.taskId === result.task?.taskId
      ? result.task
      : task.taskId === problem.taskId
        ? { ...task, ...sharedActionPatch, ...patch }
        : task,
  );
  if (
    result.task &&
    !problem.taskId &&
    !tasks.some((task) => task.taskId === result.task.taskId)
  )
    tasks.push(result.task);
  updateItemAnalysis(item.id, {
    ...(result.assessment ? { assessment: result.assessment } : {}),
    conditions: (item.analysis.conditions || []).map((condition) =>
      condition.conditionId === problem.conditionId
        ? { ...condition, ...patch, ...(result.condition || {}) }
        : condition,
    ),
    tasks,
  });
}
