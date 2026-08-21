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

// Same-origin in dev (Vite proxy forwards `/v1/*` → the local API on :3001, no
// CORS — see vite.config.js); in production the app is built with VITE_API_BASE
// pointing at the API origin. Shared strategy with services/onboarding.js. Cast
// `import.meta` — Vite's env types (vite/client) aren't wired into this checkJs
// project, so the host-injected `.env` access is typed locally.
const BASE = /** @type {any} */ (import.meta).env?.VITE_API_BASE ?? "";

/** A non-2xx response or a transport failure from the backend. */
export class ApiError extends Error {
  /**
   * @param {string} message
   * @param {object} [opts]
   * @param {number} [opts.status]  HTTP status (0 = network/transport failure)
   * @param {unknown} [opts.body]   parsed error body, when the server sent one
   */
  constructor(message, { status = 0, body = undefined } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

/**
 * One JSON request against the backend. Serializes an object body, parses a JSON
 * response, and throws `ApiError` on a non-2xx status or a transport failure.
 * @param {string} method
 * @param {string} path        path beginning with `/` (joined onto BASE)
 * @param {object} [opts]
 * @param {Record<string,string>} [opts.headers]
 * @param {unknown} [opts.body]  JSON-serializable body (omitted for GET)
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<any>} the parsed JSON body (null for an empty 2xx)
 */
async function request(method, path, { headers = {}, body, signal } = {}) {
  const hasBody = body !== undefined;
  /** @type {Response} */
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        ...(hasBody ? { "content-type": "application/json" } : {}),
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
 * POST /v1/checks — start a perimeter run. The client-minted `checkId` rides in
 * the `idempotency-key` header (not the body), so a replay can't duplicate the
 * header. `siteId` is server-derived.
 * @param {string} checkId
 * @param {{ sides?: unknown }} [body]
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
 * conditions, and create any immediately resolvable guidance tasks.
 * @param {unknown} assessment
 * @returns {Promise<{ assessment: any, conditions: any[], tasks: any[] }>}
 */
export function evaluateAssessment(assessment) {
  return request("POST", "/v1/assessments:evaluate", { body: assessment });
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
 * POST /v1/checks/{checkId}/sides/{side}/description:validate
 * @param {string} checkId
 * @param {string} side
 * @param {{ text: string }} body
 * @returns {Promise<{ accepted: boolean, whatYouCanSee: boolean, whereItIs: boolean, message: string }>}
 */
export function validateSideDescription(checkId, side, body) {
  return request(
    "POST",
    `/v1/checks/${encodeURIComponent(checkId)}/sides/${encodeURIComponent(side)}/description:validate`,
    { body },
  );
}

// ── Artifacts (photo upload leg) ────────────────────────────────────────────

/**
 * POST /v1/checks/{checkId}/artifacts:presign — mint an artifactId + S3 key and
 * a presigned PUT URL. content-type is pinned into the signature.
 * @param {string} checkId
 * @param {{ side: string, contentType: string }} body
 * @returns {Promise<{ artifactId: string, side: string, s3Key: string, contentType: string, uploadUrl: string, expiresIn: number }>}
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
 * its analysis. 409 (already registered / missing parent) → ApiError.
 * @param {string} checkId
 * @param {{ artifactId: string, side: string, s3Key: string, contentType?: string, capturedAt?: string, text?: string }} body
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
 * photos inline as JPEG data-URLs (`item.dataUrl`); this is the one-liner that
 * reconstitutes the bytes.
 * @param {string} dataUrl
 * @returns {Promise<Blob>}
 */
export async function dataUrlToBlob(dataUrl) {
  const res = await fetch(dataUrl);
  return res.blob();
}

/**
 * Upload one captured photo end-to-end: presign → PUT bytes to S3 → register
 * (which enqueues the async analysis). Returns the registered artifactId so the
 * caller can wait for exactly these analyses to land.
 * @param {string} checkId
 * @param {{ side: string, dataUrl: string, capturedAt?: string }} item
 * @returns {Promise<string>} the artifactId
 */
export async function uploadArtifact(checkId, { side, dataUrl, capturedAt }) {
  const contentType = contentTypeFromDataUrl(dataUrl);
  const { artifactId, s3Key, uploadUrl } = await presignArtifact(checkId, {
    side,
    contentType,
  });
  const blob = await dataUrlToBlob(dataUrl);
  await putMedia(uploadUrl, blob, contentType);
  await registerArtifact(checkId, {
    artifactId,
    side,
    s3Key,
    contentType,
    ...(capturedAt ? { capturedAt } : {}),
  });
  return artifactId;
}

/**
 * Short poll (scoped to the submit flow, not a sync engine) that waits for the
 * async analyses to land after registering artifacts. Resolves as soon as every
 * registered artifact has a matching ANALYSIS# item — counting failed markers, so
 * a failed analysis doesn't hang the poll — or when the deadline passes. Returns
 * the last `getCheck` payload either way; the caller decides whether partial
 * results are acceptable (`completeCheck` folds only what analyzed cleanly).
 * @param {string} checkId
 * @param {{ expected: number, timeoutMs?: number, intervalMs?: number }} opts
 * @returns {Promise<{ check: any, artifacts: any[], analyses: any[] }>}
 */
export async function waitForAnalyses(
  checkId,
  { expected, timeoutMs = 20000, intervalMs = 1200 },
) {
  const deadline = Date.now() + timeoutMs;
  /** @type {{ check: any, artifacts: any[], analyses: any[] }} */
  let last = await getCheck(checkId);
  while (true) {
    const analyzedIds = new Set(last.analyses.map((a) => a.artifactId));
    const covered =
      last.artifacts.length >= expected &&
      last.artifacts.every((a) => analyzedIds.has(a.artifactId));
    if (expected === 0 || covered || Date.now() >= deadline) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
    last = await getCheck(checkId);
  }
}
