// Scrub + validate client analytics events (POST /v1/client-events). Same
// two-scrub posture as scrub-client-error.js: the client sends an allowlisted
// shape, the server re-validates and drops anything else. Events and
// properties are both allowlisted — an unknown property key is dropped, not
// forwarded — so the pipeline can only ever carry what is written down here.

/** Event names the intake accepts. Keep in step with frontend services/analytics.js. */
export const EVENTS = /** @type {const} */ ([
  "$pageview",
  "site_setup_completed",
  "capture_resumed",
  "camera_opened",
  "photo_picked",
]);

/**
 * Property keys the intake accepts. PostHog-conventional `$` names where
 * one exists so web analytics and the person/device views light up; plain
 * names for app facts. URL-ish keys are query-stripped.
 */
export const PROPERTY_KEYS = /** @type {const} */ ([
  // page
  "$current_url",
  "$pathname",
  "$referring_domain",
  "navigation_type",
  "landing_path",
  // device / browser facts the UA header cannot tell us
  "$screen_width",
  "$screen_height",
  "$viewport_width",
  "$viewport_height",
  "$browser_language",
  "device_pixel_ratio",
  "device_memory_gb",
  "hardware_concurrency",
  "connection_type",
  "display_mode",
  "platform",
  "platform_version",
  "device_model",
  "ua_mobile",
  // app facts
  "flow",
  "route",
  "marker_age_s",
  "switching_site",
  "photo_bytes",
  "photo_type",
]);
const URL_KEYS = new Set(["$current_url", "$pathname", "landing_path"]);

export const MAX_SHORT = 200;
export const MAX_PROPERTY_STRING = 500;

/**
 * @typedef {object} ScrubbedClientEvent
 * @property {string} event
 * @property {string} id
 * @property {string} [ts]
 * @property {string} [release]
 * @property {Record<string, string | number | boolean>} properties
 */

/**
 * Drop `?` / `#` and everything after.
 * @param {string} value
 * @returns {string}
 */
function stripQueryString(value) {
  const i = value.search(/[?#]/);
  return i === -1 ? value : value.slice(0, i);
}

/**
 * @param {unknown} value
 * @param {number} max
 * @returns {string}
 */
function truncateString(value, max) {
  if (typeof value !== "string") return "";
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * Validate + scrub a raw client event payload. Returns the clean event or
 * `null` for garbage. Never throws.
 * @param {unknown} body
 * @returns {ScrubbedClientEvent | null}
 */
export function scrubClientEvent(body) {
  try {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return null;
    }
    const raw = /** @type {Record<string, unknown>} */ (body);

    const event = raw.event;
    const names = /** @type {readonly string[]} */ (EVENTS);
    if (typeof event !== "string" || !names.includes(event)) {
      return null;
    }
    const id = truncateString(raw.id, MAX_SHORT);
    if (!id) return null;

    /** @type {ScrubbedClientEvent} */
    const out = { event, id, properties: scrubProperties(raw.properties) };
    if (typeof raw.ts === "string") out.ts = truncateString(raw.ts, MAX_SHORT);
    const release = truncateString(raw.release, MAX_SHORT);
    if (release) out.release = release;
    return out;
  } catch {
    return null;
  }
}

/**
 * Keep only allowlisted keys with scalar values; strings capped, URL-ish
 * strings query-stripped, numbers must be finite.
 * @param {unknown} raw
 * @returns {Record<string, string | number | boolean>}
 */
export function scrubProperties(raw) {
  /** @type {Record<string, string | number | boolean>} */
  const out = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  const props = /** @type {Record<string, unknown>} */ (raw);
  for (const key of PROPERTY_KEYS) {
    if (!Object.hasOwn(props, key)) continue;
    const value = props[key];
    if (typeof value === "string") {
      const capped = truncateString(value, MAX_PROPERTY_STRING);
      const clean = URL_KEYS.has(key) ? stripQueryString(capped) : capped;
      if (clean) out[key] = clean;
    } else if (typeof value === "number") {
      if (Number.isFinite(value)) out[key] = value;
    } else if (typeof value === "boolean") {
      out[key] = value;
    }
  }
  return out;
}
