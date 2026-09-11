// Scrub + validate client error reports. Two scrubs per the error-tracking
// plan's governance gate: the client scrubs before send, the server re-scrubs
// here (never trust the client). Everything else in the pipeline (the PostHog
// forwarder, the log line) consumes the scrubbed, validated shape produced by
// this module.

/** Allowed `type` values, mirroring what error-report.js can emit. */
const TYPES = /** @type {const} */ (["Error", "UnhandledRejection"]);
/** Max message length the intake accepts (chars). */
export const MAX_MESSAGE = 2000;
/** Max stack length the intake accepts (chars). */
export const MAX_STACK = 16_000;
/** Max length for short string fields (source/release/id). */
export const MAX_SHORT = 200;
/** Max length for a bare URL field after scrubbing. */
export const MAX_URL = 500;

/**
 * @typedef {object} ScrubbedErrorReport
 * @property {string} type
 * @property {string} message
 * @property {string} [stack]
 * @property {string} [source]
 * @property {string} [release]
 * @property {string} id
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
 * Strip query strings from http(s) URL substrings inside a stack trace
 * (tokens/emails sometimes ride along in script URLs). Only the URL part is
 * touched — error text around it stays verbatim. A trailing `:line:col`
 * frame suffix is preserved (V8 appends it after the full URL, query
 * included).
 * @param {string} stack
 * @returns {string}
 */
export function stripStackQueryStrings(stack) {
  return stack.replace(/https?:\/\/[^\s)]*/g, (url) => {
    const framePos = url.match(/^(.*):(\d+):(\d+)$/);
    if (framePos && framePos[1]?.includes("?")) {
      return `${stripQueryString(framePos[1])}:${framePos[2]}:${framePos[3]}`;
    }
    return stripQueryString(url);
  });
}

/**
 * Validate + scrub a raw client error payload. Returns a clean object with
 * only allowlisted fields (query strings stripped, sizes capped, types
 * coerced), or `null` when the payload is garbage — the caller decides how to
 * log/drop. Never throws.
 * @param {unknown} body parsed JSON body (or anything)
 * @returns {ScrubbedErrorReport | null}
 */
export function scrubClientErrorReport(body) {
  try {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return null;
    }
    const raw = /** @type {Record<string, unknown>} */ (body);

    const type = /** @type {string} */ (/** @type {unknown} */ (raw.type));
    if (
      typeof type !== "string" ||
      !TYPES.includes(/** @type {any} */ (type))
    ) {
      return null;
    }

    const message = truncateString(raw.message, MAX_MESSAGE);
    if (!message) return null;

    const id = truncateString(raw.id, MAX_SHORT);
    if (!id) return null;

    /** @type {ScrubbedErrorReport} */
    const out = {
      type,
      message,
      id,
      // `ts` is only advisory (intake time is authoritative server-side), but
      // keep a sane ISO-looking string when present.
      ...(typeof raw.ts === "string"
        ? { ts: truncateString(raw.ts, MAX_SHORT) }
        : {}),
    };

    const stack = truncateString(raw.stack, MAX_STACK);
    if (stack) out.stack = stripStackQueryStrings(stack);

    if (typeof raw.source === "string" && raw.source) {
      out.source = stripQueryString(truncateString(raw.source, MAX_URL) || "");
    }

    if (typeof raw.release === "string" && raw.release) {
      out.release = truncateString(raw.release, MAX_SHORT);
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
