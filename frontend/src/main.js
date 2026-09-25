// @ts-nocheck -- lenient migration baseline (checkJs). Ratchet target: remove this line and add JSDoc types, one file per PR. See memory step2-gnp-port-scope.
/*
  Bootstrap: register the icon library, load styles + Web Awesome components,
  register our own components, mount the app.

  Web Awesome is adopted in HYBRID fashion: WA supplies form controls, icons,
  badges, callouts and spinners; buttons are native `<button>` + `.btn-*` classes
  (ADR 0011); we keep our own shell and bottom nav.
  APIs were pulled from the shipped agent skill in node_modules (never guessed).

  CDN-free note: wa-icon loads from the Font Awesome CDN by default. We self-host a
  small icon set in /public/icons and register it as the `default` library below, so
  every <wa-icon> resolves locally — no kit fetch (the ka-*.fontawesome.com strings
  left in the WA bundle are its default resolver, never reached once we override it).
  The default theme and palette use system fonts and are imported from the installed
  package, so the app remains fully CDN-free at runtime while matching the official
  Web Awesome Figma kit.

  (No service worker ships in the MVP — real offline/precaching is a later pass; see
  vite.config.js and memory step2-gnp-port-scope.)
*/
// Error capture installs FIRST — this is the first import in the module graph,
// and the module self-installs its `error` + `unhandledrejection` listeners at
// evaluation time, so exceptions while loading Web Awesome or any later import
// are still captured. No-ops under tests and when `gnp:errors=off`.
import "./services/error-report.js";

import { registerIconLibrary } from "@awesome.me/webawesome/dist/components/icon/library.js";

// Resolve icons from our self-hosted set. BASE_URL keeps paths correct under a
// GitHub Pages project subpath. The mutator makes each SVG inherit text color.
registerIconLibrary("default", {
  resolver: (name) => `${import.meta.env.BASE_URL}icons/${name}.svg`,
  mutator: (svg) => svg.setAttribute("fill", "currentColor"),
});

// Web Awesome base styles, imported piecewise instead of `webawesome.css` so the
// unused styles and components never ship. Keep this list in sync with
// webawesome.css's own import list.
import "@awesome.me/webawesome/dist/styles/layers.css";
import "@awesome.me/webawesome/dist/styles/native.css";
import "@awesome.me/webawesome/dist/styles/utilities.css";
// Match the official Figma kit: Default theme + Default palette. The theme
// stylesheet imports the palette and uses only local/system font stacks.
import "@awesome.me/webawesome/dist/styles/themes/default.css";

// Cherry-picked WA components (tree-shaken — only what we use). Any component
// used only by a dev screen is imported in that module instead (see
// guidance-harness.js), so the prod bundle carries only production components.
import "@awesome.me/webawesome/dist/components/icon/icon.js";
import "@awesome.me/webawesome/dist/components/otp-input/otp-input.js";
import "@awesome.me/webawesome/dist/components/textarea/textarea.js";
import "@awesome.me/webawesome/dist/components/spinner/spinner.js";

// Our tokens + layout. Unlayered, so they win over WA's @layer-ed native styles.
import "./styles/tokens.css";
import "./styles/app.css";

// Register custom elements (side-effect imports).
import "./components/theme-toggle.js";
import "./components/today-view.js";
import "./components/feedback-dialog.js";
import "./components/perimeter-check.js";
import "./components/problem-report.js";
import "./components/describe-instead.js";
import "./components/site-setup.js";
import "./components/app-toasts.js";
import "./components/app-root.js";

if (import.meta.env.DEV) {
  await import("./components/guidance-harness.js");
}
