/*
  yes-no-choice — the shared Yes / No button pair.

  The picked button renders as `.btn-ink` (filled), the other as `.btn-outline`.
  With no answer yet (`null`), both are outlined. `aria-pressed` mirrors the
  choice for screen readers.

  Usage:
    yesNoChoice({ name: "city-help", value, yesLabel, noLabel })
    // → buttons carry data-city-help="yes" / data-city-help="no"
    bindYesNoChoice(root, "city-help", (value) => { ... });

  Callers wrap it in their own <fieldset>/<section> with a visible question, and
  add layout classes through `className`.
*/

import { html, escapeAttr, escapeHtml } from "../lib/html.js";

/**
 * @param {boolean} selected
 * @returns {string}
 */
function choiceClass(selected) {
  return selected ? "btn-ink" : "btn-outline";
}

/**
 * Render the Yes / No pair.
 * @param {{
 *   name: string,
 *   value: boolean | null | undefined,
 *   yesLabel: string,
 *   noLabel: string,
 *   disabled?: boolean,
 *   className?: string,
 * }} options `name` becomes the `data-<name>` attribute on each button.
 * @returns {string}
 */
export function yesNoChoice({
  name,
  value,
  yesLabel,
  noLabel,
  disabled = false,
  className = "",
}) {
  const button = (/** @type {boolean} */ answer, /** @type {string} */ label) =>
    html`<button
      type="button"
      class="${choiceClass(value === answer)}"
      data-${name}="${answer ? "yes" : "no"}"
      aria-pressed="${value === answer}"
      ${disabled ? "disabled" : ""}
    >
      ${escapeHtml(label)}
    </button>`;
  return html`<div class="${escapeAttr(`yes-no-choice ${className}`.trim())}">
    ${button(true, yesLabel)} ${button(false, noLabel)}
  </div>`;
}

/**
 * Wire clicks on a rendered pair. The buttons restyle in place, then `onChange`
 * runs with the new answer. Return `false` from `onChange` to ignore the click.
 * @param {ParentNode} root element to search from
 * @param {string} name same `name` passed to yesNoChoice
 * @param {(value: boolean, button: HTMLButtonElement) => boolean | void} onChange
 */
export function bindYesNoChoice(root, name, onChange) {
  /** @type {NodeListOf<HTMLButtonElement>} */
  const buttons = root.querySelectorAll(`button[data-${name}]`);
  buttons.forEach((button) =>
    button.addEventListener("click", () => {
      const value = button.getAttribute(`data-${name}`) === "yes";
      if (onChange(value, button) === false) return;
      buttons.forEach((choice) => {
        const selected = choice === button;
        choice.setAttribute("aria-pressed", String(selected));
        choice.className = choiceClass(selected);
      });
    }),
  );
}
