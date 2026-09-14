/**
 * Buttons story — the native-button vocabulary ratified in ADR 0011.
 * Source of truth: docs/frontend-design-system.md "Buttons" +
 * frontend/src/styles/app.css (.btn-ink / .btn-outline / .btn-blue / --sm /
 * .login__link / the button[data-loading] pattern).
 */

export default {
  title: "Foundations/Buttons",
  parameters: { renderer: "html" },
};

/** @returns {string} */
const pills = () => `
  <div class="story-row">
    <button class="btn-ink" type="button">Primary action</button>
    <button class="btn-outline" type="button">Secondary</button>
    <button class="btn-blue" type="button">Filed 311 ticket</button>
  </div>`;

/** @returns {string} */
const smalls = () => `
  <div class="story-row">
    <button class="btn-ink btn-ink--sm" type="button">Primary</button>
    <button class="btn-outline btn-outline--sm" type="button">Secondary</button>
    <button class="btn-blue btn-blue--sm" type="button">Escalation</button>
  </div>`;

/** @returns {string} */
const states = () => `
  <div class="story-row">
    <button class="btn-ink" type="button" disabled>Disabled primary</button>
    <button class="btn-outline" type="button" disabled>Disabled secondary</button>
  </div>`;

/** @returns {string} */
const linkButton = () => `
  <div class="story-row">
    <button class="login__link" type="button">Link-styled button (.login__link)</button>
  </div>`;

/**
 * Loading pattern demo. Static markup + a tiny inline script toggling the
 * state, so the story is interactive without any app code.
 * @returns {string}
 */
const loadingDemo = () => {
  return `
  <div class="story-stack">
    <button class="btn-ink" id="sl-load-demo" type="button">
      <span data-loading-label>Save my place</span>
      <wa-spinner style="display:none" id="sl-load-spinner"></wa-spinner>
    </button>
    <small style="color:var(--text-secondary)">Click to see the busy state — width must not change.</small>
  </div>
  <script type="module">
    const btn = document.getElementById("sl-load-demo");
    const spinner = document.getElementById("sl-load-spinner");
    btn?.addEventListener("click", () => {
      btn.style.setProperty("--btn-loading-min-width", btn.offsetWidth + "px");
      btn.setAttribute("data-loading", "");
      btn.setAttribute("aria-busy", "true");
      btn.disabled = true;
      spinner.style.display = "inline-block";
      setTimeout(() => {
        btn.removeAttribute("data-loading");
        btn.removeAttribute("aria-busy");
        btn.disabled = false;
        spinner.style.display = "none";
      }, 1800);
    }, { once: false });
  </script>`;
};

export const Default = {
  name: "Pills",
  render: () => pills(),
};

export const Small = {
  render: () => smalls(),
};

export const Disabled = {
  render: () => states(),
};

export const Link = {
  render: () => linkButton(),
};

export const Loading = {
  render: () => loadingDemo(),
  source: () => `// Loading pattern (app.css button[data-loading]):
// btn.style.setProperty("--btn-loading-min-width", btn.offsetWidth + "px");
// btn.setAttribute("data-loading", "");
// btn.setAttribute("aria-busy", "true");
// btn.disabled = true;
// // ... await work, then remove all three`,
};