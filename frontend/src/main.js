// @ts-nocheck -- lenient migration baseline (checkJs). Ratchet target: remove this line and add JSDoc types, one file per PR. See memory step2-gnp-port-scope.
/*
  Bootstrap: register the icon library, load styles + Web Awesome components,
  register our own components, mount the app.

  Web Awesome is adopted in HYBRID fashion: WA supplies form controls, buttons,
  badges, callouts, spinners and icons; we keep our own shell, bottom nav and the
  camera/mic capture plumbing. APIs were pulled from the shipped agent skill in
  node_modules (never guessed).

  CDN-free note: wa-icon loads from the Font Awesome CDN by default. We self-host a
  small icon set in /public/icons and register it as the `default` library below, so
  every <wa-icon> resolves locally — no kit fetch (the ka-*.fontawesome.com strings
  left in the WA bundle are its default resolver, never reached once we override it).
  The `awesome` theme is vendored (src/styles/wa-awesome.css) with its remote font
  @import stripped and Quicksand self-hosted, and imported eagerly below, so the app
  is fully CDN-free at runtime.

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

// Web Awesome base styles + default theme (offline-clean: no external fonts).
import "@awesome.me/webawesome/dist/styles/webawesome.css";
// The "awesome" theme is our locked-in look. Vendored (src/styles/wa-awesome.css)
// with its remote font @import stripped and Quicksand self-hosted, so it's fully
// offline + CDN-free.
import "./styles/wa-awesome.css";

// Cherry-picked WA components (tree-shaken — only what we use).
import "@awesome.me/webawesome/dist/components/button/button.js";
import "@awesome.me/webawesome/dist/components/icon/icon.js";
import "@awesome.me/webawesome/dist/components/input/input.js";
import "@awesome.me/webawesome/dist/components/otp-input/otp-input.js";
import "@awesome.me/webawesome/dist/components/textarea/textarea.js";
import "@awesome.me/webawesome/dist/components/checkbox/checkbox.js";
import "@awesome.me/webawesome/dist/components/select/select.js";
import "@awesome.me/webawesome/dist/components/option/option.js";
import "@awesome.me/webawesome/dist/components/badge/badge.js";
import "@awesome.me/webawesome/dist/components/callout/callout.js";
import "@awesome.me/webawesome/dist/components/spinner/spinner.js";

// Our tokens + layout. Unlayered, so they win over WA's @layer-ed native styles.
import "./styles/tokens.css";
import "./styles/app.css";

// Consume the ?webcam capture-mode param (opt-in in-app browser camera) at startup,
// so the choice is persisted + the param stripped from the URL well before any
// capture is triggered (which only happens on a later user tap).
import { syncCaptureModeFromUrl } from "./services/capture-mode.js";
syncCaptureModeFromUrl();

// Register custom elements (side-effect imports).
import "./components/theme-toggle.js";
import "./components/capture-audio.js";
import "./components/in-browser-camera.js";
import "./components/today-view.js";
import "./components/perimeter-check.js";
import "./components/problem-report.js";
import "./components/describe-instead.js";
import "./components/check-review.js";
import "./components/check-results.js";
import "./components/site-setup.js";
import "./components/app-root.js";

if (import.meta.env.DEV) {
  await import("./components/guidance-harness.js");
}
