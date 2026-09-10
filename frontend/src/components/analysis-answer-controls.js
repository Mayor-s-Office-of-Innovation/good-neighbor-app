/**
 * Disable or re-enable every answer option for one condition.
 * @param {Document | HTMLElement | ShadowRoot} root
 * @param {string} conditionId
 * @param {boolean} busy
 * @returns {void}
 */
export function setQuestionAnswerBusy(root, conditionId, busy) {
  const buttons = root.querySelectorAll('[data-analysis-action="answer"]');
  for (const button of buttons) {
    if (
      !(button instanceof HTMLButtonElement) ||
      button.getAttribute("data-condition-id") !== conditionId
    ) {
      continue;
    }
    button.disabled = busy;
    button.setAttribute("aria-busy", busy ? "true" : "false");
  }
}
