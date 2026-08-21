/*
  Presentational template for <site-setup>. Logic and input handling stay in
  site-setup.js; this file owns only the login screen markup.
*/
import { html, escapeAttr, escapeHtml } from "../lib/html.js";

/**
 * @param {{value?: string, error?: string, checking?: boolean}} state
 * @returns {string}
 */
export const codeEntryView = ({
  value = "",
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
        <wa-otp-input
          id="code-input"
          class="login__otp ${error ? "login__otp--error" : ""}"
          label="Site code"
          length="6"
          type="alphanumeric"
          case="upper"
          value="${escapeAttr(value)}"
          ${checking ? "disabled" : ""}
        ></wa-otp-input>

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
          ${checking || value.length < 6 ? "disabled" : ""}
        >
          ${checking
            ? html`<wa-spinner aria-label="Checking site code"></wa-spinner>`
            : "Continue"}
        </button>
      </form>
    </section>
  </main>
`;
