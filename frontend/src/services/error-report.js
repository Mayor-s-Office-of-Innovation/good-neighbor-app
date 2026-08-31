/*
  error-report.js — lean client error capture (no vendor SDK).

  Registers global `error` + `unhandledrejection` listeners and reports
  scrubbed payloads to our own endpoint (`POST /v1/client-errors`) via
  navigator.sendBeacon; the Lambda forwards to PostHog (log-only until the
  egress sign-off). See docs/todo/client-error-tracking-plan.md.

  Conventions mirror services/instrument.js:
  - `localStorage['gnp:errors'] = 'off'` kills it; `'on'` forces it on
  - off under the test runner (MODE === 'test') so vitest stays silent
  - no-throw, no-op safe when localStorage/navigator are unavailable

  Deliberately NOT here (per the plan): offline queue (deferred with the
  offline pass), breadcrumbs, vendor SDK. Only allowlisted fields are sent,
  query strings stripped here (first of two scrubs; the Lambda re-scrubs).
*/

const MAX_MESSAGE = 2000;
const MAX_STACK = 16_000;
/** Sliding window for the rate cap (ms). */
const WINDOW_MS = 60_000;
/** Rate cap: max reports per window (render-loop crash protection). */
const MAX_PER_WINDOW = 5;

/** @type {string | undefined} last reported type+message key (dedupe) */
let lastKey;
/** @type {number[]} send timestamps inside the current window */
let windowSends = [];

/**
 * Install the global error listeners. Called once at bootstrap (main.js).
 * No-ops when disabled; never throws.
 * @returns {void}
 */
export function installErrorReporting() {
  if (!enabledFor()) return;
  window.addEventListener("error", onErrorEvent);
  window.addEventListener("unhandledrejection", onUnhandledRejection);
}

/**
 * Enablement, mirroring the instrument.js toggle conventions:
 * `gnp:errors=off` wins over everything; `on` overrides test mode; otherwise
 * on except under the test runner. Storage-less environments stay quiet.
 * @returns {boolean}
 */
function enabledFor() {
  try {
    const flag = localStorage.getItem("gnp:errors");
    if (flag === "off") return false;
    if (flag === "on") return true;
  } catch {
    return false;
  }
  const env = /** @type {any} */ (import.meta).env ?? {};
  return env.MODE !== "test";
}

/** @param {ErrorEvent} e */
function onErrorEvent(e) {
  // Resource-load failures with no error object carry only "Script error."
  // noise (cross-origin scripts, failed img/script) — skip them.
  if (!e.error && e.message) return;
  report(
    "Error",
    e.message || "Unknown error",
    e.error instanceof Error ? e.error.stack : undefined,
  );
}

/** @param {PromiseRejectionEvent} e */
function onUnhandledRejection(e) {
  const reason = e.reason;
  const isError = reason instanceof Error;
  report(
    "UnhandledRejection",
    isError
      ? reason.message
      : typeof reason === "string" && reason
        ? reason
        : "UnhandledRejection",
    isError ? /** @type {Error} */ (reason).stack : undefined,
  );
}

/**
 * Build the report payload and send it best-effort. Dedupes identical
 * type+message within the window and rate-caps sends; every failure is
 * dropped silently — reporting must never disturb the app.
 * @param {"Error" | "UnhandledRejection"} type
 * @param {string} message
 * @param {string | undefined} stack
 * @returns {void}
 */
function report(type, message, stack) {
  // Per-message dedupe first (identical type+message once per window —
  // duplicates never consume rate budget), then sliding-window cap.
  const key = `${type}:${message}`;
  if (lastKey === key) return;
  const now = Date.now();
  windowSends = windowSends.filter((t) => now - t < WINDOW_MS);
  if (windowSends.length >= MAX_PER_WINDOW) return;
  windowSends.push(now);
  lastKey = key;

  sendBeacon(
    scrub({
      type,
      message,
      ...(stack ? { stack } : {}),
      source: safePathname(),
      release: release(),
      id: distinctId(),
      ts: new Date().toISOString(),
    }),
  );
}

/**
 * Scrub before send (first of the two scrubs; the Lambda re-scrubs): send
 * only allowlisted fields, cap sizes. `source` is already a bare pathname.
 * @param {{ type: string, message: string, stack?: string, source: string,
 *   release: string, id: string, ts: string }} raw
 * @returns {Record<string, string>} scrubbed payload
 */
function scrub(raw) {
  return {
    type: raw.type,
    message: cap(raw.message, MAX_MESSAGE),
    ...(raw.stack ? { stack: cap(raw.stack, MAX_STACK) } : {}),
    ...(raw.source ? { source: raw.source } : {}),
    release: raw.release,
    id: raw.id,
    ts: raw.ts,
  };
}

/**
 * Current pathname, query string stripped (defense in depth: pathname
 * shouldn't have one, but hostile/stubbed environments may).
 * @returns {string}
 */
function safePathname() {
  try {
    const p = location.pathname ?? "";
    const q = p.indexOf("?");
    return q === -1 ? p : p.slice(0, q);
  } catch {
    return "";
  }
}

/** @param {string} value @param {number} max @returns {string} */
function cap(value, max) {
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * Distinct per-browser id (localStorage-persisted random UUID). Failure-safe:
 * a fresh random id per call when storage is unavailable.
 * @returns {string}
 */
function distinctId() {
  try {
    const existing = localStorage.getItem("gnp:distinct-id");
    if (existing) return existing;
    const fresh = crypto.randomUUID();
    localStorage.setItem("gnp:distinct-id", fresh);
    return fresh;
  } catch {
    return crypto.randomUUID();
  }
}

/** @returns {string} "dev" locally; CI injects __RELEASE__ via Vite define. */
function release() {
  return /** @type {any} */ (globalThis).__RELEASE__ ?? "dev";
}

/**
 * sendBeacon first (survives unload, no preflight possible); fetch keepalive
 * fallback for the rare beacon-less browser. Never throws; failures dropped.
 * @param {Record<string, string>} payload scrubbed report
 * @returns {void}
 */
function sendBeacon(payload) {
  try {
    if (typeof navigator !== "undefined" && navigator.sendBeacon) {
      const blob = new Blob([JSON.stringify(payload)], {
        type: "application/json",
      });
      if (navigator.sendBeacon("/v1/client-errors", blob)) return;
    }
    if (typeof fetch === "function") {
      fetch("/v1/client-errors", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        keepalive: true,
      }).catch(() => {});
    }
  } catch {
    // Quietly dropped — error reporting must never create user-visible errors.
  }
}
