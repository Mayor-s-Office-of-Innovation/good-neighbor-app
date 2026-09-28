/*
  provider-sites — the provider's full site catalog for the site switcher and
  the location prompt. Pages through listProviderSites, de-duplicates by
  siteId, and sorts by name. Throws on an inconsistent listing (provider
  changed mid-walk, repeated cursor, malformed page) so the caller shows the
  retryable failure state rather than a partial list.
*/
import { listProviderSites } from "./api.js";

/**
 * @returns {Promise<{ providerName: string, sites: Array<{ siteId: string, name: string }> }>}
 */
export async function fetchProviderSites() {
  const sites = new Map();
  const seenCursors = new Set();
  let cursor = "";
  let providerId = "";
  let providerName = "";
  do {
    const page = await listProviderSites(cursor);
    if (!page || !Array.isArray(page.sites)) {
      throw new Error("Invalid provider sites response");
    }
    if (providerId && page.providerId !== providerId) {
      throw new Error("Provider changed during site listing");
    }
    providerId = String(page.providerId || "");
    providerName = String(page.providerName || providerName);
    for (const site of page.sites) {
      if (site?.siteId) sites.set(site.siteId, site);
    }
    cursor = page.nextCursor || "";
    if (cursor && seenCursors.has(cursor)) {
      throw new Error("Repeated provider sites cursor");
    }
    if (cursor) seenCursors.add(cursor);
  } while (cursor);
  return {
    providerName,
    sites: [...sites.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}
