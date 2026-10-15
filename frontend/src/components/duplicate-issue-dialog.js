import { restartDuplicateChecks } from "../services/photo-analysis.js";
import { getCurrentCheck, updateItemAnalysis } from "../state/check-session.js";
import { TaskSheets } from "./task-sheets.js";
import { awaitOverlayUnwind } from "../dialog-history.js";
import { duplicateDetail } from "./duplicate-issue.templates.js";
import { separateDuplicate } from "../services/api.js";
import { taskMediaUrl } from "../domain/task-media.js";
import { openOverlayDialog } from "../dialog-history.js";
import { t } from "../i18n/i18n.js";
/** @param {Record<string,any>} task @param {HTMLElement} trigger @param {{onSeparated:(task?:Record<string,any>)=>void,onOriginal:(task:Record<string,any>,trigger:HTMLElement)=>void}} handlers */
export function openDuplicateIssue(task, trigger, { onSeparated, onOriginal }) {
  const host = document.createElement("div");
  let busy = false;
  const render = (error = "") => {
    const previous = host.querySelector("dialog");
    const wasOpen = previous?.open;
    host.innerHTML = duplicateDetail(task, taskMediaUrl(task), busy, error);
    const dialog = host.querySelector("dialog");
    if (!dialog) return;
    dialog.addEventListener("close", () => {
      host.remove();
      const fallback = [...document.querySelectorAll("[data-task-id]")]
        .find((card) => card.getAttribute("data-task-id") === task.taskId)
        ?.querySelector("button");
      if (trigger.isConnected) trigger.focus();
      else if (fallback instanceof HTMLElement) fallback.focus();
    });
    host
      .querySelector("[data-duplicate-close]")
      ?.addEventListener("click", () => dialog.close());
    host
      .querySelector("[data-duplicate-original]")
      ?.addEventListener("click", async () => {
        dialog.close();
        await awaitOverlayUnwind(`duplicate-${task.taskId}`);
        onOriginal(task.duplicate.original, trigger);
      });
    host
      .querySelector("[data-duplicate-separate]")
      ?.addEventListener("click", async () => {
        if (busy) return;
        busy = true;
        const button = host.querySelector("[data-duplicate-separate]");
        button?.setAttribute("disabled", "");
        button?.setAttribute("aria-busy", "true");
        try {
          const result = await separateDuplicate(task.taskId, {
            sourceRevision: task.duplicate.sourceRevision,
            originalTaskId: task.duplicate.original.taskId,
          });
          dialog.close();
          onSeparated(result.task);
        } catch {
          busy = false;
          button?.removeAttribute("disabled");
          button?.removeAttribute("aria-busy");
          let message = host.querySelector('[role="alert"]');
          if (!message) {
            message = document.createElement("p");
            message.setAttribute("role", "alert");
            host.querySelector(".duplicate-detail__link")?.append(message);
          }
          message.textContent = t("duplicate.separateError");
        }
      });
    if (wasOpen) previous.close();
    openOverlayDialog(dialog, `duplicate-${task.taskId}`);
  };
  document.body.append(host);
  render();
}

/** @param {Element} button @param {HTMLElement} host */
export function openSessionDuplicate(button, host) {
  const taskId = button.closest("[data-task-id]")?.getAttribute("data-task-id");
  const item = getCurrentCheck()?.items?.find((/** @type {any} */ item) =>
    item.analysis?.tasks?.some(
      (/** @type {any} */ task) => task.taskId === taskId,
    ),
  );
  const task = item?.analysis?.tasks?.find(
    (/** @type {any} */ task) => task.taskId === taskId,
  );
  if (!task?.duplicate || !(button instanceof HTMLElement)) return;
  const sheets = new TaskSheets({ host, container: () => host });
  openDuplicateIssue(task, button, {
    onSeparated: (restored) => {
      updateItemAnalysis(item.id, {
        tasks: item.analysis.tasks.map((/** @type {any} */ task) =>
          task.taskId === taskId
            ? {
                ...(restored || task),
                duplicate: undefined,
                duplicateHidden: false,
              }
            : task,
        ),
      });
      restartDuplicateChecks(item.id);
    },
    onOriginal: (original, trigger) =>
      void sheets.openUpdates(original, trigger),
  });
}
