/*
  wa-system-icons — our replacement for Web Awesome's built-in "system" icon
  library, swapped in by the `resolve.alias` entry in vite.config.js.

  Web Awesome registers a `system` library at import time: ~40 kB of Font
  Awesome SVG markup inlined as JavaScript, used by its own components for
  their internal icons (the chevron on <wa-select>, the clear button on an
  input, the eye on a password field, …). The lookup is by name, so the
  bundler cannot tree-shake it, and none of the components this app loads
  (icon, otp-input, textarea, spinner) draw a system icon. Shipping it cost
  more than every icon the app actually shows.

  Instead of an empty stub, the system library here resolves to the SAME
  self-hosted set as the `default` library (frontend/public/icons, registered
  in main.js). The rule when adding a Web Awesome component: check its docs
  for the system icons it uses and add each one as `public/icons/<name>.svg`.
  A missing icon renders as an empty box in dev, never a crash — nothing
  silently depends on vendor markup we did not choose to include.

  Export names mirror the vendor chunk (dist/chunks/chunk.*.js, built from
  src/components/icon/library.system.ts) so the aliased import keeps working.
*/

/** Base URL of the self-hosted icon directory (BASE_URL ends with "/"). */
function iconsBase() {
  const base =
    /** @type {{ env?: { BASE_URL?: string } }} */ (import.meta).env
      ?.BASE_URL ?? "/";
  return `${base}icons/`;
}

/**
 * Resolve a system icon name to a self-hosted SVG URL. Web Awesome passes
 * `(name, family, variant)`; the family/variant distinction (solid/regular)
 * does not exist in our flat set, so only the name is used.
 * @param {string} name
 * @returns {string}
 */
export function resolveSystemIcon(name) {
  return name ? `${iconsBase()}${encodeURIComponent(name)}.svg` : "";
}

/**
 * Same mutator as the `default` library: let the SVG inherit text color.
 * @param {SVGElement} svg
 */
export function mutateSystemIcon(svg) {
  svg.setAttribute("fill", "currentColor");
}

/** Kept for API parity with the vendor chunk; no inlined markup here. */
export const icons = { solid: {}, regular: {} };

export const library_system_default = {
  name: "system",
  resolver: resolveSystemIcon,
  mutator: mutateSystemIcon,
};
