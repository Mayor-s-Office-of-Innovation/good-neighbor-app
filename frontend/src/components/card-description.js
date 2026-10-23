import { html, escapeHtml } from "../lib/html.js";

/** Keep the word crossing the limit intact. @param {string} text */
export function shortenedCardDescription(text) {
  if (Array.from(text).length <= 200) return text;
  const characters = Array.from(text);
  let end = 200;
  while (end < characters.length && !/\s/u.test(characters[end])) end++;
  return end === characters.length
    ? text
    : characters.slice(0, end).join("").trimEnd() + "...";
}

/** Native disclosure preserves keyboard activation and expanded state. @param {string} text */
export function cardDescription(text) {
  const shortened = shortenedCardDescription(text);
  if (shortened === text) return html`<p>${escapeHtml(text)}</p>`;
  return html`<details class="card-description">
    <summary>
      <span class="card-description__short">${escapeHtml(shortened)}</span
      ><span class="card-description__full">${escapeHtml(text)}</span>
    </summary>
  </details>`;
}
