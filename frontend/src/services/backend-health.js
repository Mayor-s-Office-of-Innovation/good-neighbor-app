/*
  backend-health.js — connection/auth state machine (api-response-integrity
  plan §3a/3b).

  Probes the authorizer-free `GET /health` route to separate transport/CDN
  health from token health, and classifies failures into two user-facing
  states:

    - OUTAGE — the API is unreachable (network failure or a non-JSON/HTML
      response, e.g. a CDN error page served as 200). Surface: dismissible
      banner; clears on the first successful probe.
    - AUTH   — the device session is dead (ReauthRequiredError, or an API 403
      while the probe is healthy). Surface: sign-out dialog; recovery is site
      re-entry (clearSite → site-setup).

  Detection hooks: boot probe, visibilitychange re-probe, and a classify()
  call from api-layer catch sites. Re-probes back off (30s → 60s → …, cap
  5min) while unhealthy. Pure state + subscribers; UI wiring lives in
  app-root.js.
*/

import { reportClientEvent } from "./error-report.js";
import { mark } from "./instrument.js";

/** @typedef {"healthy" | "outage" | "auth"} HealthState */

const PROBE_PATH = "/health";
const BACKOFF_MS = [30_000, 60_000, 120_000, 300_000];

/** @type {HealthState} */
let state = "healthy";
/** @type {Set<(state: HealthState) => void>} */
const listeners = new Set();
/** @type {(() => void) | undefined} */
let visibilityHook;
/** @type {number} */
let backoffIndex = 0;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let retryTimer;
/**
 * Monotonic probe id — a completion may write state only if it is still the
 * newest probe (guards concurrent boot/visibility/failure probes).
 */
let probeSeq = 0;

/** @returns {HealthState} */
export function getHealthState() {
  return state;
}

/** @param {(state: HealthState) => void} listener @returns {() => void} */
export function onHealthChange(listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emit() {
  listeners.forEach((listener) => listener(state));
}

/**
 * Classify an API-layer failure into a health state. Called from catch sites
 * so a failing /v1/* call sets the state immediately, without waiting for the
 * next probe.
 * @param {unknown} err
 * @returns {HealthState} the new state (unchanged when unclassifiable)
 */
export function classifyApiFailure(err) {
  if (err instanceof Error && err.name === "ReauthRequiredError") {
    setState("auth");
    return state;
  }
  if (!(err instanceof Error) || err.name !== "ApiError") return state;
  const status = /** @type {any} */ (err).status;
  // Non-JSON responses mean the pipe is broken REGARDLESS of status — an
  // HTML 403 from an intermediary is a transport failure, not an auth
  // verdict. Check before status-based classification so a rewritten
  // response can never trigger the destructive AUTH recovery.
  if (/** @type {any} */ (err).body?.code === "non_json_response") {
    setState("outage");
    void probe();
    return state;
  }
  if (status === 403) {
    // 401s already route to the refresh flow; a bare JSON 403 means the
    // authorizer denied a well-formed token (revoked device / inactive site).
    setState("auth");
    return state;
  }
  if (status === 0) {
    setState("outage");
    return state;
  }
  return state;
}

/**
 * Probe /health and reconcile the state. Authorizer-free, so a healthy probe
 * cannot "heal" an AUTH state (the token is still dead) — it can only clear
 * OUTAGE. AUTH clears only via clearAuthState().
 *
 * Concurrency: probes are unawaited from several trigger sites, so every
 * probe captures the current sequence number and a completion writes state
 * only if no newer probe has started — a stale failure can never clobber a
 * newer healthy result.
 * @returns {Promise<HealthState>}
 */
export async function probe() {
  const seq = ++probeSeq;
  let ok = false;
  try {
    const res = await fetch(PROBE_PATH, { method: "GET" });
    const text = await res.text();
    // The health handler speaks JSON; HTML here is the CDN incident shape.
    ok = res.ok && text.trim().startsWith("{");
  } catch {
    ok = false;
  }

  if (seq !== probeSeq) {
    // Superseded by a newer probe — its result owns the state.
    return state;
  }
  clearRetryTimer();

  if (ok) {
    // A healthy probe recovers OUTAGE only; AUTH is user-resolved. Backoff
    // resets on success (external triggers restart the ladder too — the
    // ladder exists only for repeated FAILURE retries).
    resetBackoff();
    if (state === "outage") setState("healthy");
  } else {
    if (state !== "auth") setState("outage");
    scheduleProbe();
  }
  return state;
}

/** Boot wiring: initial probe + visibility re-probe. Idempotent. */
export function startHealthMonitoring() {
  if (!visibilityHook) {
    visibilityHook = () => {
      if (!document.hidden) void probe();
    };
    document.addEventListener("visibilitychange", visibilityHook);
  }
  void probe();
}

/** Stop visibility re-probing AND the live retry chain (tests / teardown). */
export function stopHealthMonitoring() {
  if (visibilityHook) {
    document.removeEventListener("visibilitychange", visibilityHook);
    visibilityHook = undefined;
  }
  clearRetryTimer();
  resetBackoff();
}

/**
 * AUTH recovery completed: the device re-registered (sitebound). Everything
 * clears back to healthy.
 * @returns {void}
 */
export function clearAuthState() {
  resetBackoff();
  setState("healthy");
}
/* ---- internals ---- */

/** @param {HealthState} next */
function setState(next) {
  if (state === next) return;
  state = next;
  mark("backend-health", { state: next });
  if (next === "outage") {
    reportClientEvent("backend_unreachable", "GET /health probe failed");
  } else if (next === "auth") {
    reportClientEvent("auth_reauth_required", "device session rejected");
  }
  emit();
}

function scheduleProbe(delay = BACKOFF_MS[backoffIndex]) {
  backoffIndex = Math.min(backoffIndex + 1, BACKOFF_MS.length - 1);
  // One live retry chain: a new schedule replaces any pending timer.
  clearRetryTimer();
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    void probe();
  }, delay);
}

function clearRetryTimer() {
  if (retryTimer !== undefined) {
    clearTimeout(retryTimer);
    retryTimer = undefined;
  }
}

function resetBackoff() {
  backoffIndex = 0;
}
