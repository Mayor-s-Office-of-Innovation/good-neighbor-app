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

  Bootstrap note: import this module FIRST (before any side-effect imports
  that could throw while evaluating) and let it self-install — see the
  bottom-of-module auto-install and main.js.
*/

const MAX_MESSAGE = 2000;
const MAX_STACK = 16_000;
/** Sliding window for the rate cap (ms). */
const WINDOW_MS = 60_000;
/** Rate cap: max reports per window (render-loop crash protection). */
const MAX_PER_WINDOW = 5;
/** Dedupe memory lifetime (ms) — same key may report again after this. */
const DEDUPE_TTL_MS = WINDOW_MS;

/** @type {Map<string, number>} dedupe: type+message key → last sent time (ms) */
const recentKeys = new Map();
/** Max distinct keys remembered — bound memory; the rate cap is the real guard */
const MAX_DEDUPE_KEYS = 100;
/** @type {number[]} send timestamps inside the current window */
let windowSends = [];

/**
 * Install the global error listeners. Called at bootstrap (main.js imports
 * this module first; it also self-installs). Idempotent. No-ops when
 * disabled; never throws.
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
  try {
    // Per-message dedupe first (identical type+message once per window —
    // duplicates never consume rate budget), then sliding-window cap. A Map
    // (not just the last key) so A→B→A still dedupes A; bounded to keep
    // memory finite.
    const key = `${type}:${message}`;
    const now = Date.now();
    const lastAt = recentKeys.get(key);
    if (lastAt !== undefined && now - lastAt < DEDUPE_TTL_MS) return;
    if (recentKeys.size >= MAX_DEDUPE_KEYS) {
      for (const [k, t] of recentKeys) {
        if (now - t >= DEDUPE_TTL_MS) recentKeys.delete(k);
      }
      if (recentKeys.size >= MAX_DEDUPE_KEYS) {
        const oldest = recentKeys.keys().next().value;
        if (oldest !== undefined) recentKeys.delete(oldest);
      }
    }
    windowSends = windowSends.filter((t) => now - t < WINDOW_MS);
    if (windowSends.length >= MAX_PER_WINDOW) return;
    windowSends.push(now);
    recentKeys.set(key, now);

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
  } catch {
    // Capture must never throw — swallow everything.
  }
}

/**
 * Scrub before send (first of the two scrubs; the Lambda re-scrubs): send
 * only allowlisted fields, cap sizes, strip query strings from URL-ish
 * content (source is already a bare pathname; stacks may embed script URLs).
 * @param {{ type: string, message: string, stack?: string, source: string,
 *   release: string, id: string, ts: string }} raw
 * @returns {Record<string, string>} scrubbed payload
 */
function scrub(raw) {
  return {
    type: raw.type,
    message: cap(raw.message, MAX_MESSAGE),
    ...(raw.stack
      ? { stack: cap(stripStackQueryStrings(raw.stack), MAX_STACK) }
      : {}),
    ...(raw.source ? { source: raw.source } : {}),
    release: raw.release,
    id: raw.id,
    ts: raw.ts,
  };
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
function stripStackQueryStrings(stack) {
  return stack.replace(/https?:\/\/[^\s)]*/g, (url) => {
    const framePos = url.match(/^(.*):(\d+):(\d+)$/);
    if (framePos && framePos[1]?.includes("?")) {
      return `${stripQueryString(framePos[1])}:${framePos[2]}:${framePos[3]}`;
    }
    return stripQueryString(url);
  });
}

/** @param {string} value @returns {string} `?` and after removed */
function stripQueryString(value) {
  const i = value.indexOf("?");
  return i === -1 ? value : value.slice(0, i);
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
 * falls back to a non-UUID random string when storage or crypto.randomUUID
 * are unavailable — never throws.
 * @returns {string}
 */
function distinctId() {
  try {
    const existing = localStorage.getItem("gnp:distinct-id");
    if (existing) return existing;
  } catch {
    // storage unavailable — fall through to a fresh id
  }
  const fresh = randomId();
  try {
    localStorage.setItem("gnp:distinct-id", fresh);
  } catch {
    // best-effort persistence only
  }
  return fresh;
}

/**
 * crypto.randomUUID() with layered fallbacks (older browsers, insecure
 * contexts). Last resort: Math.random — uniqueness beats nothing.
 * @returns {string}
 */
function randomId() {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    if (typeof crypto !== "undefined" && crypto.getRandomValues) {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
      bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 1
      const hex = Array.from(bytes, (b) =>
        b.toString(16).padStart(2, "0"),
      ).join("");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
  } catch {
    // fall through to the last resort
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * The build-time release define. Vite `define` substitutes the bare
 * `__RELEASE__` identifier at build time (member expressions like
 * `globalThis.__RELEASE__` are NOT substituted), so read it as a plain
 * identifier with a guarded typeof.
 * @returns {string} "dev" locally; CI injects the sha via vite.config.js
 */
function release() {
  try {
    // @ts-expect-error -- build-time define (vite.config.js `define`); not a
    // runtime global, so it has no ambient declaration.
    return typeof __RELEASE__ === "string" ? __RELEASE__ : "dev";
  } catch {
    return "dev";
  }
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

// Self-install at import time. main.js imports this module first — before any
// component or library side-effect imports — so listeners exist before
// bootstrap code that could throw. (Idempotent; re-export kept for tests.)
installErrorReporting();
