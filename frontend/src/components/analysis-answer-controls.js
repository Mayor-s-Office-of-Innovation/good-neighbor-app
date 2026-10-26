import { t } from "../i18n/i18n.js";
import { html, escapeHtml } from "../lib/html.js";

/** Replace one condition's answer controls with progress until the request settles.
 * Buttons remain in the DOM so failures can restore the original choices.
 * @param {Document | HTMLElement | ShadowRoot} root
 * @param {string} conditionId
 * @param {boolean} busy
 * @returns {void}
 */
export function setQuestionAnswerBusy(root, conditionId, busy) {
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
        html` <span class="analysis-card__answer-progress" role="status">
          <wa-spinner aria-hidden="true"></wa-spinner>
          ${escapeHtml(t("analysis.question.updating"))}
        </span>`,
      );
  }
}
