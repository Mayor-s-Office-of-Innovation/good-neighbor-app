/*
  backend-health.js — connection/auth state machine (api-response-integrity
  plan §3a/3b).

  Probes the authorizer-free `GET /health` route to separate transport/CDN
  health from token health. One per-service failure map and retry scheduler
  own reachability; auth/access state is independent. User-facing states:

    - OUTAGE — the API is unreachable (network failure or a non-JSON/HTML
      response, e.g. a CDN error page served as 200). The shared banner
      clears after all recorded services verify recovery.
    - ACCESS — a manager_access_required 403 needs manager enrollment.
      Dismissing the dialog preserves the session and saved work. Other
      application permission denials stay with the action's error UI.
    - AUTH   — the device session is dead (ReauthRequiredError, or a bare API
      gateway 403). Surface: sign-out dialog; recovery is site
      re-entry (clearSite → site-setup).

  Detection hooks: boot probe, visibilitychange re-probe, and a classify()
  call from api-layer catch sites, plus observed requests and browser events.
  Re-probes back off (30s → 60s → …, cap 5min) while unhealthy. Pure state + subscribers; UI wiring lives in
  app-root.js.
*/

import { reportClientEvent } from "./error-report.js";
import { mark } from "./instrument.js";

/** @typedef {"healthy" | "outage" | "auth" | "access"} HealthState */

const PROBE_PATH = "/health";
const BACKOFF_MS = [30_000, 60_000, 120_000, 300_000];

/** @type {"healthy" | "auth" | "access"} */
let state = "healthy";
/** @type {Set<(state: HealthState) => void>} */
const listeners = new Set();
/** @type {(() => void) | undefined} */
let visibilityHook;
/** @type {number} */
let backoffIndex = 0;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let retryTimer;
// Explicit probes and shell monitoring own the retry lifecycle. Merely
// importing the request wrapper must not start a background retry chain.
let retryEnabled = false;
/** Newer probes supersede older results for the same service in both paths.
 * @type {Map<string, number>}
 */
const probeSequences = new Map();
/** @param {string} service */
function beginProbe(service) {
  const seq = (probeSequences.get(service) || 0) + 1;
  probeSequences.set(service, seq);
  return seq;
}

/** @returns {HealthState} */
export function getHealthState() {
  return state === "healthy" && connectionSnapshot().disconnected
    ? "outage"
    : state;
}

/** @param {(state: HealthState) => void} listener @returns {() => void} */
export function onHealthChange(listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emit() {
  listeners.forEach((listener) => listener(getHealthState()));
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
    return getHealthState();
  }
  if (!(err instanceof Error) || err.name !== "ApiError")
    return getHealthState();
  const status = /** @type {any} */ (err).status;
  // Non-JSON responses mean the pipe is broken REGARDLESS of status — an
  // HTML 403 from an intermediary is a transport failure, not an auth
  // verdict. Check before status-based classification so a rewritten
  // response can never trigger the destructive AUTH recovery.
  if (/** @type {any} */ (err).body?.code === "non_json_response") {
    recordApiOutage();
    void probe();
    return getHealthState();
  }
  if (status === 403) {
    // Only missing manager access needs the global enrollment guidance.
    // Other structured denials belong to the action's own error UI; bare
    // gateway denials still represent a rejected device session.
    const code = /** @type {any} */ (err).body?.error;
    if (state !== "auth") {
      if (code === "manager_access_required") setState("access");
      else if (typeof code !== "string") setState("auth");
    }
    return getHealthState();
  }
  if (status === 0) {
    recordApiOutage();
    return getHealthState();
  }
  return getHealthState();
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
  retryEnabled = true;
  const generation = failureGeneration;
  const target = connectionTarget(PROBE_PATH);
  endpoints.set(target.service, target.probeUrl);
  if ((cooldowns.get(target.service) || 0) > Date.now())
    return getHealthState();
  const seq = beginProbe(target.service);
  let response;
  let ok = false;
  try {
    const res = await fetch(PROBE_PATH, {
      method: "GET",
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });
    response = res;
    ok = res.ok && JSON.parse(await res.text())?.ok === true;
  } catch {
    /* The probe has not verified recovery. */
  }
  if (
    seq !== probeSequences.get(target.service) ||
    generation !== failureGeneration
  )
    return getHealthState();
  if (response?.status === 429) recordCooldown(target.service, response);
  clearRetryTimer();
  if (ok) {
    connectionSucceeded(target.service, generation);
    if (failures.size) await retryConnection();
    else resetBackoff();
  } else {
    connectionFailed(target.service, target.probeUrl);
  }
  return getHealthState();
}

/** Boot wiring: initial probe + visibility re-probe. Idempotent. */
export function startHealthMonitoring() {
  startConnectionMonitoring();
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
  retryEnabled = false;
  stopConnectionMonitoring();
  clearRetryTimer();
  resetBackoff();
}

/**
 * AUTH recovery completed: the device re-registered (sitebound). Authentication clears; any reachability failure remains visible.
 * @returns {void}
 */
export function clearAuthState() {
  resetBackoff();
  setState("healthy");
}
/** Dismiss a permission denial without changing an expired-session verdict. */
export function clearAccessState() {
  if (state === "access") setState("healthy");
}

/* ---- internals ---- */

/** @param {"healthy" | "auth" | "access"} next */
function setState(next) {
  if (state === next) return;
  state = next;
  mark("backend-health", { state: next });
  if (next === "auth") {
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
    void retryConnection();
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

function recordApiOutage() {
  const target = connectionTarget(PROBE_PATH);
  connectionFailed(target.service, target.probeUrl);
}

/** Reachability is separate from authentication and operation/write success. */
/** @type {Map<string, string>} */
const failures = new Map();
/** @type {Map<string, string>} */
const endpoints = new Map();
const cooldowns = new Map();
/** @type {Set<(state: {disconnected: boolean}) => void>} */
const connectionListeners = new Set();
let installed = false;
let failureGeneration = 0;
/** @type {Promise<unknown> | undefined} */
let retrying;
export const connectionSnapshot = () => ({
  disconnected: globalThis.navigator?.onLine === false || failures.size > 0,
});
const emitConnection = () => {
  connectionListeners.forEach((fn) => fn(connectionSnapshot()));
  emit();
};
/** @param {(state: {disconnected: boolean}) => void} fn */
export function onConnectionChange(fn) {
  connectionListeners.add(fn);
  return () => connectionListeners.delete(fn);
}
export function connectionFailed(service = "api", probeUrl = "") {
  failureGeneration += 1;
  const first = !failures.has(service);
  failures.set(service, probeUrl);
  if (first) {
    mark("backend-health", { state: getHealthState() });
    if (failures.size === 1)
      reportClientEvent(
        "backend_unreachable",
        "connection probe or request failed",
      );
    emitConnection();
  }
  if (retryEnabled && !retryTimer) scheduleProbe();
}
export function connectionSucceeded(
  service = "api",
  generation = failureGeneration,
) {
  // Loopback and in-flight responses do not prove recovery from browser offline.
  if (
    globalThis.navigator?.onLine === false ||
    generation !== failureGeneration
  )
    return;
  cooldowns.delete(service);
  const changed = failures.delete(service);
  if (changed) failures.delete("browser");
  if (!failures.size) {
    clearRetryTimer();
    resetBackoff();
  }
  if (changed) {
    emitConnection();
    if (
      !service.startsWith("auth:") &&
      ![...failures.keys()].some((key) => !key.startsWith("auth:"))
    )
      globalThis.window?.dispatchEvent(new Event("connectionretry"));
  }
}
export async function retryConnection() {
  if (globalThis.navigator?.onLine === false) return;
  const generation = failureGeneration;
  if (retrying) return retrying;
  retrying = Promise.all(
    [...failures].map(async ([service, url]) => {
      if (!url || (cooldowns.get(service) || 0) > Date.now()) return;
      const seq = beginProbe(service);
      try {
        const originProbe =
          service.startsWith("upload:") || service.startsWith("auth:");
        // Browsers require follow mode for no-cors GETs. Credentials stay
        // omitted across redirects; no signed path, headers or body are reused.
        const response = await fetch(url, {
          ...(originProbe
            ? { mode: "no-cors", credentials: "omit", redirect: "follow" }
            : {}),
          cache: "no-store",
          signal: AbortSignal.timeout(10000),
        });
        const ok = originProbe
          ? response.type !== "error"
          : response.ok && JSON.parse(await response.text())?.ok === true;
        // Check after reading the body too: a newer probe may finish while
        // this response is still streaming. Stale cooldowns must not stick.
        if (
          seq !== probeSequences.get(service) ||
          generation !== failureGeneration
        )
          return;
        if (response.status === 429) {
          recordCooldown(service, response);
        } else if (ok) {
          connectionSucceeded(service, generation);
        }
      } catch {
        /* No optimistic online state: this service has not recovered. */
      }
    }),
  ).finally(() => {
    retrying = undefined;
    if (retryEnabled && failures.size && !retryTimer) scheduleProbe();
  });
  return retrying;
}
/** Service keys and probes contain no signed URLs or credentials.
 * Opaque GETs prove host reachability only, never authentication or write success.
 * @param {string} value
 */
export function connectionTarget(value) {
  const url = new URL(value, globalThis.location?.href || "http://localhost");
  if (url.pathname === "/oauth2/token")
    return { service: `auth:${url.origin}`, probeUrl: `${url.origin}/` };
  if (url.pathname.endsWith("/health")) {
    const prefix = url.pathname.slice(0, -7);
    return {
      service: `api:${url.origin}${prefix}`,
      probeUrl: `${url.origin}${prefix}/health`,
    };
  }
  const match = url.pathname.match(
    /^(.*?)\/(?:admin\/|app\/)?v1(?:\/|$)|^(.*?)\/site-code$/,
  );
  if (!match)
    return { service: `upload:${url.origin}`, probeUrl: `${url.origin}/` };
  const prefix = match[1] ?? match[2] ?? "";
  return {
    service: `api:${url.origin}${prefix}`,
    probeUrl: `${url.origin}${prefix}/health`,
  };
}
/** Explicitly observed requests exclude telemetry. HTTP errors are reachable, not transport loss.
 * @param {RequestInfo | URL} input
 * @param {RequestInit} [init]
 * @returns {Promise<Response>}
 */
export async function connectionFetch(input, init = {}) {
  const generation = failureGeneration;
  const target = connectionTarget(
    typeof input === "string" || input instanceof URL
      ? String(input)
      : input.url,
  );
  if (target.probeUrl) endpoints.set(target.service, target.probeUrl);
  try {
    const response = await fetch(input, init);
    // Do not announce recovery from a CDN HTML fallback before the API
    // parser has a chance to classify it as an outage.
    if (
      target.service.startsWith("api:") &&
      typeof response.clone === "function" &&
      (await response.clone().text()).trimStart().startsWith("<")
    )
      connectionFailed(target.service, target.probeUrl);
    else connectionSucceeded(target.service, generation);
    return response;
  } catch (error) {
    if (
      error?.name !== "AbortError" &&
      (!init.signal?.aborted || init.signal.reason?.name === "TimeoutError")
    )
      connectionFailed(target.service, target.probeUrl);
    throw error;
  }
}
export function startConnectionMonitoring() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  retryEnabled = true;
  offlineHook = () => {
    connectionFailed("browser", endpoints.values().next().value || "/health");
    for (const [service, url] of endpoints) connectionFailed(service, url);
  };
  window.addEventListener("offline", offlineHook);
  onlineHook = () => {
    void retryConnection();
  };
  window.addEventListener("online", onlineHook);
  if (navigator.onLine === false) offlineHook();
}

/** @type {(() => void) | undefined} */
let offlineHook;
/** @type {(() => void) | undefined} */
let onlineHook;
function stopConnectionMonitoring() {
  if (offlineHook)
    globalThis.window?.removeEventListener("offline", offlineHook);
  if (onlineHook) globalThis.window?.removeEventListener("online", onlineHook);
  offlineHook = onlineHook = undefined;
  installed = false;
}

/** @param {string} service @param {Response} response */
function recordCooldown(service, response) {
  const advice = response.headers.get("retry-after");
  const seconds = Number(advice);
  const delay =
    advice && Number.isFinite(seconds)
      ? seconds * 1000
      : Math.max(0, Date.parse(advice || "") - Date.now());
  cooldowns.set(
    service,
    Date.now() + (Number.isFinite(delay) ? Math.max(1000, delay) : 300000),
  );
}
