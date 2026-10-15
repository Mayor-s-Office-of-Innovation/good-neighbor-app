import { completeTask } from "../services/api.js";
import { showActionSaveErrorToast } from "../state/toasts.js";

const pending = new Map();

/** Keep cards mounted while the undo window, save, or exit animation is active. */
export function isCompletingAnalysisCard(host) {
  return [...pending.values()].some(
    (state) => state.host === host || host.contains(state.host),
  );
}

/** Record the checklist action only after its cancellable hold, then animate a confirmed save. */
export function toggleCardCompletion(host, card, button, { onSaved, render }) {
  const previous = pending.get(card);
  if (previous) {
    if (previous.saving) return;
    clearTimeout(previous.timer);
    pending.delete(card);
    button.setAttribute("aria-checked", "false");
    previous.controls.forEach(([control, disabled]) => {
      control.disabled = disabled;
    });
    if (!isCompletingAnalysisCard(host)) {
      const restoreFocus = document.activeElement === button;
      void Promise.resolve(render()).then(() => {
        if (restoreFocus)
          focusChecklistControl(host, card.getAttribute("data-task-id"));
      });
    }
    return;
  }
  const controls = [...card.querySelectorAll("button")]
    .filter((control) => control !== button)
    .map((control) => [control, control.disabled]);
  controls.forEach(([control]) => {
    control.disabled = true;
  });
  button.setAttribute("aria-checked", "true");
  const state = { host, saving: false, controls, timer: null };
  pending.set(card, state);
  state.timer = setTimeout(async () => {
    let saved = false;
    try {
      if (!card.isConnected) return;
      state.saving = true;
      button.disabled = true;
      card.setAttribute("aria-busy", "true");
      const taskId = card.getAttribute("data-task-id");
      if (!taskId) throw new Error("Task is not ready to complete");
      const result = await completeCardAction(taskId, {
        completionMethod: "manual",
      });
      if (
        !["completed", "in_progress", "cannot_do"].includes(
          result?.task?.status,
        )
      )
        throw new Error("Task completion was not confirmed");
      saved = true;
      if (card.isConnected) await slideCompletedCard(card);
      onSaved(result.task);
    } catch (error) {
      console.error("checklist completion failed", error);
      if (!saved) {
        button.setAttribute("aria-checked", "false");
        showActionSaveErrorToast();
      }
    } finally {
      pending.delete(card);
      card.removeAttribute("aria-busy");
      button.disabled = false;
      controls.forEach(([control, disabled]) => {
        control.disabled = disabled;
      });
      if (host.isConnected && !isCompletingAnalysisCard(host)) {
        const shouldFocus =
          document.activeElement === button ||
          document.activeElement === document.body;
        await render();
        if (shouldFocus)
          focusChecklistControl(host, card.getAttribute("data-task-id"));
      }
    }
  }, 1500);
}

/** CSS controls simultaneous height/gap collapse and slide, without opacity changes. */
export async function slideCompletedCard(card) {
  const shell = document.createElement("div");
  const clip = document.createElement("div");
  shell.className = "analysis-card--completing";
  clip.className = "analysis-card__completion-clip";
  card.before(shell);
  shell.append(clip);
  clip.append(card);
  card.inert = true;
  await Promise.allSettled(
    shell
      .getAnimations({ subtree: true })
      .map((animation) => animation.finished),
  );
  shell.remove();
}

function focusChecklistControl(host, taskId) {
  const cards = [...(host.querySelectorAll?.(".analysis-card") || [])];
  const targetCard =
    cards.find((card) => card.getAttribute("data-task-id") === taskId) ||
    cards[0];
  const control =
    targetCard?.querySelector(
      '[role="checkbox"], [data-action], [data-analysis-action="resolve"]',
    ) || host.querySelector(".home-tabs__tab--active, h2");
  if (!control) return;
  if (control.tagName === "H2") control.setAttribute("tabindex", "-1");
  control.focus({ preventScroll: true });
}

/** Complete a card action, then collect optional results before removing the card. */
export async function completeCardAction(taskId, body) {
  const result = await completeTask(taskId, body);
  const task = result?.task;
  if (result.resultsPending) {
    await import("./task-update-dialog.js");
    await new Promise((resolve) => {
      const dialog =
        /** @type {import("./task-update-dialog.js").TaskUpdateDialog} */ (
          document.createElement("task-update-dialog")
        );
      dialog.addEventListener(
        "taskupdateclosed",
        () => {
          dialog.remove();
          resolve(undefined);
        },
        { once: true },
      );
      document.body.append(dialog);
      dialog.openResults(task);
    });
  }
  return result;
}
