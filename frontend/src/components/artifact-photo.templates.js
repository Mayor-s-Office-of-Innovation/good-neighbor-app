import { html, escapeAttr } from "../lib/html.js";

/** An image whose expiring URL is owned by <artifact-photo>, not the browser's
 * parser. Keeping the initial URL in data-src prevents an expired fetch before
 * the element can renew it. Local capture blob/data URLs work without IDs.
 * @param {{src?:string, original?:string, checkId?:string, artifactId?:string, alt?:string, className?:string}} options
 */
export function artifactPhoto({
  src = "",
  original = "",
  checkId = "",
  artifactId = "",
  alt = "",
  className = "",
}) {
  return html`<artifact-photo
    class="${escapeAttr(className)}"
    data-check-id="${escapeAttr(checkId)}"
    data-artifact-id="${escapeAttr(artifactId)}"
    data-original="${escapeAttr(original)}"
    ><img
      data-src="${escapeAttr(src)}"
      alt="${escapeAttr(alt)}"
      loading="lazy"
      decoding="async"
  /></artifact-photo>`;
}
