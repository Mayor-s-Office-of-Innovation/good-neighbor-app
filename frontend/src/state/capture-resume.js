/*
  capture-resume — put the user back on the capture screen when the document
  died while the camera was open.

  Field finding (2026-10): on older Android devices the browser process is
  killed while the camera app is in the foreground. When the user returns the
  tab is relaunched, often at the entry URL (/ or the onboarding link) rather
  than at /check, so they land on home and have to tap "Resume a check". The
  draft itself survives in IndexedDB; only the in-memory session and the URL
  are lost.

  A tiny localStorage marker bridges the gap: the capture screen writes
  { route, at } when it hands off to the camera and removes it when the pick
  comes back or the screen unmounts. A marker that is still present at boot
  therefore means the document died abnormally. app-root reads it before the
  first render and, if a draft for that flow exists, replaces home with the
  capture route. The TTL keeps a marker from an hours-old crash from hijacking
  a deliberate visit to home.
*/

import { navigationType, referringDomain } from "../services/analytics.js";

const KEY = "gnp:camera-open";
/** How long an unanswered camera hand-off stays eligible for auto-resume. */
export const CAMERA_OPEN_TTL_MS = 10 * 60 * 1000;

/** Capture routes and the draft flow each one resumes. */
const ROUTE_FLOWS = /** @type {const} */ ({
  "/check": "perimeter",
  "/problem": "single-problem",
});

/**
 * @typedef {object} CameraOpenMarker
 * @property {string} route capture route that opened the camera
 * @property {number} at epoch ms when the camera was opened
 * @property {number} ageMs ms elapsed when the marker was read
 */

/**
 * Record that `route` just handed off to the camera.
 * @param {string} route
 * @param {number} [now]
 * @returns {void}
 */
export function markCameraOpen(route, now = Date.now()) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ route, at: now }));
  } catch {
    // Storage unavailable: auto-resume is best-effort.
  }
}

/** @returns {void} */
export function clearCameraOpen() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing to clear.
  }
}

/**
 * The live marker, or null when absent, malformed, or older than the TTL
 * (expired/malformed entries are removed so they cannot resurface).
 * @param {number} [now]
 * @returns {CameraOpenMarker | null}
 */
export function readCameraOpen(now = Date.now()) {
  let raw;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    clearCameraOpen();
    return null;
  }
  const route = typeof parsed?.route === "string" ? parsed.route : "";
  const at = Number(parsed?.at);
  const ageMs = now - at;
  if (
    !route ||
    !Number.isFinite(at) ||
    ageMs < 0 ||
    ageMs > CAMERA_OPEN_TTL_MS
  ) {
    clearCameraOpen();
    return null;
  }
  return { route, at, ageMs };
}

/**
 * The draft flow a capture route resumes, or null for any other route.
 * @param {string} route
 * @returns {"perimeter" | "single-problem" | null}
 */
export function captureRouteFlow(route) {
  return Object.hasOwn(ROUTE_FLOWS, route)
    ? ROUTE_FLOWS[/** @type {keyof typeof ROUTE_FLOWS} */ (route)]
    : null;
}

/**
 * Decide whether this boot should skip home and re-enter capture. Only a boot
 * that landed on home, with a fresh marker AND a persisted draft for the
 * marker's flow, qualifies — a user who finished or discarded the check has
 * no draft, and a marker older than the TTL is treated as stale.
 * @param {{
 *   route: string,
 *   hasDraft: (flowType: string) => Promise<boolean>,
 *   now?: number,
 * }} ctx
 * @returns {Promise<{ route: string, flow: string, marker: CameraOpenMarker } | null>}
 */
export async function captureRouteToRestore({ route, hasDraft, now }) {
  if (route !== "/today") return null;
  const marker = readCameraOpen(now);
  if (!marker) return null;
  const flow = captureRouteFlow(marker.route);
  if (!flow) {
    clearCameraOpen();
    return null;
  }
  if (!(await hasDraft(flow))) {
    clearCameraOpen();
    return null;
  }
  return { route: marker.route, flow, marker };
}

/**
 * Event properties for the `capture_resumed` analytics event: what is being
 * resumed and how the relaunched document arrived. Device/browser facts are
 * added by services/analytics.js and the server, so none are repeated here.
 * @param {{ route: string, flow: string, marker: CameraOpenMarker }} restore
 * @param {{ pathname?: string, navigationType?: string, referrerHost?: string }} [env]
 * @returns {Record<string, string | number>}
 */
export function captureResumeProperties(restore, env = relaunchEnvironment()) {
  return {
    route: restore.route,
    flow: restore.flow,
    marker_age_s: Math.round(restore.marker.ageMs / 1000),
    ...(env.navigationType ? { navigation_type: env.navigationType } : {}),
    ...(env.pathname ? { landing_path: env.pathname } : {}),
    ...(env.referrerHost ? { $referring_domain: env.referrerHost } : {}),
  };
}

/**
 * How this document came to exist, every read guarded.
 * @returns {{ pathname?: string, navigationType?: string, referrerHost?: string }}
 */
export function relaunchEnvironment() {
  /** @type {ReturnType<typeof relaunchEnvironment>} */
  const env = {};
  try {
    env.pathname = location.pathname;
  } catch {
    /* no location */
  }
  const nav = navigationType();
  if (nav) env.navigationType = nav;
  const ref = referringDomain();
  if (ref) env.referrerHost = ref;
  return env;
}
