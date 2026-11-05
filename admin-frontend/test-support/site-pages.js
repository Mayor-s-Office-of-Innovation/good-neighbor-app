// The Site and Site manager pages mounted alone, each allowed only its own calls.
import { mountPage } from "./admin-dom.js";
// Loads only these two pages, so a Site page test file needn't load main.js.
import "../src/pages/site/site-page.js";
import "../src/pages/site/manager-page.js";

/** The Site page's reads and saves; a start-up list read fails a page test. */
export const siteCalls = [
  /^\w+ sites\/[^/?]+(\?|\/|$)/,
  /^(GET|POST) people$/,
  /^GET programs\/[^/]+$/,
  /^POST programs$/,
  /^GET program-managers$/,
  /^POST admin-users$/,
  /^POST oversight-options$/,
  /^POST address-suggestions$/,
  /^(GET|POST) physical-devices\//,
  /^(GET|POST) emergency-site-revocations/,
];

/** The manager page's directory reads and saves. */
export const managerCalls = [
  /^GET people$/,
  /^(POST|PATCH) people(\/[^/]+)?$/,
  /^POST people\/[^/]+\/devices:revoke$/,
  /^GET programs\/[^/]+$/,
  /^\w+ programs\/[^/]+\/users(\/|$)/,
  /^GET sites\/[^/?]+(\?roster=1)?$/,
  /^\w+ sites\/[^/]+\/(manager-memberships|users)(\/|$)/,
];

/**
 * @param {string} path
 * @param {Omit<Parameters<typeof mountPage>[2], "calls">} [options]
 */
export function openSitePage(path, options = {}) {
  return mountPage("admin-site-page", path, { calls: siteCalls, ...options });
}

/**
 * The manager form lists Sites, so the page reads them before it shows.
 * @param {string} path
 * @param {Omit<Parameters<typeof mountPage>[2], "calls">} [options]
 */
export function openManagerPage(path, options = {}) {
  return mountPage("admin-site-manager-page", path, {
    calls: managerCalls,
    sites: true,
    ...options,
  });
}
