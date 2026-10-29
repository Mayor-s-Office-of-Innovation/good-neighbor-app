import { savePhoneCompletion } from "../services/phone-completion.js";
import { getSite } from "../db.js";
import { completeTask } from "../services/api.js";
import { showActionSaveErrorToast } from "../state/toasts.js";

const pending = new Map();
/** One save per site/task, independent of card elements. */
const operations = new Map();

/** Keep cards mounted while a save or exit animation is active. */
export function isCompletingAnalysisCard(host) {
  return [...pending.values()].some(
    (state) => state.host === host || host.contains(state.host),
  );
}

/** Hold the card through its save and exit animation. */
export function holdCompletionCard(host, card) {
  const key = card || {};
  pending.set(key, { host });
  return () => pending.delete(key);
}

/**
 * Record the checklist action the moment it is tapped, then animate a
 * confirmed save. Proof is collected separately from History.
 */
export function toggleCardCompletion(
  host,
  card,
  button,
  { onSaved, render, ...options },
) {
  void options; // Existing hosts may pass their task snapshot.
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
        : completeCardAction(taskId, { completionMethod: "manual" }));
      if (!["completed", "in_progress"].includes(result?.task?.status))
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

/** Save once per site/task; the caller runs the normal exit animation. */
export async function completeCardAction(taskId, body) {
  const siteId = (await getSite())?.siteId || "";
  const key = JSON.stringify([siteId, taskId]);
  if (operations.has(key)) return operations.get(key);
  const operation = completeAction(taskId, body, siteId);
  operations.set(key, operation);
  try {
    return await operation;
  } finally {
    operations.delete(key);
  }
}

async function completeAction(taskId, body, siteId) {
  return completeTask(taskId, body, { originSiteId: siteId });
}
