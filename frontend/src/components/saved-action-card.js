import { homeTabForStatus, homeTaskStatus } from "../domain/home-tasks.js";
import { t } from "../i18n/i18n.js";
import { escapeHtml, html } from "../lib/html.js";
import "./saved-action-card.css";

/**
 * A receipt for an already-persisted action. Never blocks navigation or saving.
 * Cards move automatically after five seconds without requiring another click.
 * @param {HTMLElement} card
 * @param {Record<string, any>} task
 * @param {{signal?: AbortSignal}} [options]
 */
export async function showSavedActionCard(card, task, { signal } = {}) {
  const bounds = card.getBoundingClientRect();
  if (!card.isConnected || bounds.bottom <= 0 || bounds.top >= innerHeight)
    return null;
  const destination = homeTabForStatus(homeTaskStatus(task));
  const moving = destination === "in_progress" || task.customAction?.resolved;
  const children = [...card.children].filter(
    (child) => child instanceof HTMLElement,
  );
  const inert = children.map((child) => child.inert);
  children.forEach((child) => {
    child.inert = true;
  });
  const receipt = document.createElement("div");
  receipt.className = "saved-action-card";
  receipt.innerHTML = html`<wa-icon name="check" aria-hidden="true"></wa-icon>
    <div role="status" aria-atomic="true" data-saved-action-status></div>`;
  card.classList.add("analysis-card--action-saved");
  card.append(receipt);
  const status = receipt.querySelector("[data-saved-action-status]");
  // Populate the live region after mounting it so assistive technology hears it.
  requestAnimationFrame(() => {
    if (!receipt.isConnected) return;
    status.innerHTML = html`<strong
        >${escapeHtml(t("taskDetails.actionSaved"))}</strong
      >
      <span
        >${escapeHtml(
          t(
            destination === "in_progress"
              ? "taskDetails.movingUnresolved"
              : task.customAction?.resolved
                ? "taskDetails.movingResolved"
                : savedActionMessage(task, destination),
          ),
        )}${moving
          ? html`<span class="ellipsis-dots" aria-hidden="true"
              ><span>.</span><span>.</span><span>.</span></span
            >`
          : ""}</span
      >`;
  });
  try {
    await new Promise((resolve) => {
      const observer = new MutationObserver(() => {
        if (!card.isConnected) finish();
      });
      const finish = () => {
        clearTimeout(timer);
        observer.disconnect();
        signal?.removeEventListener("abort", finish);
        resolve(undefined);
      };
      const timer = setTimeout(finish, 5000);
      observer.observe(document.body, { childList: true, subtree: true });
      signal?.addEventListener("abort", finish, { once: true });
      if (signal?.aborted) finish();
    });
    if (!signal?.aborted && card.isConnected) await collapseSavedCard(card);
    return { destination, viewRequested: false };
  } finally {
    receipt.remove();
    card.classList.remove("analysis-card--action-saved");
    children.forEach((child, index) => {
      child.inert = inert[index];
    });
  }
}

/** CSS owns intrinsic sizing, spacing and reduced motion. */
async function collapseSavedCard(card) {
  const shell = document.createElement("div");
  const clip = document.createElement("div");
  shell.className = "saved-action-exit";
  card.before(shell);
  shell.append(clip);
  clip.append(card);
  card.inert = true;
  await Promise.allSettled(
    shell.getAnimations().map((animation) => animation.finished),
  );
  shell.remove();
}

/** @param {Record<string, any>} task @param {string} [destination] */
export function savedActionMessage(
  task,
  destination = homeTabForStatus(homeTaskStatus(task)),
) {
  if (destination === "in_progress") return "taskDetails.savedUnresolved";
  return task.customAction?.resolved
    ? "taskDetails.savedResolved"
    : "taskDetails.savedUnresolvedHistory";
}
