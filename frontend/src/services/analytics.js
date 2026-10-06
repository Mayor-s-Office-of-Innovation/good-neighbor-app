/*
  analytics.js — lean client analytics (no vendor SDK).

  Sends allowlisted app events (`$pageview`, site setup, camera hand-offs,
  capture auto-resume) to our own intake, `POST /v1/client-events`, via
  navigator.sendBeacon; the Lambda scrubs again, parses the user agent into
  browser/OS/device properties, and forwards to PostHog as plain named events
  (backend/src/handlers/event-forwarder.js). Nothing here talks to PostHog
  directly and no third-party script ships.

  Why it exists: the field question "which devices and browsers misbehave?"
  needs per-device page views with device facts attached. Properties sent from
  here are the facts the user-agent header cannot carry — screen/viewport,
  device memory, cores, connection type, display mode, and the UA client hints
  for platform version / model (frozen out of the UA string on modern Chrome).

  Conventions mirror services/error-report.js:
  - `localStorage['gnp:analytics'] = 'off'` kills it; `'on'` forces it on
  - off under the test runner (MODE === 'test')
  - never throws; dropped silently when storage/navigator are unavailable
  - query strings never leave the device (the onboarding link carries a code)
  Event names and property keys are allowlisted server-side
  (scrub-client-event.js); anything not listed there is dropped on arrival.
*/

import {
  distinctId,
  flagEnabled,
  release,
  sendBeacon,
} from "./error-report.js";

const ENDPOINT = "/v1/client-events";
const FLAG_KEY = "gnp:analytics";

/** @typedef {Record<string, string | number | boolean>} EventProperties */

/**
 * Navigator plus the non-standard / newer members this module reads.
 * @typedef {Navigator & {
 *   deviceMemory?: number,
 *   connection?: { effectiveType?: string },
 *   userAgentData?: {
 *     platform?: string,
 *     mobile?: boolean,
 *     getHighEntropyValues?: (hints: string[]) => Promise<Record<string, string | undefined>>,
 *   },
 * }} ExtendedNavigator
 */

/** @returns {ExtendedNavigator} */
function nav() {
  return /** @type {ExtendedNavigator} */ (navigator);
}

/**
 * Enablement: `gnp:analytics=off` wins; `on` overrides test mode; otherwise
 * on except under the test runner (shared gate in error-report.js).
 * @returns {boolean}
 */
export function analyticsEnabled() {
  return flagEnabled(FLAG_KEY);
}

/**
 * Send one event. Device properties are merged beneath the caller's, so a
 * caller can override nothing by accident but may add app facts freely.
 * Resolves true when a beacon or request was handed to the browser.
 * @param {string} event
 * @param {EventProperties} [properties]
 * @returns {Promise<boolean>}
 */
export async function trackEvent(event, properties = {}) {
  if (!analyticsEnabled()) return false;
  try {
    const hints = await clientHints();
    return sendBeacon(
      {
        event,
        properties: { ...deviceProperties(), ...hints, ...properties },
        id: distinctId(),
        release: release(),
        ts: new Date().toISOString(),
      },
      ENDPOINT,
    );
  } catch {
    return false;
  }
}

/** @type {string | null} */
let lastPageViewPath = null;
let firstPageView = true;

/**
 * One `$pageview` per distinct route landing. Consecutive views of the same
 * pathname collapse (re-navigating to the current route re-renders, it does
 * not re-view). The first view of a document also carries how it was loaded
 * and where it came from — the relaunch signature the Android camera
 * investigation needs.
 * @param {string} pathname route pathname, no query/hash
 * @returns {Promise<boolean>}
 */
export function trackPageView(pathname) {
  if (!pathname || pathname === lastPageViewPath) return Promise.resolve(false);
  lastPageViewPath = pathname;
  /** @type {EventProperties} */
  const props = { $pathname: pathname };
  const url = currentUrl(pathname);
  if (url) props.$current_url = url;
  if (firstPageView) {
    firstPageView = false;
    const nav = navigationType();
    if (nav) props.navigation_type = nav;
    const ref = referringDomain();
    if (ref) props.$referring_domain = ref;
  }
  return trackEvent("$pageview", props);
}

/**
 * Boot wiring: view the current route now and every route change after.
 * Takes the router's functions as arguments so this module has no router
 * dependency (and tests need no history stub).
 * @param {{ currentRoute: () => string, onRouteChange: (fn: (route: string) => void) => () => void }} router
 * @returns {() => void} unsubscribe
 */
export function startPageViewTracking({ currentRoute, onRouteChange }) {
  void trackPageView(currentRoute());
  return onRouteChange((route) => {
    void trackPageView(route);
  });
}

/**
 * Synchronous device facts. Every read is guarded and only present, finite
 * values are included, so a stubbed or exotic environment yields fewer keys
 * rather than a throw.
 * @returns {EventProperties}
 */
export function deviceProperties() {
  /** @type {EventProperties} */
  const p = {};
  const put = (
    /** @type {string} */ key,
    /** @type {() => unknown} */ read,
  ) => {
    try {
      const v = read();
      if (typeof v === "string" && v) p[key] = v;
      else if (typeof v === "number" && Number.isFinite(v)) p[key] = v;
      else if (typeof v === "boolean") p[key] = v;
    } catch {
      // unavailable in this environment
    }
  };
  put("$screen_width", () => screen.width);
  put("$screen_height", () => screen.height);
  put("$viewport_width", () => window.innerWidth);
  put("$viewport_height", () => window.innerHeight);
  put("device_pixel_ratio", () => window.devicePixelRatio);
  put("$browser_language", () => navigator.language);
  put("device_memory_gb", () => nav().deviceMemory);
  put("hardware_concurrency", () => navigator.hardwareConcurrency);
  put("connection_type", () => nav().connection?.effectiveType);
  put("display_mode", () =>
    window.matchMedia("(display-mode: standalone)").matches
      ? "standalone"
      : "browser",
  );
  put("platform", () => nav().userAgentData?.platform);
  put("ua_mobile", () => nav().userAgentData?.mobile);
  return p;
}

/** @type {Promise<EventProperties> | null} */
let hintsPromise = null;

/**
 * UA client hints that need the async high-entropy API: the real OS version
 * and device model. Fetched once per document; `{}` wherever unsupported.
 * @returns {Promise<EventProperties>}
 */
function clientHints() {
  if (hintsPromise) return hintsPromise;
  hintsPromise = (async () => {
    /** @type {EventProperties} */
    const out = {};
    try {
      const data = nav().userAgentData;
      if (!data?.getHighEntropyValues) return out;
      const hv = await data.getHighEntropyValues(["platformVersion", "model"]);
      if (hv?.platformVersion)
        out.platform_version = String(hv.platformVersion);
      if (hv?.model) out.device_model = String(hv.model);
    } catch {
      // hints unsupported or denied
    }
    return out;
  })();
  return hintsPromise;
}

/**
 * How this document was loaded: "navigate", "reload", "back_forward",
 * "prerender", or "" when the timeline is unavailable.
 * @returns {string}
 */
export function navigationType() {
  try {
    const entry = /** @type {PerformanceNavigationTiming | undefined} */ (
      performance.getEntriesByType("navigation")[0]
    );
    return entry?.type || "";
  } catch {
    return "";
  }
}

/**
 * Referrer host only (never the path or query).
 * @returns {string}
 */
export function referringDomain() {
  try {
    return document.referrer ? new URL(document.referrer).host : "";
  } catch {
    return "";
  }
}

/**
 * Origin + pathname, never the live href (which may carry `?code=`).
 * @param {string} pathname
 * @returns {string}
 */
function currentUrl(pathname) {
  try {
    return location.origin ? `${location.origin}${pathname}` : "";
  } catch {
    return "";
  }
}
