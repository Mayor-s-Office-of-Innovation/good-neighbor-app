import "@awesome.me/webawesome/dist/components/badge/badge.js";

/**
 * Tokens story — the design-system vocabulary from tokens.css, shown in both
 * themes. Values are read from CSS custom properties at render time, so the
 * swatches can't drift from the real tokens.
 * @returns {string}
 */
function tokenSwatch(name, textOnLight) {
  return `<div class="story-stack" style="gap:0.25rem">
    <span style="width:96px; height:48px; border-radius:10px; border:1px solid var(--c-line); background: var(${name}); display:inline-block"></span>
    <code style="font-size:0.7rem; color: var(--text-secondary)">${name}</code>
    <small style="font-size:0.65rem; color: var(--text-faint)">${textOnLight}</small>
  </div>`;
}

/** @returns {string} */
function tokenTable() {
  const swatches = [
    ["--bg", "page background"],
    ["--surface", "card surface"],
    ["--surface-2", "subtle fill"],
    ["--surface-3", "grey pill"],
    ["--c-line", "hairlines + dividers"],
    ["--text", "body text"],
    ["--text-secondary", "secondary text"],
    ["--text-faint", "decorative text"],
    ["--brand-blue", "the one accent"],
    ["--brand-blue-bg", "accent pill bg"],
    ["--ink", "primary CTA fill"],
    ["--on-ink", "CTA label"],
    ["--c-hazard", "severity reinforcement"],
    ["--c-hazard-bg", "severity pill bg"],
  ];
  return swatches.map(([n, d]) => tokenSwatch(n, d)).join("");
}

/** @returns {string} */
function shapeTokens() {
  return ["--radius", "--radius-sm", "--radius-pill", "--shadow", "--shadow-lift"]
    .map(
      (n) => `<div class="story-stack" style="gap:0.25rem">
      <span style="width:96px; height:48px; background: var(--surface); display:inline-block; ${n === "--shadow-lift" || n === "--shadow" ? `box-shadow: var(${n});` : ""} ${n.startsWith("--radius") ? `border:1px solid var(--c-line); border-radius: var(${n});` : ""}"></span>
      <code style="font-size:0.7rem; color: var(--text-secondary)">${n}</code>
    </div>`,
    )
    .join("");
}

export default {
  title: "Foundations/Tokens",
  parameters: { renderer: "html" },
};

export const Tokens = {
  name: "Tokens",
  render: () => `
    <p class="story-label">Color tokens (light values shown; flip the Dark mode toolbar toggle)</p>
    <div class="story-row" style="align-items:flex-start">${tokenTable()}</div>
    <p class="story-label">Shape + elevation</p>
    <div class="story-row" style="align-items:flex-end">${shapeTokens()}</div>
    <p class="story-label">Rules</p>
    <div class="story-stack" style="max-width:420px; align-items:flex-start; gap:0.4rem">
      <small>1. Tokens only — never hard-code a hex in component CSS.</small>
      <small>2. Color never carries meaning alone (WCAG 1.4.1) — pair with label/icon.</small>
      <small>3. Dark mode is a token swap under html.wa-dark; use the toolbar toggle.</small>
    </div>
  `,
  source: () => `/* Tokens live in frontend/src/styles/tokens.css — use var(--token), never hex */`,
};