/*
  Presentational templates for <site-setup>. Pure functions: (data) → HTML string.
  No DOM, no state, no event wiring — that all lives in site-setup.js. The `html`
  tag drives editor highlighting + Prettier formatting (see src/lib/html.js).
*/
import { html, escapeHtml, escapeAttr } from "../lib/html.js";

/* validating spinner */
export const checkingView = () => html`
  <div class="setup" aria-busy="true">
    <div class="setup__center stack">
      <wa-spinner style="font-size: 2rem"></wa-spinner>
      <p class="hint" role="status">Checking your setup code…</p>
    </div>
  </div>
`;

/* confirm the site resolved from the code */
export const confirmView = ({ site, code }) => html`
  <div class="setup stack">
    <div>
      <h2>Confirm your site</h2>
      <p class="hint">
        Your setup code identifies this location — no login needed.
      </p>
    </div>
    <div class="card stack--tight">
      <div class="setup__site">
        <wa-icon name="location-dot" aria-hidden="true"></wa-icon>
        <span>${escapeHtml(site)}</span>
      </div>
      <p class="hint">Code ${escapeHtml(code)} · verified</p>
    </div>
    <wa-callout variant="brand">
      <wa-icon slot="icon" name="circle-check"></wa-icon>
      This device will be set up for <strong>${escapeHtml(site)}</strong>. All
      reports and tasks will be tied to it.
    </wa-callout>
    <wa-button
      id="confirm"
      type="button"
      variant="brand"
      appearance="accent"
      size="large"
    >
      Set up this device
    </wa-button>
    <wa-button id="use-code" type="button" appearance="plain">
      Use a different code
    </wa-button>
  </div>
`;

/* enter / re-enter a code, with the manual site-picker fallback */
export const codeEntryView = ({ value = "", error = "", sites = [] }) => html`
  <form id="code-form" class="setup stack" novalidate>
    <div>
      <h2>Set up this device</h2>
      <p class="hint">
        Enter the setup code from the email your site administrator received. It
        links this tablet to your location — no login required.
      </p>
    </div>
    <div class="card">
      <wa-input
        id="code"
        label="Setup code"
        placeholder="e.g. HCM-4820"
        autocapitalize="characters"
        spellcheck="false"
        value="${escapeAttr(value)}"
      >
        <wa-icon slot="start" name="location-dot"></wa-icon>
      </wa-input>
    </div>
    <wa-callout
      id="code-error"
      variant="danger"
      role="alert"
      ${error ? "" : " hidden"}
    >
      <wa-icon slot="icon" name="triangle-exclamation"></wa-icon>
      <span id="code-error-text">${escapeHtml(error)}</span>
    </wa-callout>
    <wa-button type="submit" variant="brand" appearance="accent" size="large">
      Continue
    </wa-button>

    <details class="setup__manual">
      <summary>Don’t have a code?</summary>
      <div class="stack" style="margin-top: .75rem">
        <p class="hint">
          Set up without a code by choosing your site (prototype only).
        </p>
        <wa-select
          id="site-select"
          label="Choose your site"
          value="${escapeAttr(sites[0] || "")}"
        >
          <wa-icon slot="start" name="location-dot"></wa-icon>
          ${sites
            .map(
              (s) =>
                html`<wa-option value="${escapeAttr(s)}"
                  >${escapeHtml(s)}</wa-option
                >`,
            )
            .join("")}
        </wa-select>
        <wa-button id="manual-bind" type="button" appearance="outlined">
          Set up manually
        </wa-button>
      </div>
    </details>
  </form>
`;
