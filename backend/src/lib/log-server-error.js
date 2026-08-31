/*
  logServerError — the repo's server-side error-logging convention (error-
  tracking plan Phase 4; see docs/todo/client-error-tracking-plan.md).

  Every uncaught server error goes through this helper exactly once, emitted
  as a SINGLE-LINE JSON `console.error` so CloudWatch Logs Insights can group
  on fields and metric filters can alarm on `"level":"ERROR"`. CloudWatch is
  the source of truth for server errors — full fidelity, independent of the
  PostHog leg (the optional `$exception` mirror would hang off this same
  helper later; it never replaces it).
*/

/**
 * Emit one structured error line for Logs Insights / metric filters.
 * Never throws; safe on any error-ish value.
 * @param {string} route identifier for grouping ("api POST /v1/checks",
 *   "worker analyze", "worker process-submission", …)
 * @param {unknown} err the thrown value (Error, string, anything)
 * @param {{ reqId?: string, extra?: Record<string, unknown> }} [ctx]
 * @returns {void}
 */
export function logServerError(route, err, ctx = {}) {
  try {
    const error = err instanceof Error ? err : undefined;
    console.error(
      JSON.stringify({
        level: "ERROR",
        route,
        reqId: ctx.reqId,
        name: error ? error.constructor.name : "NonError",
        message: error ? error.message : String(err),
        stack: error ? error.stack : undefined,
        ...ctx.extra,
      }),
    );
  } catch {
    // Logging must never throw (exotic getters on Error, etc.).
  }
}

/**
 * Wrap an async lambda/handler dispatch so uncaught errors are logged via
 * logServerError and then rethrown for the platform (API Gateway → 500,
 * SQS → redrive). Callers keep their own return values.
 * @template T
 * @param {string} route
 * @param {() => T | Promise<T>} work sync or async; a sync throw is caught
 *   and logged too (a bare `work().catch()` would miss it)
 * @param {{ reqId?: string, extra?: Record<string, unknown> }} [ctx]
 * @returns {Promise<T | never>}
 */
export function withServerErrorsLogged(route, work, ctx = {}) {
  try {
    return Promise.resolve(work()).catch((err) => {
      logServerError(route, err, ctx);
      throw err;
    });
  } catch (err) {
    logServerError(route, err, ctx);
    return Promise.reject(err);
  }
}
