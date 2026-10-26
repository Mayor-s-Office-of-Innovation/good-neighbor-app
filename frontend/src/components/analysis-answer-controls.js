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
