/*
  Presentational templates for <site-setup>. Pure functions: (data) → HTML string.
  No DOM, no state, no event wiring — that all lives in site-setup.js. The `html`
  tag drives editor highlighting + Prettier formatting (see src/lib/html.js).

  Design: onboarding reuses the app's home-hub card system (.home > .screen >
  .screen__sec) with a brand .sitehead, a centered .hero, and the ink/outline
  pill buttons — so first-run matches the today/flow screens rather than the old
  prototype look. Setup-specific styling is limited to full-width CTAs and the
  "Don't have a code?" disclosure (see app.css “First-run setup”).
*/
import { html, escapeHtml, escapeAttr } from "../lib/html.js";

/* Brand header — the seal + wordmark, standing in for the site header the app
   shows once bound. (Seal is the shared placeholder until the SF-seal PNG lands.) */
const brandHead = () => html`
  <div class="screen__sec sitehead">
    <span class="sitehead__seal" aria-hidden="true">
      <wa-icon name="location-dot"></wa-icon>
    </span>
    <div>
      <div class="sitehead__name">Good Neighbor</div>
      <p class="sitehead__meta">Site setup</p>
    </div>
  </div>
`;

/* validating spinner */
export const checkingView = () => html`
  <div class="home setup">
    <div class="screen">
      ${brandHead()}
      <div class="screen__sec hero" aria-busy="true">
        <wa-spinner style="font-size: 2rem"></wa-spinner>
        <p class="hero__meta" role="status">Checking your setup code…</p>
      </div>
    </div>
  </div>
`;

/* confirm the site resolved from the code */
export const confirmView = ({ site, code }) => html`
  <div class="home setup">
    <div class="screen">
      ${brandHead()}
      <div class="screen__sec hero">
        <p class="hero__eyebrow">Confirm your site</p>
        <h1 class="hero__headline">${escapeHtml(site)}</h1>
        <p class="hero__body">
          Setup code ${escapeHtml(code)} · verified. This device will be bound
          to
          <strong>${escapeHtml(site)}</strong> — every report and task ties to
          it.
        </p>
      </div>
      <div class="screen__sec setup__actions">
        <button id="confirm" class="btn-ink" type="button">
          Set up this device
        </button>
        <button id="use-code" class="btn-outline" type="button">
          Use a different code
        </button>
      </div>
    </div>
  </div>
`;

/* enter / re-enter a code, with the manual site-picker fallback */
export const codeEntryView = ({ value = "", error = "", sites = [] }) => html`
  <div class="home setup">
    <div class="screen">
      ${brandHead()}
      <div class="screen__sec hero">
        <p class="hero__eyebrow">Perimeter checks</p>
        <h1 class="hero__headline">Set up this device</h1>
        <p class="hero__body">
          Enter the setup code from the email your site administrator received.
          It links this tablet to your location — no login required.
        </p>
      </div>
      <form id="code-form" class="screen__sec stack setup__form" novalidate>
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
        <wa-callout
          id="code-error"
          variant="danger"
          role="alert"
          ${error ? "" : " hidden"}
        >
          <wa-icon slot="icon" name="triangle-exclamation"></wa-icon>
          <span id="code-error-text">${escapeHtml(error)}</span>
        </wa-callout>
        <button type="submit" class="btn-ink">Continue</button>

        <details class="setup__manual">
          <summary>Don’t have a code?</summary>
          <div class="stack" style="margin-top: 0.75rem">
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
            <button id="manual-bind" class="btn-outline" type="button">
              Set up manually
            </button>
          </div>
        </details>
      </form>
    </div>
  </div>
`;
