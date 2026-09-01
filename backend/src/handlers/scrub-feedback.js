// Scrub + validate user feedback submissions. Never trust the client: the
// only fields forwarded are the allowlist below (sizes capped, types coerced,
// query strings stripped from URL-ish fields). The forwarder
// (feedback-forwarder.js) consumes this shape to build the PostHog event, and
// the metadata-only log line + metric filters key off the intake markers.
// Settled scope: textarea-only, no reply channel, PostHog is the feedback
// store (CloudWatch logs carry metadata only). `id` is REQUIRED — it becomes
// the PostHog `distinct_id`; an event without one would be rejected by the
// ingest and the feedback lost (see the security review in the plan).

/** Max feedback message length the intake accepts (chars). */
export const MAX_MESSAGE = 2000;
/** Max length for short string fields (page/release/id/ts). */
export const MAX_SHORT = 200;
/** Max length for the site code field. */
export const MAX_SITE = 32;

/** Site-code shape; anything else means a hostile/garbage client dropped it in. */
const SITE_PATTERN = /^[A-Za-z0-9-]{4,32}$/;

/**
 * @typedef {object} ScrubbedFeedback
 * @property {string} text
 * @property {string} id
 * @property {string} [page]
 * @property {string} [site]
 * @property {string} [release]
 * @property {string} [ts]
 */

/**
 * Strip query strings (`?` and after) from URL-ish strings.
 * @param {string} value
 * @returns {string} the scrubbed string
 */
export function stripQueryString(value) {
  const i = value.indexOf("?");
  return i === -1 ? value : value.slice(0, i);
}

/**
 * Validate + scrub a raw feedback payload. Returns a clean object with only
 * allowlisted fields, or `null` when the payload is garbage (missing/empty
 * message) — the caller decides how to log/drop. Never throws.
 * @param {unknown} body parsed JSON body (or anything)
 * @returns {ScrubbedFeedback | null}
 */
export function scrubFeedback(body) {
  try {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return null;
    }
    const raw = /** @type {Record<string, unknown>} */ (body);

    const text = truncateString(raw.message, MAX_MESSAGE).trim();
    if (!text) return null;

    // Required: becomes the PostHog `distinct_id`. Parity with the error
    // intake — without it the forwarded event would be rejected by the
    // ingest and the feedback lost.
    const id = truncateString(raw.id, MAX_SHORT);
    if (!id) return null;

    /** @type {ScrubbedFeedback} */
    const out = { text, id };

    if (typeof raw.page === "string" && raw.page) {
      out.page = stripQueryString(truncateString(raw.page, MAX_SHORT) || "");
    }

    if (typeof raw.site === "string" && SITE_PATTERN.test(raw.site)) {
      out.site = raw.site;
    }

    for (const key of ["release", "ts"]) {
      const value = raw[key];
      if (typeof value === "string" && value) {
        out[/** @type {"release" | "ts"} */ (key)] = truncateString(
          value,
          MAX_SHORT,
        );
      }
    }

    return out;
  } catch {
    return null;
  }
}

/**
 * Coerce to string and cap length. Non-strings become "" (dropped).
 * @param {unknown} value
 * @param {number} max
 * @returns {string}
 */
function truncateString(value, max) {
  if (typeof value !== "string") return "";
  return value.length > max ? value.slice(0, max) : value;
}
