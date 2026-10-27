import { TaskSheets } from "./task-sheets.js";
import { getItems, resolveConditionLocally } from "../state/check-session.js";
import { showTaskUpdateErrorToast } from "../state/toasts.js";

/** @type {WeakMap<HTMLElement, TaskSheets>} */
const sheets = new WeakMap();
/** @param {HTMLElement} host @param {import("./analysis-problem-actions.js").CardProblem} problem @param {HTMLElement} trigger */
export function resolveSessionTask(host, problem, trigger) {
  const task = getItems()
    .flatMap((item) => item.analysis?.tasks || [])
    .find((task) => task.taskId === problem.taskId);
  if (!task) {
    showTaskUpdateErrorToast(new Error("Task unavailable"));
    return;
  }
  let controller = sheets.get(host);
  if (!controller) {
    controller = new TaskSheets({
      host,
      container: () => host,
      onTaskUpdated: (saved) => {
        resolveConditionLocally({
          itemId: saved.itemId,
          taskId: saved.taskId,
          conditionId: saved.conditionId,
        });
      },
    });
    sheets.set(host, controller);
  }
  // Evidence tasks need their item coordinates when reconciling the session.
  void controller.openUpdates(
    { ...task, itemId: problem.itemId, conditionId: problem.conditionId },
    trigger,
    "resolve",
  );
}
