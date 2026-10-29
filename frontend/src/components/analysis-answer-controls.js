import { t } from "../i18n/i18n.js";
import { html, escapeHtml } from "../lib/html.js";

/** @type {WeakMap<object, Map<string, { finish: () => void }>>} */
const focusSessions = new WeakMap();

/** Keep ownership only while focus remains in this answer's replacement UI.
 * @param {Document | HTMLElement | ShadowRoot} root @param {string} conditionId
 */
function trackAnswerFocus(root, conditionId) {
  const doc = root.ownerDocument;
  if (!doc) return;
  const active = doc.activeElement;
  if (
    !(active instanceof HTMLButtonElement) ||
    active.getAttribute("data-condition-id") !== conditionId ||
    !active.matches('[data-analysis-action="answer"]')
  )
    return;
  const answerValue = active.getAttribute("data-answer-value");
  let target = /** @type {HTMLElement} */ (active);
  let owned = true;
  const onFocus = (event) => {
    if (event.target !== target) owned = false;
  };
  const restore = (finished = false) => {
    if (!owned) return;
    const elements = [...root.querySelectorAll("[data-condition-id]")].filter(
      (el) => el.getAttribute("data-condition-id") === conditionId,
    );
    const button = elements.find(
      (el) =>
        el.matches('[data-analysis-action="answer"]') &&
        el.getAttribute("data-answer-value") === answerValue,
    );
    const card =
      elements.find((el) => el.matches(".analysis-card")) ||
      elements[0]?.closest(".analysis-card");
    const progress = button
      ?.closest(".analysis-card__question-actions")
      ?.querySelector(".analysis-card__answer-progress");
    const next =
      finished && button && !button.hasAttribute("hidden")
        ? button
        : progress || card;
    if (!(next instanceof HTMLElement) || next === target) return;
    if (next !== button) next.setAttribute("tabindex", "-1");
    target = next;
    target.focus({ preventScroll: true });
  };
  doc.addEventListener("focusin", onFocus);
  const observer = new MutationObserver(() => restore());
  observer.observe(root, { childList: true, subtree: true });
  let sessions = focusSessions.get(root);
  if (!sessions) focusSessions.set(root, (sessions = new Map()));
  sessions.set(conditionId, {
    finish() {
      restore(true);
      observer.disconnect();
      doc.removeEventListener("focusin", onFocus);
      sessions.delete(conditionId);
    },
  });
}

/** Replace one condition's answer controls with progress until the request settles.
 * Buttons remain in the DOM so failures can restore the original choices.
 * @param {Document | HTMLElement | ShadowRoot} root
 * @param {string} conditionId
 * @param {boolean} busy
 * @returns {void}
 */
export function setQuestionAnswerBusy(root, conditionId, busy) {
  if (busy && !focusSessions.get(root)?.has(conditionId))
    trackAnswerFocus(root, conditionId);
  const groups = new Set();
  for (const button of root.querySelectorAll(
    '[data-analysis-action="answer"]',
  )) {
    if (
      !(button instanceof HTMLButtonElement) ||
      button.getAttribute("data-condition-id") !== conditionId
    )
      continue;
    button.disabled = busy;
    button.hidden = busy;
    const group = button.closest(".analysis-card__question-actions");
    if (group) groups.add(group);
  }
  for (const group of groups) {
    const progress = group.querySelector(".analysis-card__answer-progress");
    if (!busy) progress?.remove();
    else if (!progress)
      group.insertAdjacentHTML(
        "beforeend",
        html` <span
          class="analysis-card__answer-progress"
          role="status"
          tabindex="-1"
        >
          <wa-spinner aria-hidden="true"></wa-spinner>
          ${escapeHtml(t("analysis.question.updating"))}
        </span>`,
      );
  }
  if (!busy) focusSessions.get(root)?.get(conditionId)?.finish();
}

/** @type {WeakMap<HTMLElement, Map<string, () => void>>} */
const confirmations = new WeakMap();

/**
 * Show a confirmation over the updated card for two seconds. Covered controls
 * are inert; rerenders retain the confirmation without repeating its announcement.
 * @param {HTMLElement} root
 * @param {string} conditionId
 */
export function showQuestionAnswerUpdated(root, conditionId) {
  let sessions = confirmations.get(root);
  if (!sessions) confirmations.set(root, (sessions = new Map()));
  sessions.get(conditionId)?.();
  /** @type {Map<HTMLElement, boolean>} */
  const covered = new Map();
  const doc = root.ownerDocument;
  /** @type {Element | null} */
  let focusedCard = null;
  let ownsFocus = false;
  /** @param {FocusEvent} event */
  const onFocus = (event) => {
    if (event.target !== focusedCard) ownsFocus = false;
  };
  doc?.addEventListener("focusin", onFocus);
  /** @param {Element} card */
  const focusCard = (card) => {
    focusedCard = card;
    ownsFocus = true;
    card.setAttribute("tabindex", "-1");
    /** @type {HTMLElement} */ (card).focus({ preventScroll: true });
  };
  let announced = false;
  const paint = () => {
    for (const card of root.querySelectorAll(
      ".analysis-card[data-condition-id]",
    )) {
      if (card.getAttribute("data-condition-id") !== conditionId) continue;
      if (!card.querySelector(".analysis-card__updated")) {
        card.insertAdjacentHTML(
          "beforeend",
          html`<div
            class="analysis-card__updated"
            ${announced ? 'aria-hidden="true"' : 'role="status"'}
          >
            <span class="analysis-card__updated-message">
              <wa-icon name="check" aria-hidden="true"></wa-icon>
              ${escapeHtml(t("analysis.question.updated"))}
            </span>
          </div>`,
        );
        announced = true;
      }
      const active = doc?.activeElement;
      if (active === card) {
        focusedCard = card;
        ownsFocus = true;
      } else if (
        ownsFocus &&
        focusedCard &&
        !focusedCard.isConnected &&
        (active === doc?.body || !active)
      ) {
        // Removing the owned card drops focus to body without a focusin event.
        focusCard(card);
      }
      for (const child of card.children) {
        if (
          !(child instanceof HTMLElement) ||
          child.classList.contains("analysis-card__updated")
        )
          continue;
        if (!covered.has(child)) covered.set(child, child.inert);
        // Keep focus on the card rather than an action hidden by the overlay.
        if (child.contains(root.ownerDocument?.activeElement)) {
          focusCard(card);
        }
        child.inert = true;
      }
    }
  };
  const observer = new MutationObserver(paint);
  const finish = () => {
    clearTimeout(timer);
    observer.disconnect();
    doc?.removeEventListener("focusin", onFocus);
    for (const [child, inert] of covered) child.inert = inert;
    for (const card of root.querySelectorAll(
      ".analysis-card[data-condition-id]",
    )) {
      if (card.getAttribute("data-condition-id") === conditionId)
        card.querySelector(".analysis-card__updated")?.remove();
    }
    sessions.delete(conditionId);
  };
  const timer = setTimeout(finish, 2000);
  sessions.set(conditionId, finish);
  paint();
  observer.observe(root, { childList: true, subtree: true });
}
