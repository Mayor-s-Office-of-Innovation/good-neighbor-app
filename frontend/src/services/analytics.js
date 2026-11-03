/*
  analytics.js — lean client analytics (no vendor SDK).

  Sends allowlisted app events (`$pageview`, site setup, camera hand-offs,
  capture auto-resume) to our own intake, `POST /v1/client-events`, via
  navigator.sendBeacon; the Lambda scrubs again, parses the user agent into
  browser/OS/device properties, and forwards to PostHog as plain named events
  (backend/src/handlers/event-forwarder.js). Nothing here talks to PostHog
  directly and no third-party script ships.

  Events are queued and flushed as one beacon (`{ batch: [...] }`) after a
  short delay, when the queue fills, or when the page is hidden/unloaded. A
  four-photo perimeter check emits ~55 events; one beacon each meant one
  intake Lambda invocation each, every one held for a PostHog round trip, and
  a few concurrent users exhausted the intake's reserved concurrency. Batched,
  a check costs a handful of invocations and PostHog is called once per batch.

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
/** Quiet period after an event before the queue is flushed. */
export const FLUSH_DELAY_MS = 2000;
/**
 * Flush before a batch body would exceed this many serialized bytes. The WAF
 * blocks request bodies over the managed 8 KiB limit on this path
 * (SizeRestrictions_Body, infra/modules/app/main.tf), and a photo_pipeline
 * event with device facts is ~750 bytes, so 6 KiB holds roughly eight of
 * them with room for the envelope. sendBeacon's own 64 KB cap is never near.
 */
export const MAX_BATCH_BYTES = 6144;
/**
 * Count cap as a second guard; the byte budget above is the one that
 * normally triggers. Matches the intake's per-request cap
 * (backend/src/handlers/client-events-batch.js).
 */
export const MAX_BATCH = 25;
/** Longest user agent sent in the envelope (the server caps at the same). */
const MAX_USER_AGENT = 500;

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
 * Queue one event. Device properties are merged beneath the caller's, so a
 * caller can override nothing by accident but may add app facts freely.
 * Resolves true when the event was queued for the next flush.
 * @param {string} event
 * @param {EventProperties} [properties]
 * @returns {Promise<boolean>}
 */
export async function trackEvent(event, properties = {}) {
  if (!analyticsEnabled()) return false;
  try {
    const hints = await clientHints();
    enqueue({
      event,
      properties: { ...deviceProperties(), ...hints, ...properties },
      id: distinctId(),
      release: release(),
      ts: new Date().toISOString(),
    });
    return true;
  } catch {
    return false;
  }
}

/** @typedef {{ event: string, properties: EventProperties, id: string, release: string, ts: string }} QueuedEvent */

/** @type {QueuedEvent[]} */
let queue = [];
/** Serialized bytes of the queued events (commas included). */
let queueBytes = 0;
/** @type {ReturnType<typeof setTimeout> | null} */
let flushTimer = null;
let lifecycleHooked = false;

/**
 * @param {QueuedEvent} item
 */
function enqueue(item) {
  hookLifecycle();
  const bytes = byteLength(JSON.stringify(item)) + 1;
  // Flush what is queued first if this event would push the body over
  // budget; the event itself always goes out in the next batch.
  if (queue.length > 0 && queueBytes + bytes > MAX_BATCH_BYTES) {
    flushEvents();
  }
  queue.push(item);
  queueBytes += bytes;
  // A full batch, or an event queued after the page already went hidden
  // (the hidden flush has run; the camera or a tab switch may freeze or
  // kill the document before a timer fires), goes out now.
  if (queue.length >= MAX_BATCH || pageHidden()) {
    flushEvents();
    return;
  }
  if (flushTimer === null) {
    flushTimer = setTimeout(flushEvents, FLUSH_DELAY_MS);
  }
}

/** @returns {boolean} */
function pageHidden() {
  try {
    return document.visibilityState === "hidden";
  } catch {
    return false;
  }
}

/**
 * UTF-8 size of a string, which is what the WAF measures. String length
 * counts UTF-16 code units and under-reads non-ASCII device models or
 * languages; TextEncoder is everywhere this app runs, with length as the
 * (over-optimistic) fallback.
 * @param {string} s
 * @returns {number}
 */
function byteLength(s) {
  try {
    return new TextEncoder().encode(s).length;
  } catch {
    return s.length;
  }
}

/**
 * The user agent travels inside the body rather than as a header the server
 * reads: in deployed environments API Gateway hands the body to SQS verbatim
 * and a header could only reach the consumer by being spliced into JSON on
 * the gateway, which cannot escape it. The server caps and parses it the
 * same way it did the header (backend/src/lib/user-agent.js).
 * @returns {string | undefined}
 */
function userAgent() {
  try {
    const ua = navigator.userAgent;
    return typeof ua === "string" && ua
      ? ua.slice(0, MAX_USER_AGENT)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Send everything queued as one beacon. Safe to call at any time; a no-op
 * with an empty queue. Returns true when a beacon or request was handed to
 * the browser. Exported for tests and for callers that know the page is
 * about to go away.
 * @returns {boolean}
 */
export function flushEvents() {
  try {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (queue.length === 0) return false;
    const batch = queue;
    queue = [];
    queueBytes = 0;
    const ua = userAgent();
    // Best effort: a batch the browser refuses is dropped, never retried or
    // re-queued, so a failing intake can never back up memory or requests.
    return sendBeacon({ batch, ...(ua ? { ua } : {}) }, ENDPOINT);
  } catch {
    // Runs from timers and lifecycle listeners: never let telemetry throw
    // into the page (it would only turn into a client-error report).
    queue = [];
    queueBytes = 0;
    return false;
  }
}

/**
 * Flush when the page is hidden or unloading, so events queued right before
 * a camera hand-off, tab switch, or close are not lost with the document.
 * Installed lazily on the first event so environments without a document
 * (tests, workers) never touch it.
 */
function hookLifecycle() {
  if (lifecycleHooked) return;
  lifecycleHooked = true;
  try {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flushEvents();
    });
    window.addEventListener("pagehide", () => {
      flushEvents();
    });
  } catch {
    // no document/window listeners here; the timer flush still runs
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
