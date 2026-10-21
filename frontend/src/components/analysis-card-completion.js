import { savePhoneCompletion } from "../services/phone-completion.js";
import { completeTask } from "../services/api.js";
import { showActionSaveErrorToast } from "../state/toasts.js";

const pending = new Map();
/** Results prompts open one at a time, in tap order. */
let dialogQueue = Promise.resolve();

/** Keep cards mounted while a save or exit animation is active. */
export function isCompletingAnalysisCard(host) {
  return [...pending.values()].some(
    (state) => state.host === host || host.contains(state.host),
  );
}

/**
 * Record the checklist action the moment it is tapped, then animate a
 * confirmed save. `task` is the card's backend record when known; it lets
 * the results prompt open at tap time instead of after the response.
 */
export function toggleCardCompletion(
  host,
  card,
  button,
  { onSaved, render, task = null },
) {
  const phoneNumber = button.getAttribute("data-phone-number");
  const isPhone = Boolean(phoneNumber);
  if (isPhone && !window.matchMedia("(max-width: 520px)").matches) return;
  // The request is already out: a second tap has nothing to undo.
  if (pending.has(card)) return;
  const controls = [...card.querySelectorAll("button")]
    .filter((control) => control !== button)
    .map((control) => [control, control.disabled]);
  controls.forEach(([control]) => {
    control.disabled = true;
  });
  if (!isPhone) button.setAttribute("aria-checked", "true");
  button.disabled = true;
  card.setAttribute("aria-busy", "true");
  pending.set(card, { host });
  const taskId = card.getAttribute("data-task-id");
  const save = async () => {
    let saved = false;
    try {
      if (!taskId) throw new Error("Task is not ready to complete");
      const result = await (isPhone
        ? savePhoneCompletion(taskId, host._site?.siteId)
        : completeCardAction(taskId, { completionMethod: "manual" }, { task }));
      if (
        !["completed", "in_progress", "cannot_do"].includes(
          result?.task?.status,
        )
      )
        throw new Error("Task completion was not confirmed");
      saved = true;
      // Confirmed: the busy spinner (an infinite animation) must stop before
      // the slide, which waits for every animation under the card to finish.
      card.removeAttribute("aria-busy");
      if (card.isConnected) await slideCompletedCard(card);
      onSaved(result.task);
    } catch (error) {
      console.error("checklist completion failed", error);
      if (!saved && !isPhone) {
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
        if (shouldFocus) focusChecklistControl(host, taskId);
      }
    }
  };
  void save();
  // The receipt is already persisting; a suspended request is recovered on
  // return/reload without delaying the call. Only a plain digit string may
  // reach the dialer: the number is read from a DOM attribute, so it is
  // reduced to digits and checked against a fixed shape before navigation.
  if (isPhone) {
    const digits = phoneNumber.replace(/\D/g, "");
    if (/^\d{3,15}$/.test(digits)) window.location.href = `tel:${digits}`;
  }
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
  // Only finite animations can finish: a looping one (a busy spinner left on
  // a descendant) would hold the card on screen forever.
  await Promise.allSettled(
    shell
      .getAnimations({ subtree: true })
      .filter((animation) =>
        Number.isFinite(animation.effect?.getTiming().iterations ?? 1),
      )
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

/**
 * Mirrors the backend rule for `resultsPending`: a manual completion of a
 * task that cannot go "in progress" opens a documentation window.
 */
export function expectsCompletionResults(task, body) {
  return body?.completionMethod === "manual" && task?.canBeInProgress === false;
}

/**
 * Complete a card action, then collect optional results before removing the
 * card. With `task` (the card's record) the results prompt opens at tap time,
 * naming the card, while the request is still in flight; its save waits for
 * the response. Without it the prompt opens once the response says results
 * are pending.
 */
export async function completeCardAction(taskId, body, { task = null } = {}) {
  const request = completeTask(taskId, body);
  if (task && expectsCompletionResults(task, body)) {
    const completion = request.then(
      (result) => ({ task: result?.resultsPending ? result.task : null }),
      () => ({ task: null, failed: true }),
    );
    await showResultsDialog(task, completion);
    return request;
  }
  const result = await request;
  if (result.resultsPending) await showResultsDialog(result.task, null);
  return result;
}

function showResultsDialog(task, completion) {
  const turn = dialogQueue.then(() => openResultsDialog(task, completion));
  dialogQueue = turn.catch(() => {});
  return turn;
}

async function openResultsDialog(task, completion) {
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
    dialog.openResults(task, completion);
  });
}
