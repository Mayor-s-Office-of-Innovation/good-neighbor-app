// One manager directory read per catalog, shared by the directory, Site manager, Program
// and Provider pages, so two pages on screen one after another never read it twice at once.
import { START_UP_LISTS } from "../../admin-catalog.js";
import { siteManagerActions } from "./manager.actions.js";

/**
 * @typedef {import("../../admin-catalog.js").AdminCatalog} AdminCatalog
 */

// Weak, so a page test's catalog and its read are dropped with the page.
/** @type {WeakMap<AdminCatalog, any>} */
const readers = new WeakMap();

/** @param {AdminCatalog} catalog */
function readerFor(catalog) {
  let reader = readers.get(catalog);
  if (!reader) {
    reader = {
      catalog,
      // fetchSiteManagers reads only catalog lists, so the read needs no session.
      state: {
        people: [],
        managerSearchFailed: false,
        get programs() {
          return catalog.programs;
        },
        get providers() {
          return catalog.providers;
        },
        get sites() {
          return catalog.sites;
        },
      },
      /** @type {any} */
      managerDirectoryLoader: null,
      loadSiteManagers: siteManagerActions.loadSiteManagers,
      fetchSiteManagers: siteManagerActions.fetchSiteManagers,
    };
    readers.set(catalog, reader);
  }
  return reader;
}

/**
 * Read the manager directory into the catalog, unless it's loaded.
 * @param {AdminCatalog} catalog
 * @param {boolean} [force]
 * @returns {Promise<void>}
 */
export function loadManagers(catalog, force = false) {
  return readerFor(catalog).loadSiteManagers(force);
}

/**
 * A new Site outdates a running read, so the next one starts fresh.
 * @param {AdminCatalog} catalog
 */
export function restartManagerLoad(catalog) {
  const reader = readers.get(catalog);
  if (reader) reader.managerDirectoryLoader = null;
}

/**
 * Read the manager directory when the URL has a ?q= search, so the search shows matches.
 * @param {AdminCatalog} catalog
 */
export async function loadManagersForSearch(catalog) {
  if (
    catalog.managersLoaded ||
    !new URLSearchParams(location.search).get("q")?.trim()
  )
    return;
  // Without the Site list the read finds no managers, yet would mark the list loaded.
  const sitesRead = await catalog
    .ensure([...START_UP_LISTS, "sites"])
    .then(() => true)
    .catch(() => false);
  if (!sitesRead) return;
  await loadManagers(catalog).catch(() => {});
}
