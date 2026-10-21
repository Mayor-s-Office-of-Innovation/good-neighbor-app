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

/** @typedef {{ grantId: string, token: string, expiresAt: string, startUrl: string }} HandoffGrant */

/** The blob: manifest currently installed on the page, for revocation. */
let installedBlobUrl = "";

/**
 * Handoff credentials from a launch URL's fragment, or null.
 * @param {string} [href]
 * @returns {{ grantId: string, token: string } | null}
 */
export function readHandoffCredentials(href = globalThis.location?.href) {
  if (!href) return null;
  try {
    const fragment = new URLSearchParams(new URL(href).hash.slice(1));
    const grantId = fragment.get(HANDOFF_GRANT_PARAM)?.trim() || "";
    const token = fragment.get(HANDOFF_TOKEN_PARAM)?.trim() || "";
    return grantId && token ? { grantId, token } : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} [href]
 * @returns {boolean}
 */
export function hasHandoffCredentials(href) {
  return readHandoffCredentials(href) !== null;
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
 * Only an iOS Safari page that is bound, not yet standalone, and not inside an
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
  if (!grant?.grantId || !grant.token || !grant.startUrl || !grant.expiresAt) {
    return false;
  }
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

/**
 * Mint (or reuse) the handoff grant for the bound device and install the
 * manifest that carries it. Resolves false when nothing was done: wrong
 * browser, already standalone, not bound, or the binding changed meanwhile.
 * Throws on request failure; the caller decides how loudly to log.
 * @param {{ method?: "prompt" | "ios" | null, standalone?: boolean, webview?: boolean, now?: number, fetchManifest?: () => Promise<Record<string, any>>, origin?: string }} [opts]
 * @returns {Promise<boolean>}
 */
export async function ensureHandoffManifest(opts = {}) {
  if (!shouldPrepareHandoff(opts)) return false;
  const site = await getSite().catch(() => null);
  if (!site?.siteId || !site.token) return false;

  /** @type {HandoffGrant | null} */
  let grant = grantIsFresh(site.handoff, opts.now) ? site.handoff : null;
  if (!grant) {
    const issued = await issueSessionHandoff();
    grant = {
      grantId: issued.grantId,
      token: issued.token,
      expiresAt: issued.expiresAt,
      startUrl: issued.startUrl,
    };
    // Stored next to the refresh token it is equivalent to; clearing the
    // session clears it. Skipped when the binding changed mid-flight.
    const saved = await saveSiteSettings({ handoff: grant }, site.siteId);
    if (!saved) return false;
    void trackEvent("handoff_grant_issued", {});
  }

  const fetchManifest = opts.fetchManifest ?? defaultFetchManifest;
  const base = await fetchManifest();
  const origin = opts.origin ?? globalThis.location.origin;
  installManifest(buildHandoffManifest(base, grant.startUrl, origin));
  return true;
}

/** @returns {Promise<Record<string, any>>} */
async function defaultFetchManifest() {
  const res = await fetch(MANIFEST_PATH, { cache: "no-store" });
  if (!res.ok) throw new Error(`manifest fetch failed (${res.status})`);
  return res.json();
}

/** Test seam: forget the installed blob URL. */
export function resetHandoffManifest() {
  installedBlobUrl = "";
}
