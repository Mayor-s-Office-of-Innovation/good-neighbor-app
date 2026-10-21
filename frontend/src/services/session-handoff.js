/*
  session-handoff.js — carry the device session into the Home Screen app.

  An iOS Home Screen web app runs in its own storage container, so the session
  in Safari's IndexedDB is absent on the first standalone launch and the person
  was asked for the setup code again. While a bound device runs in iOS Safari
  this service mints a short-lived, single-use handoff grant for its own
  binding (POST /app/v1/session-handoff), caches it on the site record, and
  swaps the page's manifest for one whose start_url carries the grant in the
  URL fragment. iOS stores start_url at install time; on the first standalone
  launch app-root finds the grant, has no session, and redeems it
  (services/devices.js redeemHandoffGrant) for a fresh token pair on the SAME
  device record. Plan: notes/pwa-session-handoff-plan.md.

  The installed app's start_url carries the grant for the life of the
  install, so a grant that was redeemed (or rejected for good) is remembered
  in the installed app's own localStorage and never presented again: a later
  cold launch after a sign-out lands on the plain setup screen, not on a
  doomed redeem.

  Chromium shares storage with the installed app and keeps the static
  manifest; the installed app itself (standalone) never mints. The fragment,
  not the query, carries the secret so it never reaches a server or a log.
*/
import { getSite, saveSiteSettings } from "../db.js";
import { trackEvent } from "./analytics.js";
import { issueSessionHandoff } from "./api.js";
import { isInAppBrowser } from "./browser-context.js";
import { installMethod, isStandalone } from "./install-prompt.js";

export const HANDOFF_GRANT_PARAM = "handoff_grant";
export const HANDOFF_TOKEN_PARAM = "handoff_token";
export const MANIFEST_PATH = "/manifest.webmanifest";
/** Re-mint when the cached grant has less than this left before it expires. */
export const RENEW_MARGIN_MS = 24 * 60 * 60 * 1000;
/** localStorage key: grant ids this install has already presented. */
export const CONSUMED_KEY = "handoff-consumed";
const CONSUMED_LIMIT = 8;

/**
 * What the site record caches. The token is inside `startUrl` and nowhere
 * else, so a sign-out (which drops the record) drops the secret with it.
 * @typedef {{ grantId: string, expiresAt: string, startUrl: string }} HandoffGrant
 */

/** The grant whose manifest is installed on this page, and its blob URL. */
let installedGrantId = "";
let installedBlobUrl = "";
/** @type {Set<() => void>} */
const preparedListeners = new Set();

/**
 * `window.localStorage` is a getter that THROWS when site data is blocked.
 * @returns {Storage | null}
 */
function safeStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Grant ids this install has already presented for redemption.
 * @param {Storage | null} [storage] test seam
 * @returns {string[]}
 */
export function consumedGrantIds(storage = safeStorage()) {
  try {
    const parsed = JSON.parse(storage?.getItem(CONSUMED_KEY) || "[]");
    return Array.isArray(parsed)
      ? parsed.filter((v) => typeof v === "string")
      : [];
  } catch {
    return [];
  }
}

/**
 * Remember that `grantId` has been presented, so the launch URL never yields
 * it again. Call after a redeem that succeeded or was rejected for good.
 * @param {string} grantId
 * @param {Storage | null} [storage] test seam
 */
export function rememberConsumedGrant(grantId, storage = safeStorage()) {
  try {
    const ids = consumedGrantIds(storage).filter((id) => id !== grantId);
    ids.push(grantId);
    storage?.setItem(CONSUMED_KEY, JSON.stringify(ids.slice(-CONSUMED_LIMIT)));
  } catch {
    // Private mode / quota: the next launch retries the redeem, which fails
    // the same way and lands on setup. Nothing worse.
  }
}

/**
 * Handoff credentials from a launch URL's fragment, or null — also null for
 * a grant this install has already presented.
 * @param {string} [href]
 * @param {Storage | null} [storage] test seam
 * @returns {{ grantId: string, token: string } | null}
 */
export function readHandoffCredentials(
  href = globalThis.location?.href,
  storage = safeStorage(),
) {
  if (!href) return null;
  try {
    const fragment = new URLSearchParams(new URL(href).hash.slice(1));
    const grantId = fragment.get(HANDOFF_GRANT_PARAM)?.trim() || "";
    const token = fragment.get(HANDOFF_TOKEN_PARAM)?.trim() || "";
    if (!grantId || !token) return null;
    if (consumedGrantIds(storage).includes(grantId)) return null;
    return { grantId, token };
  } catch {
    return null;
  }
}

/**
 * Remove the handoff credentials from the address bar and history entry.
 * Call synchronously, before anything awaits or reads the location.
 * @param {Location} [loc]
 * @param {History} [hist]
 */
export function stripHandoffCredentials(
  loc = globalThis.location,
  hist = globalThis.history,
) {
  try {
    const url = new URL(loc.href);
    const fragment = new URLSearchParams(url.hash.slice(1));
    if (
      !fragment.has(HANDOFF_GRANT_PARAM) &&
      !fragment.has(HANDOFF_TOKEN_PARAM)
    ) {
      return;
    }
    fragment.delete(HANDOFF_GRANT_PARAM);
    fragment.delete(HANDOFF_TOKEN_PARAM);
    url.hash = fragment.toString();
    hist.replaceState(null, "", url.pathname + url.search + url.hash);
  } catch {
    /* no-op */
  }
}

/**
 * Only an iOS Safari page that is not yet standalone and not inside an
 * in-app webview prepares a handoff. Pure given its inputs.
 * @param {{ method?: "prompt" | "ios" | null, standalone?: boolean, webview?: boolean }} [opts]
 * @returns {boolean}
 */
export function shouldPrepareHandoff({
  method = installMethod(),
  standalone = isStandalone(),
  webview = isInAppBrowser(),
} = {}) {
  return method === "ios" && !standalone && !webview;
}

/**
 * A cached grant is reused while it has more than the renew margin left.
 * @param {Partial<HandoffGrant> | undefined | null} grant
 * @param {number} [now]
 * @returns {grant is HandoffGrant}
 */
export function grantIsFresh(grant, now = Date.now()) {
  if (!grant?.grantId || !grant.startUrl || !grant.expiresAt) return false;
  const expiresAt = Date.parse(grant.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt - now > RENEW_MARGIN_MS;
}

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

/**
 * Point the page's manifest link at a blob: URL holding `manifest`. The
 * previous blob (if any) is revoked. Returns the new URL.
 * @param {Record<string, any>} manifest
 * @param {Document} [doc]
 * @returns {string}
 */
export function installManifest(manifest, doc = globalThis.document) {
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
  if (installedBlobUrl) URL.revokeObjectURL(installedBlobUrl);
  installedBlobUrl = url;
  return url;
}

/** @returns {boolean} a handoff manifest is installed on this page. */
export function isHandoffPrepared() {
  return installedGrantId !== "";
}

/**
 * Run `fn` once the handoff manifest is installed (immediately if it already
 * is). Lets the install card promise the carry-over only when it is true.
 * @param {() => void} fn
 * @returns {() => void} unsubscribe
 */
export function onHandoffPrepared(fn) {
  if (isHandoffPrepared()) fn();
  preparedListeners.add(fn);
  return () => preparedListeners.delete(fn);
}

/**
 * Mint (or reuse) the handoff grant for the bound device and install the
 * manifest that carries it. Resolves false when nothing was done: wrong
 * browser, already standalone, not bound, or the binding changed meanwhile.
 * Throws on request failure; the caller decides how loudly to log.
 * @param {{ site?: Record<string, any> | null }} [opts] the site record the
 *   caller already holds; read from IndexedDB when absent
 * @returns {Promise<boolean>}
 */
export async function ensureHandoffManifest({ site } = {}) {
  if (!shouldPrepareHandoff()) return false;
  const bound = site ?? (await getSite().catch(() => null));
  if (!bound?.siteId || !bound.token) return false;

  /** @type {HandoffGrant | null} */
  let grant = grantIsFresh(bound.handoff) ? bound.handoff : null;
  if (grant && grant.grantId === installedGrantId) return true;

  // The static manifest does not depend on the grant: fetch it while the
  // mint (when needed) is in flight.
  const manifestPromise = fetchStaticManifest();
  try {
    if (!grant) {
      const issued = await issueSessionHandoff();
      grant = {
        grantId: issued.grantId,
        expiresAt: issued.expiresAt,
        startUrl: issued.startUrl,
      };
      // Stored next to the refresh token it is equivalent to; clearing the
      // session clears it. Skipped when the binding changed mid-flight.
      const saved = await saveSiteSettings({ handoff: grant }, bound.siteId);
      if (!saved) return false;
      void trackEvent("handoff_grant_issued", {});
    }
    const base = await manifestPromise;
    installManifest(
      buildHandoffManifest(base, grant.startUrl, globalThis.location.origin),
    );
  } finally {
    // An early return or a thrown mint must not leave the fetch unobserved.
    manifestPromise.catch(() => {});
  }
  installedGrantId = grant.grantId;
  for (const fn of preparedListeners) fn();
  return true;
}

/** @returns {Promise<Record<string, any>>} */
async function fetchStaticManifest() {
  const res = await fetch(MANIFEST_PATH);
  if (!res.ok) throw new Error(`manifest fetch failed (${res.status})`);
  return res.json();
}

/** Test seam: forget the installed manifest and listeners. */
export function resetHandoffManifest() {
  installedGrantId = "";
  installedBlobUrl = "";
  preparedListeners.clear();
}
