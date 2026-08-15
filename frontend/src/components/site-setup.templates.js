/*
  Presentational template for <site-setup>. Logic and input handling stay in
  site-setup.js; this file owns only the login screen markup.
*/
import { html, escapeAttr, escapeHtml } from "../lib/html.js";

/**
 * @param {{digits?: string[], error?: string, checking?: boolean}} state
 * @returns {string}
 */
export const codeEntryView = ({
  digits = ["", "", "", "", "", ""],
  error = "",
  checking = false,
} = {}) => html`
  <main class="login" aria-labelledby="login-title">
    <section class="login__panel" aria-busy="${checking ? "true" : "false"}">
      <div class="login__mark" aria-hidden="true"></div>

      <div class="login__copy">
        <h1 id="login-title">Welcome to Good Neighbor.</h1>
        <p>Enter a site code</p>
      </div>

      <form
        id="code-form"
        class="login__form ${error ? "login__form--error" : ""}"
        novalidate
      >
        <fieldset class="code-boxes" ${checking ? "disabled" : ""}>
          <legend class="visually-hidden">Six digit site code</legend>
          ${digits
            .map(
              (digit, index) => html`
                <span class="code-cell">
                  <input
                    class="code-box ${error ? "code-box--error" : ""}"
                    id="code-${index}"
                    inputmode="numeric"
                    pattern="[0-9]*"
                    autocomplete="${index === 0 ? "one-time-code" : "off"}"
                    maxlength="1"
                    aria-label="Site code digit ${index + 1}"
                    value="${escapeAttr(digit)}"
                  />
                  ${digit
                    ? ""
                    : html`<span class="code-cell__pin" aria-hidden="true"></span>`}
                </span>
                ${index === 2
                  ? html`<span class="code-boxes__dash" aria-hidden="true"
                      >-</span
                    >`
                  : ""}
              `,
            )
            .join("")}
        </fieldset>

        <p
          id="code-error"
          class="login__error"
          role="alert"
          ${error ? "" : "hidden"}
        >
          ${escapeHtml(error)}
        </p>

        <button
          id="continue"
          class="btn-ink login__continue"
          type="submit"
          ${checking || digits.join("").length < 6 ? "disabled" : ""}
        >
          ${checking
            ? html`<wa-spinner aria-label="Checking site code"></wa-spinner>`
            : "Continue"}
        </button>
      </form>
    </section>
  </main>
`;
