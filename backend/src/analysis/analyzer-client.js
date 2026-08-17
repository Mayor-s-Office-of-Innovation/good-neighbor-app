// Caller-side client for the Street Conditions analysis service (ours, deployed
// standalone). It is a *thin* HTTP transport, not a domain layer: it stamps
// GNP's non-negotiable invariants onto every request and maps the service's
// documented error shape to a typed error — nothing more. Adapting the response
// into our stored shape is `adapt-scorecard.js`'s job, kept separate so the wire
// contract and our persistence stay decoupled.
//
// Invariants (see MVP-TODO 🔒 analyzer-auth + media-handling):
//   - `x-api-key` (GNP's per-consumer key) is a *server-side* credential — held
//     by our Lambda (Secrets Manager in prod, env for local), never on device.
//   - `store_input:false` always — the analyzer must never retain our media;
//     GNP owns retention (own S3 bucket + ~7-day lifecycle).
//   - rubric is pinned to the version we vendored types for (contract.js).
//
// Endpoints, per the service's OpenAPI + the reference tester
// (../street-conditions-analysis/tools/local-endpoint-tester/server.mjs):
//   POST /v1/analyses  — auth: x-api-key
//   GET  /v1/rubrics   — no auth
//
// Dependency-free: uses global fetch (Node 22). Tests inject `fetchImpl`/`sleep`
// so no network or timers are touched.

import { RUBRIC_ID, RUBRIC_VERSION } from "./contract.js";

/** @typedef {import("./contract.js").AnalysisResponse} AnalysisResponse */

/**
 * The service's documented error `code`s (error-response.schema.json). Kept as a
 * plain typedef — we don't switch on them beyond surfacing, but naming them
 * documents what a caller can expect on `.code`.
 * @typedef {"invalid_request" | "unknown_rubric" | "unsupported_input_type" | "unauthorized" | "forbidden_rubric" | "model_invoke_failed" | "invalid_model_response"} AnalyzerErrorCode
 */

/** HTTP statuses worth a retry: throttling, gateway/model transients, 5xx. */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A failed analyzer call. `retryable` reflects whether the client already
 * exhausted its retries on a transient class (so the caller can decide to
 * re-queue vs. dead-letter); `code`/`details` are the service's error body when
 * present.
 */
export class AnalyzerError extends Error {
  /**
   * @param {string} message
   * @param {object} [opts]
   * @param {number} [opts.status]
   * @param {AnalyzerErrorCode | string} [opts.code]
   * @param {string[]} [opts.details]
   * @param {boolean} [opts.retryable]
   * @param {unknown} [opts.cause]
   */
  constructor(
    message,
    { status, code, details, retryable = false, cause } = {},
  ) {
    super(message);
    this.name = "AnalyzerError";
    /** @type {number | undefined} */
    this.status = status;
    /** @type {AnalyzerErrorCode | string | undefined} */
    this.code = code;
    /** @type {string[] | undefined} */
    this.details = details;
    /** @type {boolean} */
    this.retryable = retryable;
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * A `metadata` block in the service's wire shape (snake_case). Same required
 * fields as the response's `AssessmentMetadata`, so we reuse that type.
 * @typedef {import("./contract.js").AssessmentMetadata} AnalyzeMetadata
 */

/**
 * One wire media item. Image needs base64 + content_type; text needs ≥5 chars.
 * Passed through verbatim — the worker (Step C) produces these from downscaled
 * S3 media, so translating a naming convention here would be busywork.
 * @typedef {{ type: "image", content_type: "image/jpeg" | "image/png" | "image/webp", base64: string, metadata?: object }} ImageMedia
 * @typedef {{ type: "text", text: string, metadata?: object }} TextMedia
 * @typedef {ImageMedia | TextMedia} AnalyzeMedia
 */

/**
 * Build the exact body `POST /v1/analyses` expects, stamping GNP's invariants:
 * pinned rubric, `store_input:false`, and (optionally) caller identity/trace.
 * The service schema is `additionalProperties:false` at the top level and on
 * each media item, so this returns only known keys.
 * @param {object} input
 * @param {AnalyzeMetadata} input.metadata
 * @param {AnalyzeMedia[]} input.media
 * @param {string} [input.requestId] threaded to `caller.request_id` for tracing
 * @param {string} [input.appId] threaded to `caller.app_id`
 * @returns {Record<string, unknown>}
 */
export function buildAnalyzeRequest({ metadata, media, requestId, appId }) {
  /** @type {Record<string, string>} */
  const caller = {};
  if (appId !== undefined) caller.app_id = appId;
  if (requestId !== undefined) caller.request_id = requestId;

  return {
    rubric_id: RUBRIC_ID,
    rubric_version: RUBRIC_VERSION,
    metadata,
    media,
    // Never let the analyzer persist our media — GNP owns retention.
    storage: { store_input: false, return_signed_urls: false },
    ...(Object.keys(caller).length > 0 ? { caller } : {}),
  };
}

/**
 * @typedef {object} AnalyzerClientOptions
 * @property {string} baseUrl service base, e.g. https://analysis.example.org/
 * @property {string} apiKey GNP's per-consumer key (server-side only)
 * @property {typeof fetch} [fetchImpl] injectable transport (tests)
 * @property {number} [maxRetries] retries on transient failures (default 2)
 * @property {number} [baseDelayMs] backoff base, doubled per attempt (default 200)
 * @property {(ms: number) => Promise<void>} [sleep] injectable delay (tests)
 */

/**
 * @typedef {object} AnalyzerClient
 * @property {(input: { metadata: AnalyzeMetadata, media: AnalyzeMedia[], requestId?: string, appId?: string }) => Promise<AnalysisResponse>} analyze
 * @property {() => Promise<unknown>} listRubrics
 */

/**
 * @param {AnalyzerClientOptions} options
 * @returns {AnalyzerClient}
 */
export function createAnalyzerClient({
  baseUrl,
  apiKey,
  fetchImpl = fetch,
  maxRetries = 2,
  baseDelayMs = 200,
  sleep = defaultSleep,
}) {
  if (!baseUrl) throw new Error("createAnalyzerClient: baseUrl is required");
  if (!apiKey) throw new Error("createAnalyzerClient: apiKey is required");

  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  /**
   * @param {string} pathname
   * @returns {URL}
   */
  const resolve = (pathname) => new URL(pathname.replace(/^\//, ""), base);

  /**
   * Try to read the service's `{ error: { code, message, details } }` body.
   * @param {Response} res
   * @returns {Promise<{ code?: string, message?: string, details?: string[] }>}
   */
  const readError = async (res) => {
    try {
      const body = await res.json();
      return body && typeof body === "object" && body.error ? body.error : {};
    } catch {
      return {};
    }
  };

  /**
   * @param {string} pathname
   * @param {{ method: "GET" | "POST", body?: unknown, auth: boolean }} opts
   * @returns {Promise<unknown>}
   */
  const request = async (pathname, { method, body, auth }) => {
    const url = resolve(pathname);

    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetchImpl(url, {
          method,
          headers: {
            accept: "application/json",
            ...(body !== undefined
              ? { "content-type": "application/json" }
              : {}),
            ...(auth ? { "x-api-key": apiKey } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
      } catch (cause) {
        // Transport failure (DNS/connection/TLS) — retry, then give up.
        if (attempt < maxRetries) {
          await sleep(baseDelayMs * 2 ** attempt);
          continue;
        }
        throw new AnalyzerError("Analyzer request failed (network)", {
          retryable: true,
          cause,
        });
      }

      if (res.ok) return res.json();

      if (RETRYABLE_STATUS.has(res.status) && attempt < maxRetries) {
        await sleep(baseDelayMs * 2 ** attempt);
        continue;
      }

      const err = await readError(res);
      throw new AnalyzerError(
        err.message || `Analyzer returned ${res.status}`,
        {
          status: res.status,
          code: err.code,
          details: err.details,
          retryable: RETRYABLE_STATUS.has(res.status),
        },
      );
    }
  };

  return {
    async analyze({ metadata, media, requestId, appId }) {
      const body = buildAnalyzeRequest({ metadata, media, requestId, appId });
      return /** @type {Promise<AnalysisResponse>} */ (
        request("/v1/analyses", { method: "POST", body, auth: true })
      );
    },
    listRubrics() {
      return request("/v1/rubrics", { method: "GET", auth: false });
    },
  };
}
