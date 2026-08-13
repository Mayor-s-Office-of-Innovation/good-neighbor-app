/*
  Presentational templates for <app-root> — the two shells it swaps between. Pure
  (data) → HTML string; route → view mounting stays in app-root.js. The `html` tag
  drives editor highlighting + Prettier formatting (see src/lib/html.js).
*/
import { html, escapeHtml } from "../lib/html.js";

/* first-run: mount the onboarding flow */
export const setupView = () => html`
  <main class="app__main"><site-setup></site-setup></main>
  <theme-toggle></theme-toggle>
`;

/* bound-device app shell: header + main view slot. No bottom nav — the Take-5 IA is
   a home hub (today-view) plus a linear check flow, navigated by in-screen CTAs. */
export const appShell = ({ siteName }) => html`
  <div class="app">
    <header class="app__header">
      <a class="app__home" href="/today" aria-label="Home">
        <span class="app__title">${escapeHtml(siteName)}</span>
        <span class="app__kicker">Good Neighbor</span>
      </a>
      <span class="app__spacer"></span>
    </header>
    <main class="app__main" id="view" tabindex="-1"></main>
  </div>
  <theme-toggle></theme-toggle>
`;
