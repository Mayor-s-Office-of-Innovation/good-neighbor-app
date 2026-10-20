/*
  install-prompt.js — "Add to Home Screen" offers.

  Two install paths, one state model:

  - Chromium (Android Chrome, desktop Chrome/Edge): the browser fires
    `beforeinstallprompt` once the page is installable. main.js calls
    captureInstallPrompt() before anything else mounts so the event is held
    instead of lost, and the banner's Install button replays it with
    prompt(). No event → no banner (the browser decided it isn't installable
    here, or it is already installed).
  - iOS Safari: there is no event and no API — the user adds the app through
    the Share sheet — so the banner shows the two-step instruction instead.

  Never offered when the page already runs standalone, inside an in-app
  webview (the camera is broken there; that banner wins), on Chromium before
  the event fires, or on other browsers. "Not now" snoozes the offer for two
  weeks; after two dismissals it stays away for good. State lives in
  localStorage under one key, next to the theme override.
*/
import { isInAppBrowser } from "./browser-context.js";
import { trackEvent } from "./analytics.js";

export const STORAGE_KEY = "install-prompt";
export const SNOOZE_MS = 14 * 24 * 60 * 60 * 1000;
export const MAX_DISMISSALS = 2;

/** @typedef {{ dismissedAt?: number, dismissals?: number, installed?: boolean }} InstallState */
/** @typedef {Event & { prompt: () => Promise<void>, userChoice: Promise<{ outcome: "accepted" | "dismissed" }> }} BeforeInstallPromptEvent */

/** @type {BeforeInstallPromptEvent | null} */
let deferredEvent = null;
/** @type {Set<() => void>} */
const availableListeners = new Set();
/** @type {Set<() => void>} */
const installedListeners = new Set();
let captured = false;

const win = () => (typeof window !== "undefined" ? window : undefined);
const nav = () => (typeof navigator !== "undefined" ? navigator : undefined);

/**
 * `window.localStorage` is a getter that THROWS (SecurityError) when site
 * data is blocked, so it must be read inside a try — never as a default
 * parameter, where a throw escapes before the function body runs.
 * @returns {Storage | null}
 */
function safeStorage() {
  try {
    return win()?.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Hold the browser's install prompt for later. Call once, as early as
 * possible in the module graph — the event fires only once per page load.
 * @param {Window | undefined} [w]
 */
export function captureInstallPrompt(w = win()) {
  if (!w || captured) return;
  captured = true;
  w.addEventListener("beforeinstallprompt", (event) => {
    // Chrome's own mini-infobar is suppressed; the app offers on its terms.
    event.preventDefault();
    deferredEvent = /** @type {BeforeInstallPromptEvent} */ (event);
    // The browser never fires this while the app is installed, so a stored
    // `installed` flag is stale (uninstalled since): clear it so the offer
    // returns on the next launch instead of being vetoed forever.
    const state = readState();
    if (state.installed) writeState({ ...state, installed: false });
    for (const fn of availableListeners) fn();
  });
  w.addEventListener("appinstalled", () => {
    deferredEvent = null;
    writeState({ ...readState(), installed: true });
    void trackEvent("app_installed", {});
    for (const fn of installedListeners) fn();
  });
}

/** Test seam: forget any held event and listeners. */
export function resetInstallPrompt() {
  deferredEvent = null;
  availableListeners.clear();
  installedListeners.clear();
  captured = false;
}

/**
 * Run `fn` when a held install prompt becomes available (immediately if it
 * already is). Returns an unsubscribe.
 * @param {() => void} fn
 * @returns {() => void}
 */
export function onInstallAvailable(fn) {
  if (deferredEvent) fn();
  availableListeners.add(fn);
  return () => availableListeners.delete(fn);
}

/**
 * Run `fn` when the app gets installed by any route (our prompt or the
 * browser's own menu) so a visible offer can withdraw. Returns an unsubscribe.
 * @param {() => void} fn
 * @returns {() => void}
 */
export function onAppInstalled(fn) {
  installedListeners.add(fn);
  return () => installedListeners.delete(fn);
}

/** @returns {boolean} the page runs as an installed app already. */
export function isStandalone(w = win(), n = nav()) {
  if (n && /** @type {any} */ (n).standalone === true) return true;
  return Boolean(
    w &&
      typeof w.matchMedia === "function" &&
      w.matchMedia("(display-mode: standalone)").matches,
  );
}

/**
 * iOS Safari (including iPadOS, which presents as a Mac with touch) — the
 * only iOS browser where "Add to Home Screen" yields a standalone app.
 * @param {string} ua
 * @param {{ platform?: string, maxTouchPoints?: number } | undefined} n
 * @returns {boolean}
 */
export function isIosSafari(ua = nav()?.userAgent ?? "", n = nav()) {
  if (typeof ua !== "string" || !ua) return false;
  const iPadOs = n?.platform === "MacIntel" && (n.maxTouchPoints ?? 0) > 1;
  if (!/iPhone|iPad|iPod/.test(ua) && !iPadOs) return false;
  if (!/Safari/.test(ua)) return false;
  // Third-party iOS browsers install via their own menus (or not at all).
  if (/CriOS|FxiOS|EdgiOS|OPT\/|DuckDuckGo|BraveiOS/.test(ua)) return false;
  return !isInAppBrowser(ua);
}

/**
 * How this browser can install: "prompt" (held beforeinstallprompt — or one
 * that may still arrive on Chromium), "ios" (Share-sheet instructions), or
 * null (nothing to offer).
 * @returns {"prompt" | "ios" | null}
 */
export function installMethod(ua = nav()?.userAgent ?? "", n = nav()) {
  if (isIosSafari(ua, n)) return "ios";
  if (deferredEvent) return "prompt";
  // Chromium announces installability with the event; everything else is
  // silent. The "prompt" path is confirmed by onInstallAvailable, so the
  // banner only renders once the event has actually been held.
  return typeof ua === "string" && /Chrome|Chromium|Edg/.test(ua)
    ? "prompt"
    : null;
}

/** @returns {boolean} the Install button can call prompt() right now. */
export function hasHeldPrompt() {
  return deferredEvent !== null;
}

/**
 * @param {Storage | null} [storage] test seam; defaults to localStorage
 * @returns {InstallState}
 */
export function readState(storage) {
  try {
    const raw = (storage ?? safeStorage())?.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * @param {InstallState} state
 * @param {Storage | null} [storage] test seam; defaults to localStorage
 */
export function writeState(state, storage) {
  try {
    (storage ?? safeStorage())?.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Private mode / quota: the offer simply shows again next load.
  }
}

/**
 * Should the banner be mounted at all this session? Pure given its inputs.
 * @param {{ now?: number, state?: InstallState, method?: "prompt" | "ios" | null, standalone?: boolean, webview?: boolean }} [opts]
 * @returns {boolean}
 */
export function shouldOfferInstall({
  now = Date.now(),
  state = readState(),
  method = installMethod(),
  standalone = isStandalone(),
  webview = isInAppBrowser(),
} = {}) {
  if (!method || standalone || webview || state.installed) return false;
  const dismissals = state.dismissals ?? 0;
  if (dismissals >= MAX_DISMISSALS) return false;
  if (state.dismissedAt && now - state.dismissedAt < SNOOZE_MS) return false;
  return true;
}

/**
 * "Not now": snooze, counting toward the permanent stop.
 * @param {number} [now]
 */
export function dismissInstall(now = Date.now()) {
  const state = readState();
  writeState({
    ...state,
    dismissedAt: now,
    dismissals: (state.dismissals ?? 0) + 1,
  });
}

/**
 * Replay the held browser prompt. Must run from a user gesture.
 * @returns {Promise<"accepted" | "dismissed" | null>} null when nothing was held.
 */
export async function promptInstall() {
  const event = deferredEvent;
  if (!event) return null;
  deferredEvent = null; // a prompt event is single-use
  try {
    await event.prompt();
    const { outcome } = await event.userChoice;
    if (outcome === "accepted") writeState({ ...readState(), installed: true });
    return outcome;
  } catch {
    return "dismissed";
  }
}
