/*
  instrument.js — lightweight, toggleable perf tracing for the submit/analysis path.

  Purpose: make two things visible in the browser console when a check is submitted
    1. SEND side — are the per-photo upload legs (presign → PUT → register) actually
       overlapping, or running one-after-another? Serial legs show rising `+Nms`
       start stamps; parallel legs cluster their starts near the same stamp.
    2. RESPONSE side — as `waitForAnalyses` polls, when does each artifact's ANALYSIS
       land? First-seen stamps per artifactId reveal whether the backend returns them
       together (parallel) or dribbles them out (serial).

  Every line carries a monotonic `+Nms` offset from the run epoch (for ordering) AND
  a wall-clock time (for correlating with backend/CloudWatch logs).

  ON in dev by default; force with `localStorage['gnp:perf'] = 'on'|'off'`. Off under
  the test runner so it never spams vitest output.
*/

const ENABLED = (() => {
  try {
    const flag =
      typeof localStorage !== "undefined" && localStorage.getItem("gnp:perf");
    if (flag === "on") return true;
    if (flag === "off") return false;
  } catch {
    /* localStorage may be unavailable (SSR/tests) */
  }
  const env = /** @type {any} */ (import.meta).env ?? {};
  return !!env.DEV && env.MODE !== "test";
})();

/** Monotonic epoch for the current run; reset by `startRun`. */
let epoch = typeof performance !== "undefined" ? performance.now() : 0;

/** @returns {number} high-resolution ms since navigation start */
function nowMs() {
  return typeof performance !== "undefined" ? performance.now() : 0;
}

/** Compact wall clock (HH:MM:SS.mmm) for lining up with server logs. */
function clock() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/** `+1234ms`, right-aligned so columns line up in the console. */
function offset() {
  return `+${(nowMs() - epoch).toFixed(0)}ms`.padStart(9);
}

/**
 * Begin a fresh timed run: resets the `+Nms` epoch and logs a `<label>:start` line.
 * @param {string} label
 * @param {Record<string, unknown>} [fields]
 * @returns {number} the run epoch (performance.now)
 */
export function startRun(label, fields) {
  epoch = nowMs();
  mark(`${label}:start`, fields);
  return epoch;
}

/**
 * Emit one timestamped trace line. No-op unless instrumentation is enabled.
 * @param {string} event
 * @param {Record<string, unknown>} [fields]
 */
export function mark(event, fields) {
  if (!ENABLED) return;
  const extra = fields
    ? " " +
      Object.entries(fields)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ")
    : "";

  console.log(
    `%c[GNP-perf]%c ${offset()} ${clock()}  ${event}${extra}`,
    "color:#7c3aed;font-weight:bold",
    "color:inherit",
  );
}

/**
 * Start a span: logs `<event>:start` now and returns an `end()` that logs
 * `<event>:end` with the elapsed `ms`. Extra fields passed to `end()` are merged.
 * Returns a no-op when disabled, so callers can wrap unconditionally.
 * @param {string} event
 * @param {Record<string, unknown>} [fields]
 * @returns {(endFields?: Record<string, unknown>) => number}
 */
export function span(event, fields) {
  if (!ENABLED) return () => 0;
  const t0 = nowMs();
  mark(`${event}:start`, fields);
  return (endFields) => {
    const ms = +(nowMs() - t0).toFixed(0);
    mark(`${event}:end`, { ...fields, ...endFields, ms });
    return ms;
  };
}

/** Whether tracing is active (so hot paths can skip building label strings). */
export const perfEnabled = ENABLED;
