/*
  capture-mode — single source of truth for which photo-capture path the perimeter
  check uses. The default is the native camera handoff (a hidden <input type="file"
  capture>). An opt-in in-app browser camera (<in-browser-camera>, getUserMedia +
  canvas snapshot with pinch/hardware zoom) is enabled via a `?webcam` URL param and
  then persisted per-device in localStorage, so it survives reloads and later checks
  without re-passing the param.

    ?webcam  /  ?webcam=1   → enable + persist
    ?webcam=0 / ?webcam=false → disable + clear
    (no param)              → use the persisted value (default: native)

  The param is consumed once at startup and stripped from the URL (mirroring
  site-setup's `stripCodeFromUrl`), so it never lingers in shared/bookmarked links.
*/
const STORAGE_KEY = "gnp.captureMode";
const BROWSER = "browser";

// Values that mean "turn it off" when passed as ?webcam=<value>.
/** @type {Set<string>} */
const OFF_VALUES = new Set(["0", "false", "off", "no"]);

/**
 * @returns {string | null}
 */
function readStored() {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null; // storage blocked (private mode / disabled) → treat as unset
  }
}

/**
 * @param {string | null} value
 * @returns {void}
 */
function writeStored(value) {
  try {
    if (value) localStorage.setItem(STORAGE_KEY, value);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* no-op — persistence is best-effort */
  }
}

/**
 * Consume the `?webcam` param (if present), update the persisted preference, and
 * strip the param from the URL. Call once during app bootstrap, before any capture.
 */
export function syncCaptureModeFromUrl() {
  let raw = null;
  try {
    const params = new URLSearchParams(location.search);
    if (params.has("webcam")) raw = params.get("webcam");
  } catch {
    return;
  }

  if (raw !== null) {
    const off = OFF_VALUES.has(raw.trim().toLowerCase());
    writeStored(off ? null : BROWSER);
    stripWebcamFromUrl();
  }
}

/** @returns {boolean} True when the opt-in in-app browser camera should be used for capture. */
export function isBrowserCameraEnabled() {
  return readStored() === BROWSER;
}

function stripWebcamFromUrl() {
  try {
    const url = new URL(location.href);
    if (url.searchParams.has("webcam")) {
      url.searchParams.delete("webcam");
      history.replaceState(null, "", url.pathname + url.search + url.hash);
    }
  } catch {
    /* no-op */
  }
}
