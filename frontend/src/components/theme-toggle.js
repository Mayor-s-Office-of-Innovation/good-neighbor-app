// @ts-nocheck -- lenient migration baseline (checkJs). Ratchet target: remove this line and add JSDoc types, one file per PR. See memory step2-gnp-port-scope.
/*
  theme-toggle web component. Thin UI over window.__theme (defined inline in
  index.html so the initial paint is already correct). Cycles: follow-OS -> the
  opposite of OS -> ... and reflects the current state for screen readers.

  Keyboard-operable (it's a real <button>), visible focus, aria-pressed + label
  that says whether we're following the OS.
*/
class ThemeToggle extends HTMLElement {
  connectedCallback() {
    // Hidden unless the ?themeToggle URL param is present (per-load, dev affordance).
    if (!new URLSearchParams(location.search).has("themeToggle")) {
      this.style.display = "none";
      return;
    }
    this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = `
      <style>
        button {
          font: inherit;
          width: 2.5rem; height: 2.5rem;
          border-radius: 999px;
          display: inline-flex; align-items: center; justify-content: center;
          font-size: 1.15rem; line-height: 1; cursor: pointer;
          background: var(--surface); color: var(--text);
          border: 1px solid var(--c-line); box-shadow: var(--shadow);
          opacity: .7; transition: opacity .15s ease, transform .15s ease;
        }
        button:hover { opacity: 1; transform: translateY(-1px); }
        button:focus-visible { opacity: 1; outline: 2px solid var(--c-blue); outline-offset: 2px; }
        wa-icon { display: block; }
      </style>
      <button type="button" part="button"><wa-icon></wa-icon></button>
    `;
    this._btn = this.shadowRoot.querySelector("button");
    this._icon = this.shadowRoot.querySelector("wa-icon");
    this._btn.addEventListener("click", () => window.__theme.toggle());
    this._onThemeChange = () => this._render();
    window.addEventListener("themechange", this._onThemeChange);
    this._render();
  }

  disconnectedCallback() {
    window.removeEventListener("themechange", this._onThemeChange);
  }

  _render() {
    const dark = window.__theme.isDark();
    const following = window.__theme.following();
    this._icon.name = dark ? "moon" : "sun";
    this._btn.setAttribute("aria-pressed", String(dark));
    const base = dark ? "Dark mode" : "Light mode";
    this._btn.setAttribute(
      "aria-label",
      `${base}${following ? " (following device setting)" : ""}. Activate to change theme.`,
    );
    this._btn.title = this._btn.getAttribute("aria-label");
  }
}
customElements.define("theme-toggle", ThemeToggle);
