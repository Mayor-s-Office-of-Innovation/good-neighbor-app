/*
  Presentational template for <site-setup>. Logic and input handling stay in
  site-setup.js; this file owns only the login screen markup.
*/
import { html, escapeAttr, escapeHtml } from "../lib/html.js";

/**
 * @param {{value?: string, error?: string, checking?: boolean, mode?: "code"|"request", request?: { query?: string, email?: string, searching?: boolean, requesting?: boolean, sites?: Array<{siteId:string, name:string, providerName?:string, label?:string}>, selectedSiteId?: string, message?: string, error?: string }}} state
 * @returns {string}
 */
export const codeEntryView = ({
  value = "",
  error = "",
  checking = false,
  mode = "code",
  request = {},
} = {}) => html`
  <main class="login" aria-labelledby="login-title">
    <section class="login__panel" aria-busy="${checking ? "true" : "false"}">
      <div class="login__mark" aria-hidden="true"></div>

      <div class="login__copy">
        <h1 id="login-title">Welcome to Good Neighbor.</h1>
        <p>${mode === "request" ? "Request a new site code" : "Enter a site code"}</p>
      </div>

      ${mode === "request"
        ? requestCodeView(request)
        : enterCodeView({ value, error, checking })}
    </section>
  </main>
`;

/**
 * @param {{ value: string, error: string, checking: boolean }} state
 * @returns {string}
 */
function enterCodeView({ value, error, checking }) {
  return html`
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
    <button id="show-request-code" class="login__link" type="button">
      Need a new code?
    </button>
  `;
}

/**
 * @param {{ query?: string, email?: string, searching?: boolean, requesting?: boolean, sites?: Array<{siteId:string, name:string, providerName?:string, label?:string}>, selectedSiteId?: string, message?: string, error?: string }} state
 * @returns {string}
 */
function requestCodeView({
  query = "",
  email = "",
  searching = false,
  requesting = false,
  sites = [],
  selectedSiteId = "",
  message = "",
  error = "",
}) {
  return html`
    <form id="request-code-form" class="login__request" novalidate>
      <label class="login__field">
        <span>Search for a site</span>
        <input
          id="site-search"
          type="search"
          autocomplete="organization"
          value="${escapeAttr(query)}"
          ${requesting ? "disabled" : ""}
        />
      </label>
      <div class="login__results" role="listbox" aria-label="Matching sites">
        ${sites
          .map(
            (site) => html`
              <button
                class="login__result ${site.siteId === selectedSiteId
                  ? "login__result--selected"
                  : ""}"
                type="button"
                data-site-id="${escapeAttr(site.siteId)}"
              >
                <span>${escapeHtml(site.name)}</span>
                <small>${escapeHtml(site.providerName ?? "")}</small>
              </button>
            `,
          )
          .join("")}
      </div>
      ${selectedSiteId
        ? html`
            <label class="login__field">
              <span>Now enter your email</span>
              <input
                id="work-email"
                type="email"
                autocomplete="email"
                value="${escapeAttr(email)}"
                ${requesting ? "disabled" : ""}
              />
            </label>
          `
        : ""}
      <p class="login__error" role="alert" ${error ? "" : "hidden"}>
        ${escapeHtml(error)}
      </p>
      <p class="login__message" role="status" ${message ? "" : "hidden"}>
        ${escapeHtml(message)}
      </p>
      <button
        id="request-code-submit"
        class="btn-ink login__continue"
        type="submit"
        ${requesting || !selectedSiteId || !email ? "disabled" : ""}
      >
        ${requesting
          ? html`<wa-spinner aria-label="Requesting setup code"></wa-spinner>`
          : "Send code"}
      </button>
    </form>
    <button id="show-code-entry" class="login__link" type="button">
      Enter a code instead
    </button>
    <p class="login__hint" ${searching ? "" : "hidden"}>Searching...</p>
  `;
}
