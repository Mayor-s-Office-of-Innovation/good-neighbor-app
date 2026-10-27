import { html } from "./html.js";

/**
 * Animated trailing ellipsis for in-progress status text ("Analyzing",
 * "Filing ticket"). The three dots are always in the DOM and animate only
 * opacity/transform (no reflow); the span is decorative, so the status text
 * itself stays the single announced string. Styles live in base.css
 * (.ellipsis-dots).
 * @returns {string}
 */
export function animatedEllipsis() {
  return html`<span class="ellipsis-dots" aria-hidden="true"
    ><span>.</span><span>.</span><span>.</span></span
  >`;
}
