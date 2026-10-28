/**
 * The static manifest with every URL made absolute (a blob: manifest has no
 * base to resolve against) and start_url pointed at the handoff launch URL.
 * @param {Record<string, any>} manifest the static manifest, parsed
 * @param {string} startUrl e.g. "/#handoff_grant=…&handoff_token=…"
 * @param {string} origin the page's own origin — never a config value
 * @returns {Record<string, any>}
 */
export function buildHandoffManifest(manifest, startUrl, origin) {
  /** @param {string} path */
  const absolute = (path) => new URL(path, origin).href;
  return {
    ...manifest,
    id: absolute(manifest.id ?? "/"),
    scope: absolute(manifest.scope ?? "/"),
    start_url: absolute(startUrl),
    icons: (manifest.icons ?? []).map(
      (/** @type {Record<string, any>} */ icon) => ({
        ...icon,
        src: absolute(icon.src),
      }),
    ),
  };
}

/** @param {Record<string, any>} manifest @param {Document} doc @param {string} [previousUrl] */
export function installManifest(manifest, doc, previousUrl = "") {
  const blob = new Blob([JSON.stringify(manifest)], {
    type: "application/manifest+json",
  });
  const url = URL.createObjectURL(blob);
  let link = doc.querySelector('link[rel="manifest"]');
  if (!link) {
    link = doc.createElement("link");
    link.setAttribute("rel", "manifest");
    doc.head.append(link);
  }
  link.setAttribute("href", url);
  if (previousUrl) URL.revokeObjectURL(previousUrl);
  return url;
}

/** @param {AbortSignal} signal @returns {Promise<Record<string, any>>} */
export async function fetchStaticManifest(signal) {
  const res = await fetch("/manifest.webmanifest", { signal });
  if (!res.ok) throw new Error(`manifest fetch failed (${res.status})`);
  return res.json();
}
