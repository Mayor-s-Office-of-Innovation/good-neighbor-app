import { parseRetryAfter } from "../lib/retry-after.js";
import { observePhotoStage, photoAttemptId } from "./photo-telemetry.js";
import { clearTaskStatusOverrides } from "../state/task-status-overrides.js";
import { invalidateDuplicateIssues } from "./duplicate-invalidation.js";
/*
  api.js — the field app's thin online client for the GNP backend.

  Plain request/response, NOT a sync layer: writes fire when the user acts, reads
  fire when a screen loads (see docs/archive/frontend-api-wiring-plan.md). Offline is
  deferred to post-MVP, so there is no local queue and no `synced` reconciliation —
  every call throws `ApiError` on a non-2xx or network failure so callers surface
  an error instead of silently degrading.

  Backend contract (analysis-backend Step C) invariants:
    - `siteId` is derived server-side from the principal; the client NEVER sends it.
    - the client mints `checkId` and sends it as the `idempotency-key` header, so
      every write is safely replayable.
    - media bytes go straight to S3 via a presigned PUT — they never transit this API.
*/

import { reserveMediaUpload } from "./upload-reservation.js";
import { contentTypeFor } from "../domain/attachment-files.js";
import { pollCheck } from "./check-polling.js";
import { mark, span } from "./instrument.js";
import { getSite, updateSiteSession, prepareRefreshAttempt } from "../db.js";
import { refreshDeviceToken } from "./devices.js";
import { ApiError, ReauthRequiredError } from "./api-error.js";
import { reportClientEvent } from "./error-report.js";
import { classifyApiFailure } from "./backend-health.js";
import { getLocale } from "../i18n/locale.js";

// Public error surface stays on api.js (existing importers); the classes live
// in api-error.js because devices.js needs them too and importing api.js from
// devices.js would be a cycle.
export { ApiError, ReauthRequiredError };

// Same-origin everywhere: in dev the Vite proxy forwards `/v1/*` → the local API
// on :3001 (no CORS — see vite.config.js); in production the SPA and API share
// one CloudFront distribution, so BASE stays "" and calls are relative. Setting
// VITE_API_BASE to a cross-origin URL would trip the connect-src 'self' CSP.
// Shared strategy with services/onboarding.js. Cast `import.meta` — Vite's env
// types (vite/client) aren't wired into this checkJs project, so the
// host-injected `.env` access is typed locally.
const BASE = /** @type {any} */ (import.meta).env?.VITE_API_BASE ?? "";

/*
  Device-token plumbing (Option 4 device auth, docs/adr/0010): every request
  rides `Authorization: Bearer <token>` from the stored site record. On an
  authentication rejection — a 401 locally, or API Gateway's authorizer-level
  403 in AWS — or pre-emptively when the access token is near expiry, the session is
  refreshed silently with the single-use rotating refresh token (never the site
  code; the code-holder may not be around). One in-flight refresh is shared by
  concurrent requests; failures surface as `ReauthRequiredError`.
*/

/** Share refreshes only among requests for the same site. */
const refreshInFlight = new Map();

class SiteBindingChangedError extends Error {
  constructor() {
    super("The active site changed while this request was in flight.");
    this.name = "SiteBindingChangedError";
  }
}

/** @param {string} expectedSiteId */
async function assertActiveSite(expectedSiteId) {
  const current = await getSite().catch(() => null);
  if (current?.siteId !== expectedSiteId) throw new SiteBindingChangedError();
  return current;
}

/**
 * Exchange the stored refresh token for a fresh pair and persist it. Shared
 * promise so N concurrent 401s trigger exactly one refresh. Throws
 * `ReauthRequiredError` when the refresh is rejected as fatal.
 *
 * Two stale-snapshot hazards shape this function:
 * - The caller's `site` was read before its fetch, so `site.refreshToken` can
 *   be the token a JUST-completed rotation already consumed. Sending it would
 *   be a doomed replay — so always re-read the stored record and use its
 *   CURRENT refresh token. If another request's rotation already landed, this
 *   succeeds (or rotates again — harmless); it never needs the caller's
 *   snapshot to be fresh.
 * - A request whose 401 lands AFTER a completed refresh used to poison its own
 *   retry: `request` re-read the site but the shared promise it awaited had
 *   already resolved with the older rotation. Re-reading here (inside the
 *   shared promise) means every waiter observes the latest persisted session.
 * @param {string} siteId the site that started the request
 * @param {string} expectedToken access token that prompted this refresh
 * @param {{deviceId?: string, localSessionId?: string} | null | undefined} expectedBinding
 * @returns {Promise<{ token: string }>}
 */
async function refreshSession(siteId, expectedToken, expectedBinding) {
  const key = `${siteId}:${expectedBinding?.localSessionId ?? expectedBinding?.deviceId ?? ""}`;
  const existing = refreshInFlight.get(key);
  if (existing) return existing;
  const rotate = async () => {
    // Re-read inside the shared promise — never trust the caller's snapshot.
    const site = await assertActiveSite(siteId);
    if (
      site.deviceId !== expectedBinding?.deviceId ||
      site.localSessionId !== expectedBinding?.localSessionId
    )
      throw new SiteBindingChangedError();
    // A different tab may have rotated while we waited for the origin-wide
    // lock. Use its persisted token instead of spending another refresh token.
    if (site?.token && site.token !== expectedToken)
      return { token: site.token };
    const refreshToken = site?.refreshToken;
    if (!refreshToken) throw new ReauthRequiredError();
    try {
      const attemptId = await prepareRefreshAttempt(siteId, refreshToken);
      if (!attemptId) throw new SiteBindingChangedError();
      const session = await refreshDeviceToken(refreshToken, attemptId);
      if (session.site?.siteId && session.site.siteId !== siteId) {
        throw new SiteBindingChangedError();
      }
      const stored = await updateSiteSession(session, siteId, refreshToken);
      if (!stored) {
        const current = await assertActiveSite(siteId);
        if (
          current.token === session.token &&
          current.refreshToken === session.refreshToken
        )
          return { token: current.token };
        throw new SiteBindingChangedError();
      }
      mark("auth:refreshed", { generation: session.tokenGeneration });
      return { token: session.token };
    } catch (err) {
      if (err instanceof SiteBindingChangedError) throw err;
      const current = await assertActiveSite(siteId);
      if (
        current.deviceId !== site.deviceId ||
        current.localSessionId !== site.localSessionId
      )
        throw new SiteBindingChangedError();
      // Also recover from a rotation by an older tab without Web Locks.
      if (current?.token && current.refreshToken !== refreshToken) {
        return { token: current.token };
      }
      // A 401 from the refresh endpoint is fatal: the stored session cannot
      // renew. 5xx/transport stays retryable — the session may be fine.
      if (is401(err)) throw new ReauthRequiredError();
      throw err;
    }
  };
  // Web Locks serialize rotations across tabs sharing this origin's IndexedDB.
  // Older browsers retain the in-tab guard and the rejection recovery above.
  const locks = globalThis.navigator?.locks;
  const pending = locks
    ? locks.request(`gnp:refresh:${siteId}`, rotate)
    : rotate();
  refreshInFlight.set(key, pending);
  try {
    return await pending;
  } finally {
    if (refreshInFlight.get(key) === pending) {
      refreshInFlight.delete(key);
    }
  }
}

/**
 * @param {unknown} err
 * @returns {boolean} true for a 401 ApiError (transport failures are 0)
 */
function is401(err) {
  return err instanceof ApiError && err.status === 401;
}

/**
 * API Gateway returns a bare 403 for requests rejected by its authorizer,
 * including an expired access token. Application-level authorization failures
 * use structured `error` codes and must not trigger a token rotation.
 * @param {number} status
 * @param {unknown} body
 * @returns {boolean}
 */
function isAccessTokenRejection(status, body) {
  if (status === 401) return true;
  if (status !== 403 || !body || typeof body !== "object") return false;
  const response = /** @type {Record<string, unknown>} */ (body);
  return (
    !("error" in response) &&
    (response.message === "Forbidden" ||
      response.message === "User is not authorized to access this resource")
  );
}

/** @param {unknown} err */
function isAccessTokenError(err) {
  return (
    err instanceof ApiError && isAccessTokenRejection(err.status, err.body)
  );
}

/**
 * Refresh this close to the stored access-token expiry instead of sending a
 * token the authorizer is about to reject. Covers a slightly fast client
 * clock as well as the request's own travel time.
 */
export const ACCESS_TOKEN_REFRESH_MARGIN_MS = 60_000;

/**
 * Whether a stored access token is expired or inside the refresh margin.
 * `tokenExpiresAt` is an ISO string (db.js) but older records may hold an
 * epoch-millisecond number; an unreadable value means "unknown", and the
 * token is sent as-is so the rejection path can decide.
 * @param {unknown} tokenExpiresAt
 * @param {number} [now]
 * @returns {boolean}
 */
export function isAccessTokenExpiring(tokenExpiresAt, now = Date.now()) {
  const expiresAt =
    typeof tokenExpiresAt === "number"
      ? tokenExpiresAt
      : typeof tokenExpiresAt === "string"
        ? Date.parse(tokenExpiresAt)
        : NaN;
  if (!Number.isFinite(expiresAt)) return false;
  return expiresAt - now <= ACCESS_TOKEN_REFRESH_MARGIN_MS;
}

/**
 * Wait for `promise`, but stop waiting as soon as `signal` aborts. The
 * promise itself keeps running (a shared refresh must still persist its
 * result for the other requests riding it); only this caller lets go.
 * @template T
 * @param {Promise<T>} promise
 * @param {AbortSignal} [signal]
 * @returns {Promise<T>}
 */
function untilAborted(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(new DOMException("Request aborted", "AbortError"));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () =>
      reject(new DOMException("Request aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

// A request that has not finished after this long counts as a lost connection
// (status 0), so a weak signal fails over to the offline paths instead of
// hanging. Generous: a slow but working connection should still get through.
export const REQUEST_TIMEOUT_MS = 30_000;
// Photo uploads: abort when no bytes have moved for this long (XHR), or when
// the whole PUT is slower than UPLOAD_MIN_BYTES_PER_SECOND (fetch).
export const UPLOAD_STALL_MS = 30_000;
const UPLOAD_MIN_BYTES_PER_SECOND = 20_000;

/**
 * An abort signal that fires when `signal` does or after `ms`. `timedOut()`
 * tells the two apart; `clear()` stops the timer once the work is done.
 * (AbortSignal.any / .timeout are missing on older devices.)
 * @param {AbortSignal | undefined} signal
 * @param {number} ms
 */
function withTimeout(signal, ms) {
  const controller = new AbortController();
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    controller.abort();
  }, ms);
  const forward = () => controller.abort();
  if (signal?.aborted) forward();
  else signal?.addEventListener("abort", forward, { once: true });
  return {
    signal: controller.signal,
    timedOut: () => expired,
    clear: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", forward);
    },
  };
}

/**
 * One JSON request against the backend. Serializes an object body, parses a
 * JSON response, and throws `ApiError` on a non-2xx status or a transport
 * failure. Attaches the device token when a session exists, refreshing first
 * when the stored token is known to be expiring (so the common idle-tab case
 * never produces a 403 round trip), and retries once through a silent
 * refresh on an access-token rejection.
 * @param {string} method
 * @param {string} path        path beginning with `/` (joined onto BASE)
 * @param {object} [opts]
 * @param {Record<string,string>} [opts.headers]
 * @param {unknown} [opts.body]  JSON-serializable body (omitted for GET)
 * @param {AbortSignal} [opts.signal]
 * @param {boolean} [opts.allowAuthRetry] internal: set false on the retry leg
 *   to stop a 401 loop
 * @param {string} [opts.originSiteId] internal: keep retries bound to the original site
 * @returns {Promise<any>} the parsed JSON body (null for an empty 2xx)
 */
async function request(method, path, opts = {}) {
  const timeout = withTimeout(opts.signal, REQUEST_TIMEOUT_MS);
  try {
    return await requestOnce(method, path, { ...opts, signal: timeout.signal });
  } catch (err) {
    if (!timeout.timedOut() || opts.signal?.aborted) throw err;
    const timedOut = new ApiError(
      `Timed out after ${REQUEST_TIMEOUT_MS}ms calling ${method} ${path}`,
      { status: 0 },
    );
    classifyApiFailure(timedOut);
    throw timedOut;
  } finally {
    timeout.clear();
  }
}

/**
 * `request` without the time limit; the signal covers the refresh, the
 * fetch, and reading the body.
 * @param {string} method
 * @param {string} path
 * @param {Parameters<typeof request>[2]} [opts]
 * @returns {Promise<any>}
 */
async function requestOnce(
  method,
  path,
  { headers = {}, body, signal, allowAuthRetry = true, originSiteId } = {},
) {
  const hasBody = body !== undefined;
  const site = await getSite().catch(() => null);
  if (originSiteId && site?.siteId !== originSiteId) {
    throw new SiteBindingChangedError();
  }
  const requestSiteId = originSiteId || site?.siteId || "";
  let token = site?.token;
  // Pre-flight refresh: a token past (or within a minute of) its stored
  // expiry is certain to be rejected, so renew before the fetch rather than
  // after a 403. Only a fatal refresh outcome stops the request. A 5xx or
  // transport failure is remembered and the stored token is sent anyway —
  // inside the margin it usually still works — but if it IS rejected the
  // remembered failure is surfaced rather than asking the same unhealthy
  // refresh endpoint a second time. The caller's signal is honored while
  // waiting: an aborted request stops here without touching the network.
  /** @type {Error | null} */
  let preflightRefreshError = null;
  if (
    allowAuthRetry &&
    token &&
    site?.refreshToken &&
    isAccessTokenExpiring(site.tokenExpiresAt)
  ) {
    try {
      token = (
        await untilAborted(refreshSession(requestSiteId, token, site), signal)
      ).token;
    } catch (err) {
      if (
        signal?.aborted ||
        err instanceof ReauthRequiredError ||
        err instanceof SiteBindingChangedError
      ) {
        if (!signal?.aborted) classifyApiFailure(err);
        throw err;
      }
      preflightRefreshError = err instanceof Error ? err : null;
    }
  }
  const authHeaders = token ? { authorization: `Bearer ${token}` } : {};

  /** @type {Response} */
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        ...(hasBody ? { "content-type": "application/json" } : {}),
        ...authHeaders,
        ...headers,
      },
      ...(hasBody ? { body: JSON.stringify(body) } : {}),
      signal,
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    // fetch only rejects on a transport failure (offline, DNS, CORS, abort).
    classifyApiFailure(
      new ApiError(`Network error calling ${method} ${path}: ${err}`, {
        status: 0,
      }),
    );
    throw new ApiError(`Network error calling ${method} ${path}: ${err}`, {
      status: 0,
    });
  }

  const text = await res.text();
  /** @type {any} */
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      if (res.status === 429) {
        // A throttling status remains throttling when an intermediary supplies
        // HTML. Other non-JSON responses retain the outage integrity checks.
        parsed = { error: "rate_limited" };
      } else {
        // Non-JSON from a JSON API means an intermediary rewrote the response
        // (e.g. a CDN error page served as 200) — a transport-grade failure,
        // never a usable body. Empty body stays legal (204s exist).
        const nonJson = new ApiError(
          `Non-JSON response from ${method} ${path} (status ${res.status})`,
          { status: res.status, body: { code: "non_json_response" } },
        );
        mark("api:non-json", { method, path, status: res.status });
        reportClientEvent(
          "non_json_response",
          `Non-JSON ${res.status} from ${method} ${path}`,
          { status: res.status },
        );
        classifyApiFailure(nonJson);
        throw nonJson;
      }
    }
  }

  if (!res.ok) {
    // Expired/revoked access token → ONE silent refresh, then retry. A second
    // auth rejection (or a rejected refresh) is fatal UNLESS the stored session was
    // superseded mid-flight (see the retry leg below).
    if (isAccessTokenRejection(res.status, parsed) && allowAuthRetry) {
      // The pre-flight refresh already failed on this request: the token was
      // rejected as predicted and the refresh endpoint is the problem.
      // Surface that (retryable) failure instead of a second doomed refresh.
      if (preflightRefreshError) {
        classifyApiFailure(preflightRefreshError);
        throw preflightRefreshError;
      }
      // Refresh from the CURRENT stored session — `site` here may be stale
      // (read before this request's fetch); refreshSession re-reads it.
      try {
        await refreshSession(requestSiteId, token, site);
      } catch (err) {
        classifyApiFailure(err);
        if (err instanceof ReauthRequiredError) throw err;
        // Retryable refresh failure (5xx/transport): surface as-is — the
        // stored session may be perfectly valid.
        throw err;
      }
      // The refreshed session is already persisted; retry with it. A second
      // 401 on this leg is fatal ONLY if the stored session is still the one
      // we just used. A concurrent late 401 may have rotated AGAIN after our
      // refresh completed (each rotation bumps tokenGeneration, instantly
      // invalidating our in-flight retry's token — devices.js CAS) — that's
      // a lost race, not a dead session: surface a plain 401 (this call
      // fails, the app stays healthy) instead of the global ReauthRequiredError.
      const retryToken = (await assertActiveSite(requestSiteId))?.token;
      try {
        return await request(method, path, {
          headers,
          body,
          signal,
          allowAuthRetry: false,
          originSiteId: requestSiteId,
        });
      } catch (err) {
        if (isAccessTokenError(err)) {
          const nowToken = (await getSite().catch(() => null))?.token;
          if (nowToken && nowToken !== retryToken) {
            // Superseded mid-flight: the LATEST persisted session is newer
            // than the token we rode. Throwing a plain ApiError keeps the
            // session alive (a later request rides the newer token).
            throw err;
          }
          const reauth = new ReauthRequiredError();
          classifyApiFailure(reauth);
          throw reauth;
        }
        throw err;
      }
    }
    const detail =
      parsed && typeof parsed === "object" && "error" in parsed
        ? parsed.error
        : res.statusText;
    const apiError = new ApiError(
      `${method} ${path} → ${res.status} ${detail}`,
      {
        status: res.status,
        body: parsed,
        retryAfterMs: parseRetryAfter(res.headers?.get?.("retry-after")),
      },
    );
    // Feed the health state machine (backend-health.js): 403 → AUTH, 0 →
    // OUTAGE, non-JSON already classified above. 401/refresh outcomes are
    // classified at their throw sites via the same hook.
    classifyApiFailure(apiError);
    throw apiError;
  }
  // These successful writes can change evidence, guidance or the original task
  // embedded in a duplicate result. Invalidate the whole site because a cached
  // original may be reached through an intermediate link. Reads never invalidate.
  // Separation notifies after clearing local status overrides in its wrapper.
  if (
    method !== "GET" &&
    ((/^\/v1\/checks\/[^/]+\/artifacts(?:$|\/)/.test(path) &&
      !path.endsWith("/presign")) ||
      /^\/v1\/assessments(?::evaluate$|\/[^/]+\/conditions\/[^/]+\/answers$)/.test(
        path,
      ) ||
      /^\/v1\/tasks\/[^/]+\/(?:complete|custom-action|action|updates)$/.test(
        path,
      ))
  )
    invalidateDuplicateIssues(
      requestSiteId,
      /^\/v1\/tasks\/[^/]+\/complete$/.test(path) && parsed?.task
        ? [parsed.task]
        : undefined,
    );
  return parsed;
}

/** Build a query string from defined params (drops undefined/null/empty). */
function qs(params) {
  const entries = Object.entries(params).filter(
    ([, v]) => v !== undefined && v !== null && v !== "",
  );
  if (!entries.length) return "";
  const u = new URLSearchParams();
  for (const [k, v] of entries) u.set(k, String(v));
  return `?${u.toString()}`;
}

// ── Checks ────────────────────────────────────────────────────────────────

/**
 * GET /v1/site — the bound site's settings (name, provider).
 * @returns {Promise<{ site: any }>}
 */
export function getSiteSettings() {
  return request("GET", "/v1/site");
}

/** Get the admin-only site information payload. */
export function getSiteAdmin() {
  return request("GET", "/v1/site-admin");
}

/**
 * Update one editable site-information section.
 * @param {"siteDetails"|"publicContact"|"perimeter"|"siteManagerPhone"} section
 * @param {Record<string, unknown>} values
 */
export function updateSiteAdmin(section, values) {
  return request("PATCH", "/v1/site-admin", {
    body: { section, values },
  });
}

/**
 * List one bounded page of the current provider's active sites.
 * @param {string} [cursor]
 */
export function listProviderSites(cursor = "") {
  return request(
    "GET",
    `/v1/provider-sites${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
  );
}

/** List the authenticated physical device's currently usable Site bindings. */
export function listDeviceBindings() {
  return request("GET", "/app/v1/device-bindings");
}

/**
 * Select one Site binding owned by the authenticated physical device.
 * @param {string} bindingId
 */
export function selectDeviceBinding(bindingId) {
  return request("POST", "/app/v1/device-bindings/select", {
    body: { bindingId },
  });
}

/**
 * Mint a Home Screen handoff grant for the authenticated device
 * (services/session-handoff.js). The secret comes back once, in this body.
 * @param {{ grantId: string, token: string } | null} [cached] reinstall a pending grant's cookie
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ grantId: string, token: string, expiresAt: string, startUrl: string }>}
 */
export function issueSessionHandoff(cached = null, signal) {
  return request("POST", "/app/v1/session-handoff", {
    body: cached ?? {},
    signal,
  });
}

/**
 * Retire the authenticated device's pending handoff grant (sign-out).
 * @param {{signal?: AbortSignal, endSession?: boolean}} [options]
 * @returns {Promise<{ retired: boolean }>}
 */
export function retireSessionHandoff({ signal, endSession = false } = {}) {
  return request("DELETE", "/app/v1/session-handoff", {
    signal,
    body: { endSession },
  });
}

/** @param {string} label @param {{accessLevel?: string, firstName?: string, lastName?: string, email?: string}} [invitation] */
export function createStaffEnrollmentGrant(label, invitation = {}) {
  return request("POST", "/app/v1/manager/staff-grants", {
    body: { label, ...invitation },
  });
}

/** Return metadata for the current Manager binding's staff grants; secrets are never returned. */
export function getCurrentStaffEnrollmentGrant() {
  return request("GET", "/app/v1/manager/staff-grants/current");
}

/** @param {string} grantId */
export function cancelStaffEnrollmentGrant(grantId) {
  return request(
    "DELETE",
    `/app/v1/manager/staff-grants/${encodeURIComponent(grantId)}`,
  );
}

/** List general-access devices at the current Manager binding's Site. */
export function listManagerDeviceBindings() {
  return request("GET", "/app/v1/manager/device-bindings");
}

/** @param {string} bindingId */
export function revokeManagerDeviceBinding(bindingId) {
  return request(
    "POST",
    `/app/v1/manager/device-bindings/${encodeURIComponent(bindingId)}/revoke`,
  );
}

/**
 * POST /v1/checks — start a perimeter run. The client-minted `checkId` rides in
 * the `idempotency-key` header (not the body), so a replay can't duplicate the
 * header. `siteId` is server-derived.
 * @param {string} checkId
 * @param {{ flowType?: "perimeter" | "single-problem" }} [body]
 * @returns {Promise<{ checkId: string, status: string, startedAt?: string }>}
 */
export function createCheck(checkId, body = {}) {
  return request("POST", "/v1/checks", {
    headers: { "idempotency-key": checkId },
    body,
  });
}

/**
 * POST /v1/checks/{checkId}/complete — close the run: fold analyzed artifacts
 * into the header scorecard and return it. (Guidance minting is per-item at
 * capture time; nothing consumes the envelope anymore.)
 * @param {string} checkId
 * @returns {Promise<{ checkId: string, status: string, grade: (string|null), issueCount: number, maxSeverity: number }>}
 */
export function completeCheck(checkId) {
  return request("POST", `/v1/checks/${encodeURIComponent(checkId)}/complete`);
}

/**
 * POST /v1/assessments:evaluate — store an assessment/report, evaluate
 * conditions, and create any immediately resolvable guidance tasks.
 * @param {any} assessment
 * @returns {Promise<{ assessment: any, conditions: any[], tasks: any[] }>}
 */
export function evaluateAssessment(assessment) {
  return request("POST", "/v1/assessments:evaluate", {
    body: { ...assessment },
  });
}

/**
 * GET /v1/assessments/{assessmentId}/guidance — fetch the stored assessment,
 * conditions, and any created guidance tasks.
 * @param {string} assessmentId
 * @returns {Promise<{ assessment: any, conditions: any[], tasks: any[] }>}
 */
export function getAssessmentGuidance(assessmentId) {
  return request(
    "GET",
    `/v1/assessments/${encodeURIComponent(assessmentId)}/guidance`,
  );
}

/**
 * POST /v1/assessments/{assessmentId}/conditions/{conditionId}/answers.
 * @param {string} assessmentId
 * @param {string} conditionId
 * @param {{ answers: Record<string, unknown> }} body
 * @returns {Promise<{ assessmentItem?: any, conditionItem: any, taskItem: any, evaluation: any }>}
 */
export function submitConditionAnswers(assessmentId, conditionId, body) {
  return request(
    "POST",
    `/v1/assessments/${encodeURIComponent(assessmentId)}/conditions/${encodeURIComponent(conditionId)}/answers`,
    { body },
  );
}

/**
 * POST /v1/checks/{checkId}/artifacts/{artifactId}/conditions/{conditionId}
 *
 * Addressed by the artifact's own coordinates (the client holds checkId +
 * artifactId on every evidence item); the backend reads the analyzer's
 * analysisId off the stored ANALYSIS# item, so the client never supplies it.
 * @param {string} checkId
 * @param {string} artifactId
 * @param {string} conditionId
 * @param {{ description: string, language?: string, caller?: { request_id?: string } }} body
 * @returns {Promise<{ analysis_id: string, condition: any, assessment: any }>}
 */
export function editAnalysisCondition(checkId, artifactId, conditionId, body) {
  return request(
    "POST",
    `/v1/checks/${encodeURIComponent(checkId)}/artifacts/${encodeURIComponent(artifactId)}/conditions/${encodeURIComponent(conditionId)}`,
    { body },
  );
}

/**
 * POST /v1/checks/{checkId}/artifacts/{artifactId}/conditions/{conditionId}/reject
 * @param {string} checkId
 * @param {string} artifactId
 * @param {string} conditionId
 * @param {{ reason?: { key: "not_a_problem" | "other", note?: string }, taskId?: string, caller?: { request_id?: string } }} [body]
 * @returns {Promise<{ analysis_id: string, rejected_condition_id: string, rejection: any, assessment: any }>}
 */
export function rejectAnalysisCondition(
  checkId,
  artifactId,
  conditionId,
  body = {},
) {
  return request(
    "POST",
    `/v1/checks/${encodeURIComponent(checkId)}/artifacts/${encodeURIComponent(artifactId)}/conditions/${encodeURIComponent(conditionId)}/reject`,
    { body },
  );
}

/**
 * GET /v1/checks — the site's checks, newest `startedAt` first (GSI1), with
 * opaque cursor paging.
 * @param {{ limit?: number, nextToken?: string }} [opts]
 * @returns {Promise<{ checks: any[], nextToken?: string }>}
 */
export function listChecks({ limit, nextToken } = {}) {
  return request("GET", `/v1/checks${qs({ limit, nextToken })}`);
}

/**
 * @param {{startedAt: string, checkId: string, signal?: AbortSignal, siteId?: string}} opts
 * @returns {Promise<{counts: number[]}>}
 */
export function getCaptureGuidance({ startedAt, checkId, signal, siteId }) {
  return request(
    "GET",
    `/v1/checks:capture-guidance${qs({ startedAt, checkId })}`,
    { signal, originSiteId: siteId },
  );
}

/**
 * GET /v1/checks/{checkId} — one check with its artifacts + analyses, in a single
 * base-table query. 404 → ApiError(status 404).
 * @param {string} checkId
 * @param {{signal?: AbortSignal, originSiteId?: string}} [options]
 * @returns {Promise<{ check: any, artifacts: any[], analyses: any[] }>}
 */
export function getCheck(checkId, options = {}) {
  return request("GET", `/v1/checks/${encodeURIComponent(checkId)}`, options);
}

// ── Public complaints ──────────────────────────────────────────────────────

export function listComplaints() {
  return request("GET", "/v1/complaints");
}

export function getComplaint(complaintId) {
  return request("GET", `/v1/complaints/${encodeURIComponent(complaintId)}`);
}

export function createComplaint(body) {
  return request("POST", "/v1/complaints", {
    body,
    headers: { "idempotency-key": body.complaintId },
  });
}

export function retryComplaint(complaintId) {
  return request(
    "POST",
    `/v1/complaints/${encodeURIComponent(complaintId)}/analysis:retry`,
    { body: {} },
  );
}

export function deleteComplaint(complaintId) {
  return request("DELETE", `/v1/complaints/${encodeURIComponent(complaintId)}`);
}

export function presignComplaintArtifact(complaintId, body, signal) {
  return request(
    "POST",
    `/v1/complaints/${encodeURIComponent(complaintId)}/artifacts:presign`,
    { body, signal },
  );
}

export function registerComplaintArtifact(complaintId, body, signal) {
  return request(
    "POST",
    `/v1/complaints/${encodeURIComponent(complaintId)}/artifacts`,
    { body, signal },
  );
}

export function deleteComplaintArtifact(complaintId, artifactId) {
  return request(
    "DELETE",
    `/v1/complaints/${encodeURIComponent(complaintId)}/artifacts/${encodeURIComponent(artifactId)}`,
  );
}

export function getComplaintMediaUrl(complaintId, artifactId) {
  return request(
    "GET",
    `/v1/complaints/${encodeURIComponent(complaintId)}/artifacts/${encodeURIComponent(artifactId)}/media`,
  );
}

// ── Dev-only: presigned uploads via the Vite dev server ─────────────────────
//
// In "frontend-only mode" (npm run dev:remote — the dev server proxies the API
// to a deployed origin) the backend presigns REAL S3 URLs. A direct browser PUT
// from http://127.0.0.1:5173 is cross-origin and the bucket's CORS lists only
// the deployed origins, so instead the URL is rewritten onto this origin at
// `/__s3/<bucket-host>/<key>?<presigned query>` and the dev server forwards it
// to S3 with the Host restored (scripts/vite-remote-api.mjs). The signature
// still validates — it covers host, path, query, and content-type, all of which
// arrive unchanged — and S3 still authorizes on that signature alone.
//
// `__S3_UPLOAD_PROXY__` is a Vite `define` that is `true` only for a dev server
// started with an https API_PROXY_TARGET and `false` in every build, so in
// production this is a no-op and the URL goes straight to S3 as before.

/** Same prefix the dev-server middleware listens on. */
const S3_UPLOAD_PROXY_PREFIX = "/__s3/";
/** Virtual-hosted S3 hostnames only (`bucket.s3.<region>.amazonaws.com`). */
const S3_HOST_RE =
  /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]\.s3\.[a-z0-9-]+\.amazonaws\.com$/;

/** @returns {boolean} the build-time define, guarded for non-Vite contexts (tests) */
function s3UploadProxyEnabled() {
  try {
    // @ts-expect-error -- build-time define (vite.config.js `define`); not a
    // runtime global, so it has no ambient declaration.
    return typeof __S3_UPLOAD_PROXY__ === "boolean" && __S3_UPLOAD_PROXY__;
  } catch {
    return false;
  }
}

/**
 * Rewrite an absolute presigned S3 URL onto the dev server's `/__s3/` route when
 * the upload proxy is enabled; otherwise (production, local harness, non-S3
 * host, unparseable URL) return the URL unchanged.
 * @param {string} url
 * @param {boolean} [enabled]  defaults to the build-time define; tests pass it explicitly
 * @returns {string}
 */
export function toDevUploadUrl(url, enabled = s3UploadProxyEnabled()) {
  if (!enabled) return url;
  /** @type {URL} */
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (parsed.protocol !== "https:" || !S3_HOST_RE.test(parsed.hostname)) {
    return url;
  }
  return `${S3_UPLOAD_PROXY_PREFIX}${parsed.hostname}${parsed.pathname}${parsed.search}`;
}

/** @param {string} uploadUrl @param {Blob} file @param {Record<string,string>} uploadHeaders @param {(progress:number) => void} onProgress @param {AbortSignal} [signal] */
export function putMediaWithProgress(
  uploadUrl,
  file,
  uploadHeaders = {},
  onProgress = () => {},
  signal,
) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Upload cancelled", "AbortError"));
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", toDevUploadUrl(uploadUrl));
    Object.entries(uploadHeaders).forEach(([name, value]) =>
      xhr.setRequestHeader(name, value),
    );
    // No bytes moving for UPLOAD_STALL_MS counts as a lost connection.
    let stalled = false;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let stallTimer;
    const watchStall = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        stalled = true;
        xhr.abort();
      }, UPLOAD_STALL_MS);
    };
    xhr.upload.addEventListener("progress", (event) => {
      watchStall();
      if (event.lengthComputable)
        onProgress(Math.round((event.loaded / event.total) * 100));
    });
    xhr.addEventListener("loadend", () => clearTimeout(stallTimer));
    xhr.addEventListener("load", () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(
            new ApiError(`Media upload → ${xhr.status}`, {
              status: xhr.status,
            }),
          ),
    );
    xhr.addEventListener("error", () =>
      reject(new ApiError("Network error uploading media", { status: 0 })),
    );
    xhr.addEventListener("abort", () =>
      reject(
        stalled
          ? new ApiError("Media upload stalled", { status: 0 })
          : new DOMException("Upload cancelled", "AbortError"),
      ),
    );
    watchStall();
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}

// ── Artifacts (photo upload leg) ────────────────────────────────────────────

/**
 * POST /v1/checks/{checkId}/artifacts:presign — mint an artifactId + S3 key and
 * a presigned PUT URL. content-type is pinned into the signature.
 * @param {string} checkId
 * @param {{ contentType: string, contentLength: number, uploadRequestId?: string }} body
 * @returns {Promise<{ artifactId: string, s3Key: string, contentType: string, contentLength: number, uploadHeaders: Record<string, string>, uploadUrl: string, expiresIn: number }>}
 */
export function presignArtifact(checkId, body, { signal = undefined } = {}) {
  return request(
    "POST",
    `/v1/checks/${encodeURIComponent(checkId)}/artifacts:presign`,
    { body, signal },
  );
}

/**
 * POST /v1/checks/{checkId}/artifacts — record an uploaded artifact and enqueue
 * its analysis. 409 (this artifactId already registered) → ApiError.
 * Stamps the active UI locale so the analyzer writes translated
 * labels/descriptions the device can show.
 * @param {string} checkId
 * @param {{ artifactId: string, s3Key?: string, contentType?: string, contentLength?: number, capturedAt?: string, latitude?: number, longitude?: number, accuracyMeters?: number, text?: string, language?: string }} body
 * @returns {Promise<{ artifactId: string, status: string }>}
 */
export function registerArtifact(checkId, body) {
  return request(
    "POST",
    `/v1/checks/${encodeURIComponent(checkId)}/artifacts`,
    {
      body: { language: getLocale(), ...body },
    },
  );
}

/**
 * PATCH /v1/checks/{checkId}/artifacts/{artifactId}/location
 * @param {string} checkId
 * @param {string} artifactId
 * @param {{ latitude: number, longitude: number, accuracyMeters?: number }} location
 * @returns {Promise<{ artifactId: string, artifactUpdated: boolean, tasksUpdated: number }>}
 */
export function updateArtifactLocation(checkId, artifactId, location) {
  return request(
    "PATCH",
    `/v1/checks/${encodeURIComponent(checkId)}/artifacts/${encodeURIComponent(artifactId)}/location`,
    {
      body: {
        latitude: location.latitude,
        longitude: location.longitude,
        ...(Number.isFinite(location.accuracyMeters)
          ? { accuracyMeters: location.accuracyMeters }
          : {}),
      },
    },
  );
}

/**
 * DELETE /v1/checks/{checkId}/artifacts/{artifactId} — remove a registered
 * artifact from its check (an edited/deleted description replaces or drops an
 * already-registered text artifact; leaving it would let the final scorecard
 * fold the stale text). Idempotent on replay; 404 = already gone.
 * @param {string} checkId
 * @param {string} artifactId
 * @returns {Promise<{ artifactId: string, status: string }>}
 */
export function deleteArtifact(checkId, artifactId) {
  return request(
    "DELETE",
    `/v1/checks/${encodeURIComponent(checkId)}/artifacts/${encodeURIComponent(artifactId)}`,
  );
}

/**
 * Raw presigned PUT of the media bytes straight to S3. NOT joined onto BASE and
 * carries no auth — the signature is the authorization, and the content-type must
 * match what was presigned. Throws `ApiError` on a non-2xx. (Dev-only exception:
 * `toDevUploadUrl` may route it via the dev server — see above.)
 * @param {string} uploadUrl  absolute presigned URL from `presignArtifact`
 * @param {Blob} blob
 * @param {string} contentType
 * @param {Record<string, string>} [uploadHeaders]
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
export async function putMedia(
  uploadUrl,
  blob,
  contentType,
  uploadHeaders = {},
  signal = undefined,
) {
  // fetch reports no upload progress, so allow time for the size instead.
  const limitMs =
    UPLOAD_STALL_MS + (blob.size / UPLOAD_MIN_BYTES_PER_SECOND) * 1000;
  const timeout = withTimeout(signal, limitMs);
  /** @type {Response} */
  let res;
  try {
    res = await fetch(toDevUploadUrl(uploadUrl), {
      method: "PUT",
      headers: { "content-type": contentType, ...uploadHeaders },
      body: blob,
      signal: timeout.signal,
    });
  } catch (err) {
    throw new ApiError(
      timeout.timedOut()
        ? `Media upload timed out after ${Math.round(limitMs)}ms`
        : `Network error uploading media: ${err}`,
      { status: 0 },
    );
  } finally {
    timeout.clear();
  }
  if (!res.ok) {
    throw new ApiError(`Media upload → ${res.status} ${res.statusText}`, {
      status: res.status,
    });
  }
}

/**
 * GET /v1/checks/{checkId}/artifacts/{artifactId}/media — short-lived presigned
 * GETs for one photo: `downloadUrl` is the original (lightbox); `thumbnailUrl`,
 * when present, is the worker's small WebP card variant.
 * @param {string} checkId
 * @param {string} artifactId
 * @param {{signal?: AbortSignal}} [options]
 * @returns {Promise<{ artifactId: string, s3Key: string, downloadUrl: string, thumbnailUrl?: string, expiresIn: number }>}
 */
export function getMediaUrl(checkId, artifactId, { signal } = {}) {
  return request(
    "GET",
    `/v1/checks/${encodeURIComponent(checkId)}/artifacts/${encodeURIComponent(artifactId)}/media`,
    { signal },
  );
}

// ── Site manager reports (AP27, AP28; manager access level only) ─────────────

/**
 * @typedef {{ kind: "week" | "month" | "quarter", start: string, endExclusive: string }} ReportPeriod
 * @typedef {{ period?: "week" | "month" | "quarter", start?: string }} ReportQuery
 *   `start` is any Pacific day key (YYYY-MM-DD) inside the wanted period.
 */

/**
 * GET /app/v1/manager/reports/checks — per-day check compliance for one period.
 * @param {ReportQuery} [query]
 * @returns {Promise<{ period: ReportPeriod, today: string, requirement: any, days: any[], totals: any, previous: ReportPeriod & { totals: any } }>}
 */
export function getChecksReport({ period, start } = {}) {
  return request(
    "GET",
    `/app/v1/manager/reports/checks${qs({ period, start })}`,
  );
}

/**
 * GET /app/v1/manager/reports/tasks — every task created in the period.
 * @param {ReportQuery} [query]
 * @returns {Promise<{ period: ReportPeriod, today: string, asOf: string, tasks: any[], previous: ReportPeriod & { count: number, byType: Record<string, number> } }>}
 */
export function getTasksReport({ period, start } = {}) {
  return request(
    "GET",
    `/app/v1/manager/reports/tasks${qs({ period, start })}`,
  );
}

/**
 * GET /app/v1/manager/reports/task-updates — every task update event in the period.
 * @param {ReportQuery} [query]
 * @returns {Promise<{ period: ReportPeriod, today: string, updates: any[], previous: ReportPeriod & { count: number } }>}
 */
export function getTaskUpdatesReport({ period, start } = {}) {
  return request(
    "GET",
    `/app/v1/manager/reports/task-updates${qs({ period, start })}`,
  );
}

// ── Tasks (staff worklist, AP10) ─────────────────────────────────────────────

/**
 * GET /v1/tasks — the site's action items at one status, most-severe first (GSI2).
 * @param {{ status?: string, limit?: number }} [opts]
 * @returns {Promise<{ tasks: any[] }>}
 */
export function listTasks({ status, limit } = {}) {
  return request("GET", `/v1/tasks${qs({ status, limit })}`);
}

/** @param {string} taskId @param {string} [nextToken] @param {{signal?: AbortSignal}} [options] */
export function getTaskUpdates(taskId, nextToken, { signal } = {}) {
  return request(
    "GET",
    `/v1/tasks/${encodeURIComponent(taskId)}/updates${qs({ nextToken })}`,
    { signal },
  );
}

export function createTaskUpdate(
  taskId,
  body,
  requestId = crypto.randomUUID(),
  { signal = AbortSignal.timeout(30_000) } = {},
) {
  return request("POST", `/v1/tasks/${encodeURIComponent(taskId)}/updates`, {
    body,
    headers: { "idempotency-key": requestId },
    signal,
  });
}

export function documentTaskUpdate(
  taskId,
  updateId,
  body = {},
  { signal = AbortSignal.timeout(30_000) } = {},
) {
  return request(
    "POST",
    `/v1/tasks/${encodeURIComponent(taskId)}/updates/${encodeURIComponent(updateId)}/document`,
    { body, signal },
  );
}

export function registerTaskUpdateMedia(
  taskId,
  body,
  { signal = AbortSignal.timeout(30_000) } = {},
) {
  return request(
    "POST",
    `/v1/tasks/${encodeURIComponent(taskId)}/update-media`,
    { body, signal },
  );
}

export function get311RequestDetail(taskId, srNum) {
  return request(
    "GET",
    `/v1/tasks/${encodeURIComponent(taskId)}/311-requests/${encodeURIComponent(srNum)}`,
  );
}

/** The backend rejects a `311-requests:batch` body with more than this many items. */
export const MAX_311_BATCH_SIZE = 50;

/**
 * POST /v1/311-requests:batch — live SF311 status for filed tickets. The
 * backend caps a batch at 50, and the home hub can hold far more filed
 * tickets than that, so the pairs are split into capped batches sent in
 * parallel and merged. A batch that fails is dropped so the others still
 * hydrate their cards; the call rejects only when every batch failed.
 * @param {Array<{ taskId: string, srNum: string }>} requests
 * @param {{signal?: AbortSignal}} [options]
 * @returns {Promise<{ requests: Array<{ taskId: string, request: Record<string, any> }> }>}
 */
export async function get311RequestDetails(requests, { signal } = {}) {
  const batches = [];
  for (let i = 0; i < requests.length; i += MAX_311_BATCH_SIZE) {
    batches.push(requests.slice(i, i + MAX_311_BATCH_SIZE));
  }
  const settled = await Promise.allSettled(
    batches.map((batch) =>
      request("POST", "/v1/311-requests:batch", {
        body: { requests: batch },
        signal,
      }),
    ),
  );
  const fulfilled = settled.filter((r) => r.status === "fulfilled");
  if (batches.length && !fulfilled.length) {
    throw /** @type {PromiseRejectedResult} */ (settled[0]).reason;
  }
  return {
    requests: fulfilled.flatMap((r) => r.value?.requests || []),
  };
}

/**
 * POST /v1/tasks/{taskId}/complete — mark a guidance task complete and record
 * any backend app-action results for audit.
 * @param {string} taskId
 * @param {{ completionMethod?: string }} [body]
 * @param {{originSiteId?: string, signal?: AbortSignal}} [options]
 * @returns {Promise<{ task: any, resultsPending?: boolean }>}
 */
export async function completeTask(taskId, body = {}, options = {}) {
  const originSiteId = options.originSiteId || (await getSite())?.siteId || "";
  const bound = { ...options, originSiteId };
  const submit = () =>
    request("POST", `/v1/tasks/${encodeURIComponent(taskId)}/complete`, {
      ...bound,
      body,
    });
  try {
    return await submit();
  } catch (error) {
    // Only reconcile uncertain manual saves. Validation/auth failures and City
    // submissions retain their existing error behavior; never blindly replay.
    if (
      body.completionMethod !== "manual" ||
      !(error instanceof ApiError) ||
      !(error.status === 0 || error.status === 409 || error.status >= 500)
    )
      throw error;
    for (const delay of [0, 250, 750]) {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      let detail;
      try {
        detail = await request(
          "GET",
          `/v1/tasks/${encodeURIComponent(taskId)}/updates`,
          bound,
        );
      } catch {
        throw error;
      }
      const task = detail?.task;
      if (
        task?.completionMethod === "manual" &&
        (task.status === "completed" ||
          (task.status === "in_progress" &&
            task.kind === "non_actionable_escalation"))
      ) {
        // The backend's same-method replay returns authoritative documentation
        // eligibility for this actor, rather than guessing from a timeline.
        return submit();
      }
      if (task?.status !== "completing") break;
    }
    throw error;
  }
}

// ── Composed helpers ─────────────────────────────────────────────────────────

/** The MIME types the backend will presign. */
const UPLOADABLE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

/**
 * Parse the MIME type out of a `data:` URL (`data:image/jpeg;base64,...`).
 * Falls back to image/jpeg — the capture pipeline only produces JPEGs.
 * @param {string} dataUrl
 * @returns {string}
 */
export function contentTypeFromDataUrl(dataUrl) {
  const m = /^data:([^;,]+)[;,]/.exec(dataUrl || "");
  const type = m ? m[1] : "image/jpeg";
  return UPLOADABLE_TYPES.has(type) ? type : "image/jpeg";
}

/**
 * Turn a `data:` URL back into a Blob for the presigned PUT. The whole app stores
 * photos inline as JPEG data-URLs (`item.dataUrl`); this reconstitutes the bytes.
 *
 * Decoded in-process rather than via `fetch(dataUrl)`: browsers subject `data:`
 * fetches to the `connect-src` CSP directive, which is deliberately locked to the
 * uploads bucket, so a fetch would be blocked. `atob` has no such restriction.
 * @param {string} dataUrl
 * @returns {Promise<Blob>}
 */
export async function dataUrlToBlob(dataUrl) {
  const comma = dataUrl.indexOf(",");
  if (comma === -1) throw new ApiError("Malformed data URL", { status: 0 });
  const header = dataUrl.slice(0, comma);
  const data = dataUrl.slice(comma + 1);
  const contentType = /^data:([^;,]+)/.exec(header)?.[1] || "image/jpeg";

  if (!/;base64/i.test(header)) {
    // Non-base64 (URL-encoded) data URL — decode as UTF-8 text.
    return new Blob([decodeURIComponent(data)], { type: contentType });
  }

  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: contentType });
}

/**
 * Upload one captured photo end-to-end: presign → PUT bytes to S3 → register
 * (which enqueues the async analysis). Returns the registered artifactId, the
 * pinned S3 key, and validated media metadata so callers can persist enough state to re-drive the analysis
 * later (a retry re-registers the SAME artifact rather than re-uploading).
 * @param {string} checkId
 * @param {{ dataUrl: string, capturedAt?: string, location?: () => ({ latitude: number, longitude: number, accuracyMeters?: number } | null), text?: string, tag?: string, onLeg?: (leg: "presign" | "put" | "register") => void }} item
 *   `location` is read just before register, so a reading that lands during
 *   the upload still goes with the photo.
 *   `tag` is a caller-supplied label used only for perf traces (e.g. the item id).
 *   `onLeg` fires after each upload leg completes (see `LEG` below) so callers can
 *   show live progress and, on failure, know which leg broke.
 * @returns {Promise<{ artifactId: string, s3Key: string, contentType: string, contentLength: number }>}
 */
export async function uploadArtifact(
  checkId,
  { dataUrl, capturedAt, location, text, tag, onLeg },
) {
  const art = tag ?? "photo";
  const telemetry = { check_id: checkId, attempt_id: photoAttemptId() };
  const done = span("upload", { art });

  const contentType = contentTypeFromDataUrl(dataUrl);
  const blob = await dataUrlToBlob(dataUrl);
  telemetry.photo_bytes = blob.size;
  const endPresign = span("upload.presign", { art });
  const { artifactId, s3Key, uploadUrl, uploadHeaders } =
    await observePhotoStage("presign", telemetry, () =>
      reserveMediaUpload(
        `check:${checkId}:${tag ?? "photo"}`,
        blob,
        (uploadRequestId) =>
          presignArtifact(checkId, {
            contentType,
            contentLength: blob.size,
            uploadRequestId,
          }),
      ),
    );
  telemetry.artifact_id = artifactId;
  endPresign({ artifactId });
  onLeg?.("presign");

  const endPut = span("upload.put", { art, bytes: blob.size });
  await observePhotoStage("put", telemetry, async () => {
    try {
      await putMedia(uploadUrl, blob, contentType, uploadHeaders);
    } catch (error) {
      if (error?.status !== 412) throw error;
      // A lost successful PUT is verified by registration below.
    }
  });
  endPut();
  onLeg?.("put");

  const endRegister = span("upload.register", { art, artifactId });
  const { latitude, longitude, accuracyMeters } = location?.() ?? {};
  await observePhotoStage("register", telemetry, async () => {
    try {
      await registerArtifact(checkId, {
        artifactId,
        s3Key,
        contentType,
        contentLength: blob.size,
        ...(capturedAt ? { capturedAt } : {}),
        ...(Number.isFinite(latitude) && Number.isFinite(longitude)
          ? {
              latitude,
              longitude,
              ...(Number.isFinite(accuracyMeters) ? { accuracyMeters } : {}),
            }
          : {}),
        ...(text ? { text } : {}),
      });
    } catch (error) {
      if (
        error?.status !== 409 ||
        error?.body?.error !== "artifact already registered"
      )
        throw error;
      // This exact replay response confirms registration and re-enqueues analysis.
    }
  });
  endRegister();
  onLeg?.("register");

  done({ artifactId });
  return { artifactId, s3Key, contentType, contentLength: blob.size };
}

// Task-update attachment identity is local to each selected File object.
/** @type {WeakMap<File, string>} */
const taskUploadAttachmentIds = new WeakMap();

/**
 * Upload documentation for a task update without registering it for analysis.
 * @param {string} taskId
 * @param {string} checkId
 * @param {{ file: File, capturedAt?: string }} item
 * @param {{ signal?: AbortSignal, onProgress?: (progress: number) => void }} [options]
 */
export async function uploadTaskUpdatePhoto(
  taskId,
  checkId,
  item,
  { signal = AbortSignal.timeout(120_000), onProgress } = {},
) {
  const blob = item.file;
  let attachmentId = taskUploadAttachmentIds.get(blob);
  if (!attachmentId) {
    attachmentId = crypto.randomUUID();
    taskUploadAttachmentIds.set(blob, attachmentId);
  }
  const contentType = contentTypeFor(blob);
  const { artifactId, s3Key, uploadUrl, uploadHeaders } =
    await reserveMediaUpload(
      `task:${taskId}:check:${checkId}:attachment:${attachmentId}`,
      blob,
      (uploadRequestId) =>
        presignArtifact(
          checkId,
          {
            contentType,
            contentLength: blob.size,
            uploadRequestId,
          },
          { signal },
        ),
      { contentType },
    );
  try {
    if (onProgress)
      await putMediaWithProgress(
        uploadUrl,
        blob,
        { "content-type": contentType, ...uploadHeaders },
        onProgress,
        signal,
      );
    else await putMedia(uploadUrl, blob, contentType, uploadHeaders, signal);
  } catch (error) {
    if (error?.status !== 412) throw error;
  }
  await registerTaskUpdateMedia(
    taskId,
    {
      checkId,
      artifactId,
      s3Key,
      contentType,
      contentLength: blob.size,
      ...(item.capturedAt ? { capturedAt: item.capturedAt } : {}),
    },
    { signal },
  );
  return { artifactId, s3Key };
}

/**
 * Register validated text evidence without uploading media bytes.
 * @param {string} checkId
 * @param {{ text: string, capturedAt?: string, latitude?: number, longitude?: number, accuracyMeters?: number }} item
 * @returns {Promise<string>}
 */
export async function registerTextArtifact(
  checkId,
  { text, capturedAt, latitude, longitude, accuracyMeters },
) {
  const artifactId = crypto.randomUUID();
  await registerArtifact(checkId, {
    artifactId,
    ...(capturedAt ? { capturedAt } : {}),
    ...(Number.isFinite(latitude) && Number.isFinite(longitude)
      ? {
          latitude,
          longitude,
          ...(Number.isFinite(accuracyMeters) ? { accuracyMeters } : {}),
        }
      : {}),
    text,
  });
  return artifactId;
}

/**
 * Which leg of `uploadArtifact` a progress callback or failure refers to:
 *   presign — minted artifactId + presigned S3 PUT URL (network to the API)
 *   put     — media bytes PUT to S3 (the big, bandwidth-bound leg)
 *   register — artifact recorded + analysis enqueued (the analyzer is now working)
 * @typedef {"presign" | "put" | "register"} UploadLeg
 */
export const LEG = { PRESIGN: "presign", PUT: "put", REGISTER: "register" };

/**
 * Short poll (scoped to the submit flow, not a sync engine) that waits for the
 * async analyses to land after registering artifacts. Resolves as soon as every
 * registered artifact has a matching ANALYSIS# item — counting failed markers, so
 * a failed analysis doesn't hang the poll.
 *
 * On the deadline it THROWS `ApiError` (code `analyses_pending`) rather than
 * returning a partial set: completing on partial coverage would fold only the
 * analyses that landed in time (usually just the first photo) and the backend
 * freezes that scorecard idempotently, so a silent partial here corrupts the
 * saved check. The backend `complete` gate rejects a premature fold too — this is
 * the client-side half so the user sees a retryable error, not a wrong result.
 *
 * The default ceiling is deliberately generous: each photo is analyzed
 * independently by the worker (downscale → remote LLM), roughly serially, so a
 * multi-photo run legitimately needs minutes. The ceiling exists only to bound a
 * genuinely stuck analyzer, not to race normal completion.
 * @param {string} checkId
 * When `expected` is omitted, the first read is a best-effort fallback for older
 * pending sessions that do not have a persisted upload count.
 * @param {{ expected?: number, timeoutMs?: number, intervalMs?: number }} opts
 * @returns {Promise<{ check: any, artifacts: any[], analyses: any[] }>}
 */
export async function waitForAnalyses(
  checkId,
  { expected, timeoutMs = 180000, intervalMs = 2000 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  mark("wait:start", {
    expected: expected ?? "auto",
    timeoutMs,
    intervalMs,
  });
  /** first-seen offset per artifactId, so we can see the landing cadence */
  const seen = new Set();
  let poll = 0;
  let wanted = expected;
  return pollCheck(
    checkId,
    getCheck,
    (last) => {
      wanted ??= last.artifacts.length;
      poll += 1;
      const analyzedIds = new Set(last.analyses.map((a) => a.artifactId));
      // Log any analyses that landed since the previous poll — this is the
      // response-cadence signal: do they arrive together or one at a time?
      const fresh = [...analyzedIds].filter((id) => !seen.has(id));
      for (const id of fresh) seen.add(id);
      mark(`wait:poll#${poll}`, {
        analyzed: `${analyzedIds.size}/${wanted}`,
        artifacts: last.artifacts.length,
        landed: fresh.length ? fresh.join(",") : "-",
      });
      const covered =
        last.artifacts.length >= wanted &&
        last.artifacts.every((a) => analyzedIds.has(a.artifactId));
      if (wanted === 0 || covered) {
        mark("wait:done", { analyzed: `${analyzedIds.size}/${wanted}`, poll });
        return last;
      }
      if (Date.now() >= deadline) {
        throw new ApiError(
          `Analyses still processing (${analyzedIds.size}/${wanted}) after ${timeoutMs}ms`,
          {
            body: {
              code: "analyses_pending",
              expected: wanted,
              analyzed: analyzedIds.size,
            },
          },
        );
      }
      return undefined;
    },
    { intervalMs },
  );
}

/**
 * @param {string[]} taskIds
 * @param {{originSiteId?: string, signal?: AbortSignal}} [options]
 */
export function getDuplicateLinks(taskIds, options = {}) {
  return request("POST", "/v1/duplicates:batch", {
    ...options,
    body: { taskIds },
  });
}
/** @param {string} taskId @param {{sourceRevision:string,originalTaskId:string}} expected */
export async function separateDuplicate(taskId, expected) {
  const result = await request(
    "POST",
    `/v1/tasks/${encodeURIComponent(taskId)}/duplicate:separate`,
    { body: expected },
  );
  clearTaskStatusOverrides(
    taskId,
    result.task?.taskId || result.taskId || taskId,
  );
  invalidateDuplicateIssues();
  return result;
}

/**
 * @param {string} taskId
 * @param {{ signal?: AbortSignal }} [options]
 */
export function getTaskDetails(taskId, { signal } = {}) {
  return request("GET", `/v1/tasks/${encodeURIComponent(taskId)}/details`, {
    signal,
  });
}

/** @param {string} taskId @param {string} ruleId */
export function updateTaskAction(taskId, ruleId) {
  return request("PATCH", `/v1/tasks/${encodeURIComponent(taskId)}/action`, {
    body: { ruleId },
  });
}

/** @param {string} taskId @param {{text:string,resolved:boolean}} body */
export function recordCustomTaskAction(taskId, body) {
  return request(
    "POST",
    `/v1/tasks/${encodeURIComponent(taskId)}/custom-action`,
    { body },
  );
}

// Proactive care logs are Site-scoped, independent of checks and tasks.
export function listCareWork(nextToken = "") {
  return request(
    "GET",
    `/v1/care-work${qs({ nextToken: nextToken || undefined })}`,
  );
}
export function getCareWork(workId) {
  return request("GET", `/v1/care-work/${encodeURIComponent(workId)}`);
}
export function createCareWork(body, options = {}) {
  return request("POST", "/v1/care-work", {
    ...options,
    body,
    headers: { "idempotency-key": body.workId },
  });
}
export function presignCarePhoto(workId, body, options = {}) {
  return request(
    "POST",
    `/v1/care-work/${encodeURIComponent(workId)}/photos:presign`,
    { ...options, body },
  );
}
export function getCarePhoto(workId, photoId) {
  return request(
    "GET",
    `/v1/care-work/${encodeURIComponent(workId)}/photos/${encodeURIComponent(photoId)}/media`,
  );
}

/** General help only. Never include site records or conversation history.
 * @param {{question:string, locale:string, signal?:AbortSignal}} input
 */
export function askSupport({ question, locale, signal }) {
  return request("POST", "/v1/support", { body: { question, locale }, signal });
}

/** @param {string | null} [nextToken] */
export function listPendingGuidance(nextToken = null) {
  const query = nextToken ? `?nextToken=${encodeURIComponent(nextToken)}` : "";
  return request("GET", `/v1/guidance/pending${query}`);
}
