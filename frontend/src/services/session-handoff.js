/*
  session-handoff.js — carry the device session into the Home Screen app.

  iOS Home Screen apps have independent IndexedDB storage. Preparing the
  handoff sets a Secure HttpOnly SameSite=Strict cookie that iOS copies at
  installation time. On a standalone launch without a binding, app-root
  redeems the cookie for an independent installation; Safari stays signed in.
  Preparation completes before showing the enrolled app, since people may
  use Safari's own installation menu immediately.

  The cached grant is revalidated server-side to restore its cookie on a
  returning page. A blob manifest with a fragment launch grant remains a
  fallback for older iOS versions. The fragment is stripped before awaiting
  anything; consumed fragment grants are remembered to avoid replaying them.
  Chromium keeps the static manifest and shares its installed app's storage.
  See docs/adr/0019-home-screen-session-continuity.md.

*/
import { getSite, saveSiteSettings } from "../db.js";
import { trackEvent } from "./analytics.js";
import { issueSessionHandoff, retireSessionHandoff } from "./api.js";
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
let installedBlobUrl = "";
let installedBindingKey = "";
/** @type {HandoffGrant | null} */
let installedGrant = null;
let preparationVersion = 0;
/** @type {Map<string, {promise: Promise<boolean>, controller: AbortController}>} */
const preparing = new Map();
export const PREPARATION_TIMEOUT_MS = 5000;
export const SIGNOUT_TIMEOUT_MS = 3000;

/** @param {(signal: AbortSignal) => Promise<boolean>} work @param {number} timeout */
function boundedHandoff(work, timeout) {
  const controller = new AbortController();
  const aborted = new Promise((_, reject) => {
    controller.signal.addEventListener(
      "abort",
      () => reject(controller.signal.reason),
      { once: true },
    );
  });
  const timer = setTimeout(() => controller.abort(), timeout);
  const promise = Promise.race([work(controller.signal), aborted]).finally(() =>
    clearTimeout(timer),
  );
  return { controller, promise: /** @type {Promise<boolean>} */ (promise) };
}
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

/** @returns {boolean} a handoff manifest is installed on this page. */
export function isHandoffPrepared() {
  return installedGrant !== null;
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
 * Put the static manifest back and forget the installed grant. Idempotent;
 * safe without a DOM.
 * @param {Document | undefined} [doc]
 */
export function uninstallHandoffManifest(doc = globalThis.document) {
  if (installedBlobUrl) {
    doc
      ?.querySelector?.('link[rel="manifest"]')
      ?.setAttribute("href", MANIFEST_PATH);
    URL.revokeObjectURL(installedBlobUrl);
  }
  installedBlobUrl = "";
  installedBindingKey = "";
  installedGrant = null;
  preparationVersion += 1;
}

/**
 * Sign-out. The page must stop offering the grant — an Add to Home Screen
 * from the still-open page would otherwise sign the next launch in to the
 * device just signed out of — and the server must stop honoring it. Call
 * BEFORE the session is cleared: the retire request is authorized. Never
 * throws; signing out must not depend on the network.
 * @param {{ site?: Record<string, any> | null, remote?: boolean }} [opts]
 *   `remote: false` skips the server call (the session is already dead)
 * @returns {Promise<boolean>} the server retired a pending grant
 */
export async function retireHandoff({ site, remote = true } = {}) {
  uninstallHandoffManifest();
  for (const { controller } of preparing.values()) controller.abort();
  if (!remote) return false;
  try {
    return await boundedHandoff(async (signal) => {
      const bound = site ?? (await getSite().catch(() => null));
      if (!bound?.token) return false;
      const result = await retireSessionHandoff({ signal, endSession: true });
      return Boolean(result?.retired);
    }, SIGNOUT_TIMEOUT_MS).promise;
  } catch (err) {
    console.error("handoff retire failed", err);
    return false;
  }
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

  const key = `${bound.siteId}:${bound.deviceId ?? ""}`;
  if (installedBindingKey === key && grantIsFresh(installedGrant)) return true;
  const existing = preparing.get(key);
  if (existing) return existing.promise;
  const version = preparationVersion;
  const locks = globalThis.navigator?.locks;
  const operation = boundedHandoff(
    (signal) =>
      locks
        ? locks.request(`gnp:handoff:${key}`, async () => {
            // Another tab may have prepared a grant while this one waited. Read
            // its cache so installing either tab won't supersede the other's grant.
            const current = await getSite();
            if (
              current?.siteId !== bound.siteId ||
              current?.deviceId !== bound.deviceId ||
              version !== preparationVersion
            )
              return false;
            if (signal.aborted) return false;
            return prepareManifest(current, key, version, signal);
          })
        : prepareManifest(bound, key, version, signal),
    PREPARATION_TIMEOUT_MS,
  );
  const pending = operation.promise;
  preparing.set(key, operation);
  try {
    return await pending;
  } finally {
    if (preparing.get(key) === operation) preparing.delete(key);
  }
}

/** @param {Record<string, any>} bound @param {string} key @param {number} version @param {AbortSignal} signal */
async function prepareManifest(bound, key, version, signal) {
  /** @type {HandoffGrant | null} */
  let grant = grantIsFresh(bound.handoff) ? bound.handoff : null;
  if (grant && grant.grantId === installedGrant?.grantId) return true;

  // The static manifest does not depend on the grant: fetch it while the
  // mint (when needed) is in flight.
  const {
    buildHandoffManifest,
    installManifest: install,
    fetchStaticManifest,
  } = await import("./handoff-manifest.js");
  if (signal.aborted || version !== preparationVersion) return false;
  const manifestPromise = fetchStaticManifest(signal);
  try {
    {
      // Even a cached grant needs its HttpOnly cookie reinstalled on this
      // page. Safari copies that cookie at installation time; the manifest
      // fragment remains a fallback for older iOS versions.
      const cached = grant
        ? readHandoffCredentials(
            new URL(grant.startUrl, globalThis.location.origin).href,
            null,
          )
        : null;
      const issued = await issueSessionHandoff(cached, signal);
      grant = {
        grantId: issued.grantId,
        expiresAt: issued.expiresAt,
        startUrl: issued.startUrl,
      };
      // Stored next to the refresh token it is equivalent to; clearing the
      // session clears it. Skipped when the binding changed mid-flight — the
      // same site re-bound to another device must not inherit this grant.
      if (signal.aborted || version !== preparationVersion) return false;
      const saved = await saveSiteSettings(
        { handoff: grant },
        bound.siteId,
        bound.deviceId,
      );
      if (!saved) return false;
      void trackEvent("handoff_grant_issued", {});
    }
    const base = await manifestPromise;
    if (signal.aborted || version !== preparationVersion) return false;
    installedBlobUrl = install(
      buildHandoffManifest(base, grant.startUrl, globalThis.location.origin),
      globalThis.document,
      installedBlobUrl,
    );
  } finally {
    // An early return or a thrown mint must not leave the fetch unobserved.
    manifestPromise.catch(() => {});
  }
  installedGrant = grant;
  installedBindingKey = key;
  for (const fn of preparedListeners) fn();
  return true;
}

/** Test seam: forget the installed manifest and listeners. */
export function resetHandoffManifest() {
  installedBlobUrl = "";
  installedBindingKey = "";
  installedGrant = null;
  preparationVersion += 1;
  for (const { controller } of preparing.values()) controller.abort();
  preparing.clear();
  preparedListeners.clear();
}
