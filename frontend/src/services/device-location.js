/*
  device-location - one small boundary around the browser Geolocation API.
  Capture continues when a device declines or cannot provide location; 311
  filing then uses the site's geocoded default location.
*/

import { trackEvent } from "./analytics.js";

// Logged with each photo so we can see why location failed.
export const LOCATION_OUTCOME = Object.freeze({
  acquired: "acquired",
  timeout: "timeout",
  denied: "denied",
  unavailable: "unavailable",
  skipped: "skipped",
});
/** @typedef {"acquired" | "timeout" | "denied" | "unavailable" | "skipped"} LocationOutcome */
const LOCATION_TIMEOUT_MS = 10_000;
// GPS started when the camera opened; 10 s more matches FixMyStreet and iNaturalist.
const CAPTURE_LOCATION_TIMEOUT_MS = 10_000;
const CAPTURE_PREFETCH_TIMEOUT_MS = 30_000;
// An older reading may show where the person stood a minute ago.
const CAPTURE_PREFETCH_MAX_AGE_MS = 60_000;
const SITE_CHECK_LOCATION_TIMEOUT_MS = 2_000;
const SITE_CHECK_CACHE_AGE_MS = 30_000;
const SITE_CHECK_FALLBACK_AGE_MS = 60_000;
const PERMISSION_REQUESTED_KEY = "gnp:location-permission-requested";
let requestedEarly = false;
/** @type {Promise<LocationResult> | null} */
let earlyLocationRequest = null;
/** @type {{ request: Promise<LocationResult>, settledAt: number, location?: DeviceLocation | null } | null} */
let capturePrefetch = null;
let capturePromptAttempted = false;
/** @type {DeviceLocation | null} */
let lastDeviceLocation = null;
/** @type {DeviceLocation | null} */
let lastSuccessfulLocation = null;
let lastSuccessfulAt = 0;
/** @type {Set<(location: DeviceLocation | null) => void>} */
const locationListeners = new Set();

/**
 * @typedef {{ latitude: number, longitude: number, accuracyMeters?: number }} DeviceLocation
 * @typedef {{ location: DeviceLocation | null, outcome: LocationOutcome }} LocationResult
 * @typedef {{
 *   atUpload: () => DeviceLocation | null,
 *   later: Promise<DeviceLocation | null>,
 * }} CaptureLocationRead
 * @typedef {{
 *   timeoutMs?: number,
 *   maximumAgeMs?: number,
 *   enableHighAccuracy?: boolean,
 *   onError?: (error: GeolocationPositionError) => void,
 * }} LocationOptions
 */

/**
 * Request a fresh device position. `maximumAge: 0` prevents a previous place's
 * cached position from being attached to a newly captured item.
 * @param {LocationOptions} [opts]
 * @returns {Promise<DeviceLocation | null>}
 */
export function getDeviceLocation(opts) {
  return locate(opts).then(({ location }) => location);
}

/**
 * Keeps why a read failed, for the `photo_location` event.
 * @param {LocationOptions} [opts]
 * @returns {Promise<LocationResult>}
 */
function locate({
  timeoutMs = LOCATION_TIMEOUT_MS,
  maximumAgeMs = 0,
  enableHighAccuracy = true,
  onError,
} = {}) {
  if (typeof navigator === "undefined" || !navigator.geolocation) {
    return Promise.resolve({
      location: null,
      outcome: LOCATION_OUTCOME.unavailable,
    });
  }

  console.info("[location] Position request started.");

  return new Promise((resolve) => {
    let settled = false;
    /**
     * @param {DeviceLocation | null} location
     * @param {LocationOutcome} outcome
     */
    const finish = (location, outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lastDeviceLocation = location;
      if (location) {
        lastSuccessfulLocation = location;
        lastSuccessfulAt = Date.now();
      }
      for (const listener of locationListeners) listener(location);
      resolve({ location, outcome });
    };
    // Some mobile browsers fail to invoke either geolocation callback after
    // returning from the camera. Keep location best-effort so that platform
    // behavior cannot strand the upload pipeline indefinitely.
    const timer = setTimeout(() => {
      console.warn(
        `[location] Position request produced no callback within ${timeoutMs}ms.`,
      );
      finish(null, LOCATION_OUTCOME.timeout);
    }, timeoutMs);

    try {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          const { latitude, longitude, accuracy } = position.coords;
          if (
            Number.isFinite(latitude) &&
            Number.isFinite(longitude) &&
            latitude >= -90 &&
            latitude <= 90 &&
            longitude >= -180 &&
            longitude <= 180
          ) {
            console.info("[location] Position acquired.");
            const accuracyMeters = Math.round(accuracy);
            finish(
              {
                latitude,
                longitude,
                ...(accuracyMeters >= 0 ? { accuracyMeters } : {}),
              },
              LOCATION_OUTCOME.acquired,
            );
            return;
          }
          console.warn("[location] Position contained invalid coordinates.");
          finish(null, LOCATION_OUTCOME.unavailable);
        },
        (error) => {
          if (error) {
            console.warn(
              `[location] Position request failed (code ${error.code}): ${error.message}`,
            );
          }
          onError?.(error);
          finish(
            null,
            error?.code === 1
              ? LOCATION_OUTCOME.denied
              : error?.code === 3
                ? LOCATION_OUTCOME.timeout
                : LOCATION_OUTCOME.unavailable,
          );
        },
        { enableHighAccuracy, maximumAge: maximumAgeMs, timeout: timeoutMs },
      );
    } catch (error) {
      console.warn("[location] Position request threw an exception.", error);
      finish(null, LOCATION_OUTCOME.unavailable);
    }
  });
}

export function getLastDeviceLocation() {
  return lastDeviceLocation;
}

/** @param {(location: DeviceLocation | null) => void} listener */
export function onDeviceLocationChange(listener) {
  locationListeners.add(listener);
  return () => locationListeners.delete(listener);
}

/** Refresh the home hint without presenting a new permission prompt. */
export async function refreshGrantedDeviceLocation() {
  if (earlyLocationRequest) return (await earlyLocationRequest).location;
  if ((await locationPermissionState()) !== "granted") return null;
  return getDeviceLocation({
    timeoutMs: SITE_CHECK_LOCATION_TIMEOUT_MS,
    maximumAgeMs: SITE_CHECK_CACHE_AGE_MS,
    enableHighAccuracy: false,
  });
}

/**
 * Check proximity when the user starts capture. A recent position is reused;
 * otherwise a granted permission gets a short fresh request. Browsers without
 * the Permissions API may also request on this user action, but never during
 * the passive home refresh. A denied prompt is not repeated at capture time.
 * @returns {Promise<DeviceLocation | null>}
 */
export async function getSiteCheckDeviceLocation() {
  const recent = () =>
    lastSuccessfulLocation &&
    Date.now() - lastSuccessfulAt <= SITE_CHECK_FALLBACK_AGE_MS
      ? lastSuccessfulLocation
      : null;
  const permission = await locationPermissionState();
  if (permission === "denied") return null;
  if (
    lastSuccessfulLocation &&
    Date.now() - lastSuccessfulAt <= SITE_CHECK_CACHE_AGE_MS
  ) {
    return lastSuccessfulLocation;
  }
  if (earlyLocationRequest) {
    return (
      (await waitForStartupLocation(earlyLocationRequest)).location || recent()
    );
  }
  if (
    permission === "prompt" ||
    (permission === null && capturePromptAttempted)
  ) {
    return recent();
  }
  return (
    (await getDeviceLocation({
      timeoutMs: SITE_CHECK_LOCATION_TIMEOUT_MS,
      maximumAgeMs: SITE_CHECK_CACHE_AGE_MS,
      enableHighAccuracy: false,
      onError: (error) => {
        if (permission === null && error?.code === 1) {
          capturePromptAttempted = true;
        }
      },
    })) || recent()
  );
}

/**
 * GPS can be slow, so start it when staff tap Start. This may prompt: Safari
 * resets sites to "ask", and a prompt at the first photo leaves GPS no time.
 * @returns {Promise<void>}
 */
export async function startCaptureDeviceLocation() {
  const state = await locationPermissionState();
  if (state === "denied" || (state !== "granted" && capturePromptAttempted)) {
    return;
  }
  // One prompt per session, so a dismissed one doesn't come back at the photo.
  if (state === "prompt") capturePromptAttempted = true;
  if (earlyLocationRequest || (capturePrefetch && !capturePrefetch.settledAt)) {
    return;
  }
  /** @type {{ request: Promise<LocationResult>, settledAt: number, location?: DeviceLocation | null }} */
  const prefetch = {
    request: locate({ timeoutMs: CAPTURE_PREFETCH_TIMEOUT_MS }),
    settledAt: 0,
  };
  capturePrefetch = prefetch;
  void prefetch.request.then(({ location }) => {
    prefetch.location = location;
    if (capturePrefetch !== prefetch) return;
    // A failed read is dropped so the capture asks again.
    if (location) prefetch.settledAt = Date.now();
    else capturePrefetch = null;
  });
}

/**
 * Start one photo's location read without holding up its upload.
 * @param {string} [flow] reports a `photo_location` event for this flow
 * @returns {CaptureLocationRead}
 */
export function readCaptureDeviceLocation(flow) {
  const startedAt = Date.now();
  // Retain the request even if it settles while the permission query runs.
  const prefetch = earlyLocationRequest ? null : capturePrefetch;
  const startupRequest = earlyLocationRequest || takeCapturePrefetch();
  // A Start reading that is already in goes with an upload that beats the permission check.
  const ready =
    startupRequest && prefetch?.settledAt ? prefetch.location : null;
  /** @type {LocationResult | null} */
  let result = null;
  /** @type {DeviceLocation | null | undefined} */
  let sent;
  const later = locationPermissionState().then(async (state) => {
    const settled = await captureLocation(state, startupRequest);
    result = settled;
    if (flow) {
      void trackEvent("photo_location", {
        flow,
        location_outcome: settled.outcome,
        location_wait_ms: Date.now() - startedAt,
        ...(settled.location?.accuracyMeters !== undefined
          ? { location_accuracy_m: settled.location.accuracyMeters }
          : {}),
        ...(settled.location
          ? { location_sent_with_upload: sent === undefined || sent !== null }
          : {}),
        permission_state: state ?? "unsupported",
      });
    }
    return settled.location;
  });
  return {
    atUpload() {
      if (sent === undefined) sent = result?.location ?? ready ?? null;
      return sent;
    },
    later,
  };
}

/**
 * @param {string | null} state
 * @param {Promise<LocationResult> | null} startupRequest
 * @returns {Promise<LocationResult>}
 */
async function captureLocation(state, startupRequest) {
  if (state === "denied")
    return { location: null, outcome: LOCATION_OUTCOME.denied };
  if (startupRequest) return waitForStartupLocation(startupRequest);
  if (state !== "granted") {
    // A first capture is a user-initiated fallback for browsers that suppress
    // startup prompts. Do not repeat a dismissed/unsupported prompt per photo.
    if (capturePromptAttempted)
      return { location: null, outcome: LOCATION_OUTCOME.skipped };
    capturePromptAttempted = true;
  }
  return locate({ timeoutMs: CAPTURE_LOCATION_TIMEOUT_MS });
}

/**
 * One early reading per photo; the next photo may be elsewhere.
 * @returns {Promise<LocationResult> | null}
 */
function takeCapturePrefetch() {
  const prefetch = capturePrefetch;
  capturePrefetch = null;
  if (
    !prefetch ||
    (prefetch.settledAt &&
      Date.now() - prefetch.settledAt > CAPTURE_PREFETCH_MAX_AGE_MS)
  ) {
    return null;
  }
  return prefetch.request;
}

/**
 * Bound only this capture's wait; leave the shared startup request running.
 * @param {Promise<LocationResult>} request
 * @returns {Promise<LocationResult>}
 */
async function waitForStartupLocation(request) {
  let timer;
  try {
    return await Promise.race([
      request,
      /** @type {Promise<LocationResult>} */ (
        new Promise((resolve) => {
          timer = setTimeout(
            () =>
              resolve({ location: null, outcome: LOCATION_OUTCOME.timeout }),
            CAPTURE_LOCATION_TIMEOUT_MS,
          );
        })
      ),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function locationPermissionState() {
  if (typeof navigator === "undefined" || !navigator.permissions?.query) {
    console.info("[location] Permissions API unavailable.");
    return null;
  }

  try {
    const permission = await navigator.permissions.query({
      name: "geolocation",
    });
    console.info(`[location] Permission state: ${permission.state}`);
    return permission.state;
  } catch (error) {
    console.info("[location] Permission state unavailable.", error);
    return null;
  }
}

/**
 * Ask once on first launch. The marker records an attempt, not permission:
 * only the browser's current permission state authorizes capture requests.
 * @returns {void}
 */
export function requestLocationPermissionEarly() {
  if (typeof navigator === "undefined" || !navigator.geolocation) return;
  if (requestedEarly) return;
  requestedEarly = true;
  try {
    if (localStorage.getItem(PERMISSION_REQUESTED_KEY)) return;
    // Write before requesting so remounts/reloads cannot issue another prompt.
    localStorage.setItem(PERMISSION_REQUESTED_KEY, "1");
  } catch {
    // Restricted storage still gets one attempt per page lifetime.
  }
  void locationPermissionState();
  earlyLocationRequest = locate().finally(() => {
    earlyLocationRequest = null;
  });
}
