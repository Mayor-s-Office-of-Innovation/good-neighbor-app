/*
  guidance-api — the harness's raw same-origin client for the three guidance
  endpoints. Independent of services/api.js on purpose: the standalone harness
  page carries no app state (no site binding, no device token), so requests go
  out unauthenticated under `npm run dev` (the Vite proxy forwards /v1/* to the
  local API on :3001) and the local harness's stub authorizer resolves the
  tenant partition: the `x-debug-site` header when set, else DEBUG_SITE env,
  else "demo-site". Handlers read the siteId server-side only; it is never in
  a request body. (Deployed routes are authorizer-gated; this page is not part
  of the production build — it exercises the local backend with the real
  Lambda handler code and real local DynamoDB.)
*/

const BASE_PATHS = {
  evaluate: "/v1/assessments:evaluate",
  guidance: (assessmentId) =>
    `/v1/assessments/${encodeURIComponent(assessmentId)}/guidance`,
  answers: (assessmentId, conditionId) =>
    `/v1/assessments/${encodeURIComponent(assessmentId)}/conditions/${encodeURIComponent(conditionId)}/answers`,
};

/** Optional local-partition target (the stub authorizer's custom:siteId). */
let debugSite = "";

/**
 * Aim unauthenticated harness requests at one local site partition. An empty
 * string clears it (back to the DEBUG_SITE/demo-site default).
 * @param {string} siteId
 */
export function setDebugSite(siteId) {
  debugSite = String(siteId || "").trim();
}

/**
 * @param {string} method
 * @param {string} path
 * @param {unknown} [body]
 * @returns {Promise<Record<string, unknown> | null>} the parsed JSON body
 */
async function request(method, path, body) {
  const hasBody = body !== undefined;
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: {
        ...(hasBody ? { "content-type": "application/json" } : {}),
        ...(debugSite ? { "x-debug-site": debugSite } : {}),
      },
      ...(hasBody ? { body: JSON.stringify(body) } : {}),
    });
  } catch (err) {
    throw new Error(`Network error calling ${method} ${path}: ${err}`);
  }
  const text = await res.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // Non-JSON from the local API (proxy hiccup, error page) is never usable.
      throw new Error(
        `Non-JSON response from ${method} ${path} (status ${res.status})`,
      );
    }
  }
  if (!res.ok) {
    const detail =
      /** @type {{ error?: unknown, message?: unknown } | null} */ (parsed)
        ?.message ??
      /** @type {{ error?: unknown } | null} */ (parsed)?.error ??
      res.status;
    throw new Error(`${res.status} from ${method} ${path}: ${String(detail)}`);
  }
  return parsed;
}

/**
 * Shape every guidance endpoint returns (mirrors services/api.js's JSDoc).
 * @typedef {{ assessment: Record<string, unknown>, conditions: Record<string, unknown>[], tasks: Record<string, unknown>[] }} GuidanceEnvelope
 */

/**
 * POST /v1/assessments:evaluate — store an assessment/report, evaluate
 * conditions, and create any immediately resolvable guidance tasks.
 * (Signature mirrors services/api.js's, so harness call sites stay comparable.)
 * @param {Record<string, unknown>} assessment
 * @returns {Promise<GuidanceEnvelope>}
 */
export function evaluateAssessment(assessment) {
  return /** @type {Promise<GuidanceEnvelope>} */ (
    request("POST", BASE_PATHS.evaluate, { ...assessment })
  );
}

/**
 * GET /v1/assessments/{assessmentId}/guidance — fetch the stored assessment,
 * conditions, and any created guidance tasks.
 * @param {string} assessmentId
 * @returns {Promise<GuidanceEnvelope>}
 */
export function getAssessmentGuidance(assessmentId) {
  return /** @type {Promise<GuidanceEnvelope>} */ (
    request("GET", BASE_PATHS.guidance(assessmentId))
  );
}

/**
 * POST /v1/assessments/{assessmentId}/conditions/{conditionId}/answers.
 * @param {string} assessmentId
 * @param {string} conditionId
 * @param {{ answers: Record<string, unknown> }} body
 * @returns {Promise<Record<string, unknown>>}
 */
export function submitConditionAnswers(assessmentId, conditionId, body) {
  return /** @type {Promise<Record<string, unknown>>} */ (
    request("POST", BASE_PATHS.answers(assessmentId, conditionId), body)
  );
}
