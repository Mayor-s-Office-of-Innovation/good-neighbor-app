/*
  Presentational templates for <app-root> — the two shells it swaps between. Pure
  (data) → HTML string; route → view mounting stays in app-root.js. The `html` tag
  drives editor highlighting + Prettier formatting (see src/lib/html.js).
*/
import { t } from "../i18n/i18n.js";
import { html, escapeAttr, escapeHtml } from "../lib/html.js";

/* first-run: mount the onboarding flow */
export const setupView = ({
  targetSiteId = "",
  targetSiteName = "",
  mode = "code",
  canCancel = false,
  notice = "",
} = {}) => html`
  <main class="app__main">
    <site-setup
      data-target-site-id="${escapeAttr(targetSiteId)}"
      data-target-site-name="${escapeAttr(targetSiteName)}"
      data-mode="${escapeAttr(mode)}"
      data-notice="${escapeAttr(notice)}"
      ${canCancel ? "data-can-cancel" : ""}
    ></site-setup>
  </main>
  <theme-toggle></theme-toggle>
`;

/* Home Screen handoff in progress (services/session-handoff.js): the launch
   URL carried a grant and app-root is redeeming it. The setup panel's chrome
   with a spinner and no code form; <site-setup> takes no part in this flow. */
export const handoffView = () => html`
  <main class="app__main">
    <div class="login" aria-labelledby="login-title">
      <section class="login__panel" aria-busy="true">
        <div class="login__mark" aria-hidden="true"></div>
        <div class="login__copy">
          <h1 id="login-title">${escapeHtml(t("setup.welcome"))}</h1>
          <p>${escapeHtml(t("setup.handoff.signingIn"))}</p>
        </div>
        <div class="login__handoff">
          <wa-spinner
            aria-label="${escapeAttr(t("setup.handoff.aria"))}"
          ></wa-spinner>
        </div>
      </section>
    </div>
  </main>
  <theme-toggle></theme-toggle>
`;

/* bound-device app shell: header + main view slot. No bottom nav — the Take-5 IA is
   a home hub (today-view) plus a linear check flow, navigated by in-screen CTAs. */
export const appShell = ({ siteName }) => html`
  <div class="app">
    <header class="app__header">
      <a
        class="app__home"
        href="/today"
        aria-label="${escapeAttr(t("app.home.aria"))}"
      >
        <span class="app__title">${escapeHtml(siteName)}</span>
        <span class="app__kicker">${escapeHtml(t("app.name"))}</span>
      </a>
      <span class="app__spacer"></span>
    </header>
    <main class="app__main" id="view" tabindex="-1"></main>
  </div>
  <theme-toggle></theme-toggle>
`;
