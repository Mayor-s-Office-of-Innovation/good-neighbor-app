/*
  Presentational template for <location-dialog>: the "are you at the right
  site?" prompt shown before a check starts when the device is far from the
  bound site. Logic lives in location-dialog.js.
*/
import { html, escapeHtml, escapeAttr } from "../lib/html.js";

/**
 * The site options the prompt offers: the provider catalog with the bound
 * site guaranteed first when the catalog lacks it, or just the bound site.
 * @param {Array<{ siteId: string, name: string }>} providerSites
 * @param {{ siteId: string, name: string }} currentSite
 * @returns {Array<{ siteId: string, name: string }>}
 */
export function locationDialogSites(providerSites, currentSite) {
  const sites = providerSites.length ? [...providerSites] : [currentSite];
  if (!sites.some((site) => site.siteId === currentSite.siteId)) {
    sites.unshift(currentSite);
  }
  return sites;
}

/**
 * @param {{
 *   siteName: string,
 *   sites: Array<{ siteId: string, name: string }>,
 *   currentSiteId: string,
 * }} vm
 */
export function locationDialog({ siteName, sites, currentSiteId }) {
  return html`<dialog
    class="location-dialog"
    id="location-dialog"
    aria-labelledby="location-dialog-title"
    aria-describedby="location-dialog-copy"
  >
    <div class="location-dialog__card">
      <div class="location-dialog__copy">
        <h2 id="location-dialog-title">
          Is your app set to the right location?
        </h2>
        <p id="location-dialog-copy">
          It looks like you're not near ${escapeHtml(siteName)}. Consider
          changing your app's site.
        </p>
      </div>
      <div
        class="location-dialog__sites"
        role="group"
        aria-label="Choose a site"
      >
        ${sites
          .map(
            (site) =>
              html`<button
                class="home-site-switcher__item location-dialog__site"
                appearance="plain"
                type="button"
                data-location-site="${escapeAttr(site.siteId)}"
                aria-pressed="${site.siteId === currentSiteId
                  ? "true"
                  : "false"}"
              >
                <span class="home-site-switcher__check" aria-hidden="true"
                  >${site.siteId === currentSiteId ? "✓" : ""}</span
                >
                <span>${escapeHtml(site.name)}</span>
              </button>`,
          )
          .join("")}
      </div>
      <div class="location-dialog__actions">
        <button
          class="location-dialog__confirm"
          appearance="plain"
          id="location-confirm"
          type="button"
          disabled
        >
          Confirm site change
        </button>
        <button
          class="location-dialog__stay"
          appearance="plain"
          id="location-stay"
          type="button"
        >
          I'm in the right location
        </button>
      </div>
    </div>
  </dialog>`;
}
