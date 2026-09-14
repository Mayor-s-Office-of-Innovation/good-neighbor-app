/*
  Preview setup — runs in StoryLite's isolated iframe before stories mount.
  Imports every custom element the stories render, exactly like main.js does
  for the app, plus the Web Awesome styles the pieces of tokens.css/app.css
  assume (form controls, spinner, icons). Kept in sync manually with
  main.js's import list — StoryLite runs its own Vite pipeline, so it does
  not inherit the app's.
*/
import "@awesome.me/webawesome/dist/styles/layers.css";
import "@awesome.me/webawesome/dist/styles/native.css";
import "@awesome.me/webawesome/dist/styles/utilities.css";
import "@awesome.me/webawesome/dist/styles/color/palettes/bright.css";
// Our vendored fork (font @import stripped — CDN-free rule), same as main.js.
import "./src/styles/wa-awesome.css";

import { registerIconLibrary } from "@awesome.me/webawesome/dist/components/icon/library.js";

registerIconLibrary("default", {
  resolver: (name) => `/icons/${name}.svg`,
  mutator: (svg) => svg.setAttribute("fill", "currentColor"),
});

import "@awesome.me/webawesome/dist/components/icon/icon.js";
import "@awesome.me/webawesome/dist/components/input/input.js";
import "@awesome.me/webawesome/dist/components/otp-input/otp-input.js";
import "@awesome.me/webawesome/dist/components/textarea/textarea.js";
import "@awesome.me/webawesome/dist/components/checkbox/checkbox.js";
import "@awesome.me/webawesome/dist/components/badge/badge.js";
import "@awesome.me/webawesome/dist/components/callout/callout.js";
import "@awesome.me/webawesome/dist/components/spinner/spinner.js";
import "@awesome.me/webawesome/dist/components/select/select.js";
import "@awesome.me/webawesome/dist/components/option/option.js";
import "@awesome.me/webawesome/dist/components/button/button.js";

/**
 * StoryLite calls this in the preview iframe after the imports above have run
 * (side-effect imports have already registered the custom elements).
 * @param {Window} win
 * @returns {void}
 */
export function setupPreview(window) {
  // Nothing extra needed yet — registration happens via the imports above.
  void window;
}