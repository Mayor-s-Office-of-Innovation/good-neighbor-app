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

import { mark, span } from "./instrument.js";
import { getSite, updateSiteSession } from "../db.js";
import { refreshDeviceToken } from "./devices.js";
import { ApiError, ReauthRequiredError } from "./api-error.js";

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
  rides `Authorization: Bearer <token>` from the stored site record. On a 401 —
  or pre-emptively when the access token is near expiry — the session is
  refreshed silently with the single-use rotating refresh token (never the site
  code; the code-holder may not be around). One in-flight refresh is shared by
  concurrent requests; failures surface as `ReauthRequiredError`.
*/

/** Module-level in-flight refresh, shared by concurrent requests. */
let refreshInFlight;

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
 * @returns {Promise<{ token: string }>}
 */
async function refreshSession() {
  refreshInFlight ??= (async () => {
    // Re-read inside the shared promise — never trust the caller's snapshot.
    const site = await getSite().catch(() => null);
    const refreshToken = site?.refreshToken;
    if (!refreshToken) throw new ReauthRequiredError();
    try {
      const session = await refreshDeviceToken(refreshToken);
      await updateSiteSession(session);
      mark("auth:refreshed", { generation: session.tokenGeneration });
      return { token: session.token };
    } catch (err) {
      // A 401 from the refresh endpoint is fatal: the stored session cannot
      // renew. 5xx/transport stays retryable — the session may be fine.
      if (is401(err)) throw new ReauthRequiredError();
      throw err;
    } finally {
      // Clear in the finally so a rejected refresh can't leave a poisoned
      // shared promise for later requests to re-await.
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

/**
 * @param {unknown} err
 * @returns {boolean} true for a 401 ApiError (transport failures are 0)
 */
function is401(err) {
  return err instanceof ApiError && err.status === 401;
}

/**
 * One JSON request against the backend. Serializes an object body, parses a
 * JSON response, and throws `ApiError` on a non-2xx status or a transport
 * failure. Attaches the device token when a session exists and retries once
 * through a silent refresh on a 401.
 * @param {string} method
 * @param {string} path        path beginning with `/` (joined onto BASE)
 * @param {object} [opts]
 * @param {Record<string,string>} [opts.headers]
 * @param {unknown} [opts.body]  JSON-serializable body (omitted for GET)
 * @param {AbortSignal} [opts.signal]
 * @param {boolean} [opts.allowAuthRetry] internal: set false on the retry leg
 *   to stop a 401 loop
 * @returns {Promise<any>} the parsed JSON body (null for an empty 2xx)
 */
async function request(
  method,
  path,
  { headers = {}, body, signal, allowAuthRetry = true } = {},
) {
  const hasBody = body !== undefined;
  const site = await getSite().catch(() => null);
  const authHeaders = site?.token
    ? { authorization: `Bearer ${site.token}` }
    : {};

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
    // fetch only rejects on a transport failure (offline, DNS, CORS, abort).
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
      parsed = text; // non-JSON body (shouldn't happen against our API)
    }
  }

  if (!res.ok) {
    // Expired/revoked access token → ONE silent refresh, then retry. A second
    // 401 (or a rejected refresh) is fatal: ReauthRequiredError.
    if (res.status === 401 && allowAuthRetry) {
      // Refresh from the CURRENT stored session — `site` here may be stale
      // (read before this request's fetch); refreshSession re-reads it.
      try {
        await refreshSession();
      } catch (err) {
        if (err instanceof ReauthRequiredError) throw err;
        // Retryable refresh failure (5xx/transport): surface as-is — the
        // stored session may be perfectly valid.
        throw err;
      }
      // The refreshed session is already persisted; retry with it. A second
      // 401 on this leg means the fresh token was rejected too — fatal.
      try {
        return await request(method, path, {
          headers,
          body,
          signal,
          allowAuthRetry: false,
        });
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          throw new ReauthRequiredError();
        }
        throw err;
      }
    }
    const detail =
      parsed && typeof parsed === "object" && "error" in parsed
        ? parsed.error
        : res.statusText;
    throw new ApiError(`${method} ${path} → ${res.status} ${detail}`, {
      status: res.status,
      body: parsed,
    });
  }
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
 * GET /v1/site — the bound site's settings, including ordered places.
 * @returns {Promise<{ site: any }>}
 */
export function getSiteSettings() {
  return request("GET", "/v1/site");
}

/**
 * PUT /v1/site/places — replace the site's ordered places.
 * @param {{ id: string, name: string }[]} places
 * @returns {Promise<{ site: any }>}
 */
export function putSitePlaces(places) {
  return request("PUT", "/v1/site/places", { body: { places } });
}

/**
 * POST /v1/checks — start a perimeter run. The client-minted `checkId` rides in
 * the `idempotency-key` header (not the body), so a replay can't duplicate the
 * header. `siteId` is server-derived.
 * @param {string} checkId
 * @param {{ places?: unknown }} [body]
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
 * into one scorecard and return an assessment envelope for guidance evaluation.
 * @param {string} checkId
 * @returns {Promise<{ checkId: string, status: string, grade: (string|null), issueCount: number, maxSeverity: number, assessmentReady?: boolean, assessment?: any }>}
 */
export function completeCheck(checkId) {
  return request("POST", `/v1/checks/${encodeURIComponent(checkId)}/complete`);
}

/**
 * POST /v1/assessments:evaluate — store an assessment/report, evaluate
 * conditions, and create any immediately resolvable guidance tasks. `dispositions`
 * maps a condition's stable conditionId -> the reviewer's clarification
 * ("not_present" | "better" | "worse" | "other"). Every disposition is recorded
 * for false-positive analysis, but only "not_present" ("I don't see this problem")
 * suppresses task minting for that condition. Keying by conditionId (not category)
 * means disputing one condition never affects a sibling that shares its category.
 * @param {any} assessment
 * @param {Record<string, string>} [dispositions]
 * @returns {Promise<{ assessment: any, conditions: any[], tasks: any[] }>}
 */
export function evaluateAssessment(assessment, dispositions = {}) {
  return request("POST", "/v1/assessments:evaluate", {
    body: { ...assessment, dispositions },
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
 * @returns {Promise<{ conditionItem: any, taskItem: any, evaluation: any }>}
 */
export function submitConditionAnswers(assessmentId, conditionId, body) {
  return request(
    "POST",
    `/v1/assessments/${encodeURIComponent(assessmentId)}/conditions/${encodeURIComponent(conditionId)}/answers`,
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
 * GET /v1/checks/{checkId} — one check with its artifacts + analyses, in a single
 * base-table query. 404 → ApiError(status 404).
 * @param {string} checkId
 * @returns {Promise<{ check: any, artifacts: any[], analyses: any[] }>}
 */
export function getCheck(checkId) {
  return request("GET", `/v1/checks/${encodeURIComponent(checkId)}`);
}

/**
 * POST /v1/checks/{checkId}/places/{placeId}/description:validate
 * @param {string} checkId
 * @param {string} placeId
 * @param {{ text: string, placeName?: string }} body
 * @returns {Promise<{ accepted: boolean, whatYouCanSee: boolean, whereItIs: boolean, message: string }>}
 */
export function validatePlaceDescription(checkId, placeId, body) {
  return request(
    "POST",
    `/v1/checks/${encodeURIComponent(checkId)}/places/${encodeURIComponent(placeId)}/description:validate`,
    { body },
  );
}

// ── Artifacts (photo upload leg) ────────────────────────────────────────────

/**
 * POST /v1/checks/{checkId}/artifacts:presign — mint an artifactId + S3 key and
 * a presigned PUT URL. content-type is pinned into the signature.
 * @param {string} checkId
 * @param {{ placeId: string, placeName: string, contentType: string }} body
 * @returns {Promise<{ artifactId: string, placeId: string, placeName: string, s3Key: string, contentType: string, uploadUrl: string, expiresIn: number }>}
 */
export function presignArtifact(checkId, body) {
  return request(
    "POST",
    `/v1/checks/${encodeURIComponent(checkId)}/artifacts:presign`,
    { body },
  );
}

/**
 * POST /v1/checks/{checkId}/artifacts — record an uploaded artifact and enqueue
 * its analysis. 409 (this artifactId already registered) → ApiError.
 * @param {string} checkId
 * @param {{ artifactId: string, placeId: string, placeName: string, s3Key?: string, contentType?: string, capturedAt?: string, text?: string }} body
 * @returns {Promise<{ artifactId: string, status: string }>}
 */
export function registerArtifact(checkId, body) {
  return request(
    "POST",
    `/v1/checks/${encodeURIComponent(checkId)}/artifacts`,
    {
      body,
    },
  );
}

/**
 * Raw presigned PUT of the media bytes straight to S3. NOT joined onto BASE and
 * carries no auth — the signature is the authorization, and the content-type must
 * match what was presigned. Throws `ApiError` on a non-2xx.
 * @param {string} uploadUrl  absolute presigned URL from `presignArtifact`
 * @param {Blob} blob
 * @param {string} contentType
 * @returns {Promise<void>}
 */
export async function putMedia(uploadUrl, blob, contentType) {
  /** @type {Response} */
  let res;
  try {
    res = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "content-type": contentType },
      body: blob,
    });
  } catch (err) {
    throw new ApiError(`Network error uploading media: ${err}`, { status: 0 });
  }
  if (!res.ok) {
    throw new ApiError(`Media upload → ${res.status} ${res.statusText}`, {
      status: res.status,
    });
  }
}

/**
 * GET /v1/checks/{checkId}/artifacts/{artifactId}/media — a short-lived presigned
 * GET so staff can review the original photo (admin/read path).
 * @param {string} checkId
 * @param {string} artifactId
 * @returns {Promise<{ artifactId: string, s3Key: string, downloadUrl: string, expiresIn: number }>}
 */
export function getMediaUrl(checkId, artifactId) {
  return request(
    "GET",
    `/v1/checks/${encodeURIComponent(checkId)}/artifacts/${encodeURIComponent(artifactId)}/media`,
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

/**
 * POST /v1/tasks/{taskId}/complete — mark a guidance task complete and record
 * any backend app-action results for audit.
 * @param {string} taskId
 * @param {{ completionMethod?: string }} [body]
 * @returns {Promise<{ task: any }>}
 */
export function completeTask(taskId, body = {}) {
  return request("POST", `/v1/tasks/${encodeURIComponent(taskId)}/complete`, {
    body,
  });
}

/**
 * POST /v1/tasks/{taskId}/cannot-do — audit-only reason capture when the user
 * cannot complete an action or escalation.
 * @param {string} taskId
 * @param {{ reason: string, note?: string }} body
 * @returns {Promise<{ task: any }>}
 */
export function cannotDoTask(taskId, body) {
  return request("POST", `/v1/tasks/${encodeURIComponent(taskId)}/cannot-do`, {
    body,
  });
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
 * (which enqueues the async analysis). Returns the registered artifactId so the
 * caller can wait for exactly these analyses to land.
 * @param {string} checkId
 * @param {{ placeId: string, placeName: string, dataUrl: string, capturedAt?: string, text?: string, tag?: string }} item
 *   `tag` is a caller-supplied label used only for perf traces (e.g. "front#0").
 * @returns {Promise<string>} the artifactId
 */
export async function uploadArtifact(
  checkId,
  { placeId, placeName, dataUrl, capturedAt, text, tag },
) {
  const art = tag ?? placeName;
  const done = span("upload", { art });

  const contentType = contentTypeFromDataUrl(dataUrl);
  const endPresign = span("upload.presign", { art });
  const { artifactId, s3Key, uploadUrl } = await presignArtifact(checkId, {
    placeId,
    placeName,
    contentType,
  });
  endPresign({ artifactId });

  const blob = await dataUrlToBlob(dataUrl);
  const endPut = span("upload.put", { art, bytes: blob.size });
  await putMedia(uploadUrl, blob, contentType);
  endPut();

  const endRegister = span("upload.register", { art, artifactId });
  await registerArtifact(checkId, {
    artifactId,
    placeId,
    placeName,
    s3Key,
    contentType,
    ...(capturedAt ? { capturedAt } : {}),
    ...(text ? { text } : {}),
  });
  endRegister();

  done({ artifactId });
  return artifactId;
}

/**
 * Register validated text evidence for a place without uploading media bytes.
 * @param {string} checkId
 * @param {{ placeId: string, placeName: string, text: string, capturedAt?: string }} item
 * @returns {Promise<string>}
 */
export async function registerTextArtifact(
  checkId,
  { placeId, placeName, text, capturedAt },
) {
  const artifactId = crypto.randomUUID();
  await registerArtifact(checkId, {
    artifactId,
    placeId,
    placeName,
    ...(capturedAt ? { capturedAt } : {}),
    text,
  });
  return artifactId;
}

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
  /** @type {{ check: any, artifacts: any[], analyses: any[] }} */
  let last = await getCheck(checkId);
  const wanted = expected ?? last.artifacts.length;
  while (true) {
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
    await new Promise((r) => setTimeout(r, intervalMs));
    last = await getCheck(checkId);
  }
}
