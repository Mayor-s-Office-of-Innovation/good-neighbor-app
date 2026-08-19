/**
 * @typedef {object} AppAction
 * @property {string} code
 * @property {Record<string, unknown>} [payload]
 */

/**
 * @typedef {object} AppActionResult
 * @property {string} code
 * @property {string} status
 * @property {Record<string, unknown>} [payload]
 * @property {string} [reason]
 * @property {string} [externalId]
 * @property {string} recordedAt
 */

/**
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 * @returns {boolean}
 */
export function is311SubmissionEnabled(env = process.env) {
  return env.GNP_311_SUBMISSION_ENABLED === "true";
}

/**
 * @param {AppAction[]} appActions
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [opts.env]
 * @param {string} [opts.taskId]
 * @param {Date} [opts.now]
 * @returns {AppActionResult[]}
 */
export function executeAppActions(appActions, opts = {}) {
  const now = (opts.now ?? new Date()).toISOString();
  const env = opts.env ?? process.env;

  return appActions.map((action) => {
    const payload = action.payload ?? {};
    switch (action.code) {
      case "open_phone":
        return {
          code: action.code,
          status: "requires_user_action",
          payload,
          recordedAt: now,
        };
      case "create_311_ticket":
        if (!is311SubmissionEnabled(env)) {
          return {
            code: action.code,
            status: "skipped",
            reason: "feature_disabled",
            payload,
            recordedAt: now,
          };
        }
        return {
          code: action.code,
          status: "submitted",
          externalId: `stub-311-${opts.taskId ?? "unknown"}`,
          payload,
          recordedAt: now,
        };
      case "compose_email":
        return {
          code: action.code,
          status: "not_configured",
          reason: "email_integration_pending",
          payload,
          recordedAt: now,
        };
      case "create_fire_hazard_report":
        return {
          code: action.code,
          status: "not_configured",
          reason: "form_integration_pending",
          payload,
          recordedAt: now,
        };
      default:
        return {
          code: action.code,
          status: "not_configured",
          reason: "unsupported_app_action",
          payload,
          recordedAt: now,
        };
    }
  });
}

/**
 * @param {AppAction[] | undefined} appActions
 * @returns {string}
 */
export function initialAppActionStatus(appActions) {
  return appActions && appActions.length > 0 ? "pending" : "none";
}

/**
 * @param {AppActionResult[]} results
 * @returns {string}
 */
export function summarizeAppActionResults(results) {
  if (results.length === 0) return "none";
  if (results.every((result) => result.status === "submitted")) return "submitted";
  if (results.some((result) => result.status === "submitted")) return "partial";
  if (results.some((result) => result.status === "requires_user_action")) {
    return "requires_user_action";
  }
  if (results.some((result) => result.status === "not_configured")) {
    return "not_configured";
  }
  if (results.every((result) => result.status === "skipped")) return "skipped";
  return "recorded";
}
