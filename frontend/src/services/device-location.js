/*
  device-location - one small boundary around the browser Geolocation API.
  Capture continues when a device declines or cannot provide location; 311
  filing then uses the site's geocoded default location.
*/

const LOCATION_TIMEOUT_MS = 10_000;
const CAPTURE_LOCATION_TIMEOUT_MS = 2_000;
const PERMISSION_REQUESTED_KEY = "gnp:location-permission-requested";
let requestedEarly = false;
let earlyRequestPending = false;
let capturePromptAttempted = false;

/**
 * @typedef {{ latitude: number, longitude: number }} DeviceLocation
 */

/**
 * Request a fresh device position. `maximumAge: 0` prevents a previous place's
 * cached position from being attached to a newly captured item.
 * @param {{
 *   timeoutMs?: number,
 *   onError?: (error: GeolocationPositionError) => void,
 * }} [opts]
 * @returns {Promise<DeviceLocation | null>}
 */
export function getDeviceLocation({
  timeoutMs = LOCATION_TIMEOUT_MS,
  onError,
} = {}) {
  if (typeof navigator === "undefined" || !navigator.geolocation) {
    return Promise.resolve(null);
  }

  void locationPermissionState();
  console.info("[location] Position request started.");

  return new Promise((resolve) => {
    let settled = false;
    const finish = (location) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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
        { enableHighAccuracy: true, maximumAge: 0, timeout: timeoutMs },
      );
    } catch (error) {
      console.warn("[location] Position request threw an exception.", error);
      finish(null);
    }
  });
}

/**
 * Bound the capture path's wait for best-effort coordinates. The longer
 * default guard remains useful for the early permission request, but an
 * unresponsive browser must not hold up artifact registration or upload.
 * @returns {Promise<DeviceLocation | null>}
 */
export async function getCaptureDeviceLocation() {
  const state = await locationPermissionState();
  if (state === "denied" || earlyRequestPending) return null;
  if (state !== "granted") {
    // A first capture is a user-initiated fallback for browsers that suppress
    // startup prompts. Do not repeat a dismissed/unsupported prompt per photo.
    if (capturePromptAttempted) return null;
    capturePromptAttempted = true;
  }
  return getDeviceLocation({ timeoutMs: CAPTURE_LOCATION_TIMEOUT_MS });
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
  earlyRequestPending = true;
  void getDeviceLocation().finally(() => {
    earlyRequestPending = false;
  });
}
