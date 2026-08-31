/*
  feedback.js — the one-call client for the in-app feedback form.

  POSTs a scrubbed payload to our own endpoint (`POST /v1/feedback`); the Lambda
  validates + re-scrubs and logs one `FeedbackReceived` JSON line — the log line
  IS the store (docs/todo/feedback-plan.md). Unlike error beacons this is NOT
  fire-and-forget: the user is waiting on a confirmation, so the promise resolves
  on any acknowledged request (2xx from our always-204 handler) and rejects only
  on a transport failure, letting the UI show a gentle retry.

  Conventions mirror services/error-report.js: `page` is a bare pathname (query
  stripped), the distinct id is the shared `gnp:distinct-id` localStorage UUID,
  and every storage/global access is failure-safe. No offline queue — offline is
  deferred app-wide (ADR 0005).
*/

// Same-origin / Vite-proxy resolution, shared with services/api.js (see its
// BASE rationale: dev proxy, prod same-origin, CSP connect-src 'self').
const BASE = /** @type {any} */ (import.meta).env?.VITE_API_BASE ?? "";

/** Client-side cap; the server re-caps (never trust the client). */
const MAX_MESSAGE = 2000;

/**
 * Send user feedback best-effort. The server always answers 204 for a valid
 * payload; anything else (network failure, 4xx/5xx) rejects.
 * @param {{ message: string, site?: string }} input
 *   `site` is the bound site id when the caller has one (optional context).
 * @returns {Promise<void>}
 */
export async function sendFeedback({ message, site }) {
  const text =
    typeof message === "string" ? message.trim().slice(0, MAX_MESSAGE) : "";
  if (!text) {
    throw new Error("Feedback message is empty");
  }
  const payload = {
    message: text,
    page: safePathname(),
    ...(typeof site === "string" && site ? { site } : {}),
    release: release(),
    id: distinctId(),
    ts: new Date().toISOString(),
  };

  const res = await fetch(`${BASE}/v1/feedback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    keepalive: true,
  });
  if (!res.ok) {
    throw new Error(`Feedback POST failed: ${res.status}`);
  }
}

/**
 * Current pathname, query string stripped (first scrub; the Lambda re-scrubs).
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

/**
 * Distinct per-browser id (localStorage-persisted random UUID) — the SAME key
 * error-report.js uses, so error + feedback reports correlate per device.
 * Failure-safe: a fresh random id per call when storage is unavailable.
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