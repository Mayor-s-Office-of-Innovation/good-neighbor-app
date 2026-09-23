/*
  device-location - one small boundary around the browser Geolocation API.
  Capture continues when a device declines or cannot provide location; 311
  filing then uses the site's geocoded default location.
*/

const LOCATION_TIMEOUT_MS = 10_000;
const CAPTURE_LOCATION_TIMEOUT_MS = 2_000;
const SITE_CHECK_LOCATION_TIMEOUT_MS = 2_000;
const SITE_CHECK_CACHE_AGE_MS = 30_000;
const SITE_CHECK_FALLBACK_AGE_MS = 60_000;
const PERMISSION_REQUESTED_KEY = "gnp:location-permission-requested";
let requestedEarly = false;
/** @type {Promise<DeviceLocation | null> | null} */
let earlyLocationRequest = null;
let capturePromptAttempted = false;
/** @type {DeviceLocation | null} */
let lastDeviceLocation = null;
/** @type {DeviceLocation | null} */
let lastSuccessfulLocation = null;
let lastSuccessfulAt = 0;
/** @type {Set<(location: DeviceLocation | null) => void>} */
const locationListeners = new Set();

/**
 * @typedef {{ latitude: number, longitude: number }} DeviceLocation
 */

/**
 * Request a fresh device position. `maximumAge: 0` prevents a previous place's
 * cached position from being attached to a newly captured item.
 * @param {{
 *   timeoutMs?: number,
 *   maximumAgeMs?: number,
 *   enableHighAccuracy?: boolean,
 *   onError?: (error: GeolocationPositionError) => void,
 * }} [opts]
 * @returns {Promise<DeviceLocation | null>}
 */
export function getDeviceLocation({
  timeoutMs = LOCATION_TIMEOUT_MS,
  maximumAgeMs = 0,
  enableHighAccuracy = true,
  onError,
} = {}) {
  if (typeof navigator === "undefined" || !navigator.geolocation) {
    return Promise.resolve(null);
  }

  console.info("[location] Position request started.");

  return new Promise((resolve) => {
    let settled = false;
    const finish = (location) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lastDeviceLocation = location;
      if (location) {
        lastSuccessfulLocation = location;
        lastSuccessfulAt = Date.now();
      }
      for (const listener of locationListeners) listener(location);
      resolve(location);
    };
    // Some mobile browsers fail to invoke either geolocation callback after
    // returning from the camera. Keep location best-effort so that platform
    // behavior cannot strand the upload pipeline indefinitely.
    const timer = setTimeout(() => {
      console.warn(
        `[location] Position request produced no callback within ${timeoutMs}ms.`,
      );
      finish(null);
    }, timeoutMs);

    try {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          const { latitude, longitude } = position.coords;
          if (
            Number.isFinite(latitude) &&
            Number.isFinite(longitude) &&
            latitude >= -90 &&
            latitude <= 90 &&
            longitude >= -180 &&
            longitude <= 180
          ) {
            console.info("[location] Position acquired.");
            finish({ latitude, longitude });
            return;
          }
          console.warn("[location] Position contained invalid coordinates.");
          finish(null);
        },
        (error) => {
          if (error) {
            console.warn(
              `[location] Position request failed (code ${error.code}): ${error.message}`,
            );
          }
          onError?.(error);
          finish(null);
        },
        { enableHighAccuracy, maximumAge: maximumAgeMs, timeout: timeoutMs },
      );
    } catch (error) {
      console.warn("[location] Position request threw an exception.", error);
      finish(null);
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
  if (earlyLocationRequest) return earlyLocationRequest;
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
    return (await waitForStartupLocation(earlyLocationRequest)) || recent();
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
 * Bound the capture path's wait for best-effort coordinates. The longer
 * default guard remains useful for the early permission request, but an
 * unresponsive browser must not hold up artifact registration or upload.
 * @returns {Promise<DeviceLocation | null>}
 */
export async function getCaptureDeviceLocation() {
  // Retain the request even if it settles while the permission query runs.
  const startupRequest = earlyLocationRequest;
  const state = await locationPermissionState();
  if (state === "denied") return null;
  if (startupRequest) return waitForStartupLocation(startupRequest);
  if (state !== "granted") {
    // A first capture is a user-initiated fallback for browsers that suppress
    // startup prompts. Do not repeat a dismissed/unsupported prompt per photo.
    if (capturePromptAttempted) return null;
    capturePromptAttempted = true;
  }
  return getDeviceLocation({ timeoutMs: CAPTURE_LOCATION_TIMEOUT_MS });
}

/**
 * Bound only this capture's wait; leave the shared startup request running.
 * @param {Promise<DeviceLocation | null>} request
 * @returns {Promise<DeviceLocation | null>}
 */
async function waitForStartupLocation(request) {
  let timer;
  try {
    return await Promise.race([
      request,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), CAPTURE_LOCATION_TIMEOUT_MS);
      }),
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
  earlyLocationRequest = getDeviceLocation().finally(() => {
    earlyLocationRequest = null;
  });
}
