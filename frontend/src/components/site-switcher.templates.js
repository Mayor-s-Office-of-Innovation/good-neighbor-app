/*
  Presentational template for <site-switcher>. Logic lives in
  site-switcher.js; this file owns only the trigger + menu markup.

  The location dialog (today-view.templates.js) reuses the
  .home-site-switcher__item / __check classes for its site list.
*/
import { html, escapeHtml, escapeAttr } from "../lib/html.js";

/**
 * The list the menu shows: the provider catalog, or just the bound site when
 * the catalog is empty or failed. The bound site is always present.
 * @param {Array<{ siteId: string, name: string }>} providerSites
 * @param {{ siteId: string, name: string }} currentSite
 * @returns {Array<{ siteId: string, name: string }>}
 */
export function switcherSites(providerSites, currentSite) {
  const sites = providerSites.length ? [...providerSites] : [currentSite];
  if (!sites.some((site) => site.siteId === currentSite.siteId)) {
    sites.push(currentSite);
  }
  return sites;
}

/**
 * @param {{
 *   providerName: string,
 *   sites: Array<{ siteId: string, name: string }>,
 *   currentSiteId: string,
 *   open: boolean,
 *   error: string,
 *   status: string,
 * }} vm
 */
export function siteSwitcher({
  providerName,
  sites,
  currentSiteId,
  open,
  error,
  status,
}) {
  return html`
    <div class="home-site-switcher">
      <button
        id="site-switcher-trigger"
        class="home-site-switcher__trigger"
        type="button"
        aria-expanded="${open ? "true" : "false"}"
        aria-controls="site-switcher-list"
      >
        <span>${escapeHtml(providerName || "Your provider")}</span>
        <wa-icon name="chevron-left" aria-hidden="true"></wa-icon>
      </button>
      ${open
        ? html`<div id="site-switcher-list" class="home-site-switcher__menu">
            ${sites
              .map(
                (site) =>
                  html`<button
                    class="home-site-switcher__item ${site.siteId ===
                    currentSiteId
                      ? "home-site-switcher__item--selected"
                      : ""}"
                    type="button"
                    data-switch-site="${escapeAttr(site.siteId)}"
                    ${site.siteId === currentSiteId
                      ? 'aria-current="page"'
                      : ""}
                  >
                    <span class="home-site-switcher__check" aria-hidden="true"
                      >${site.siteId === currentSiteId ? "✓" : ""}</span
                    >
                    <span>${escapeHtml(site.name)}</span>
                  </button>`,
              )
              .join("")}
            ${error
              ? html`<p class="home-site-switcher__error" role="alert">
                  ${escapeHtml(error)}
                </p>`
              : ""}
            ${status === "loading"
              ? html`<p class="home-site-switcher__status" role="status">
                  Loading sites…
                </p>`
              : ""}
            ${status === "error"
              ? html`<div class="home-site-switcher__failure">
                  <p role="alert">Other sites couldn't load.</p>
                  <button id="site-catalog-retry" type="button">Retry</button>
                </div>`
              : ""}
          </div>`
        : ""}
    </div>
  `;
}
