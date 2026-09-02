import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../../db.js";
import { getObjectBytes } from "../../s3.js";
import { getAnalyzerApiKey } from "../api-key.js";
import { createAnalyzerClient } from "../analyzer-client.js";
import { getConfig } from "../../config.js";
import {
  buildCreateSrPayload,
  createSf311Client,
  Sf311Error,
} from "../../integrations/sf311-client.js";
import {
  parseClassifierServiceCodeMap,
  parseServiceCodeOrAction,
  serviceCodesForClassifierLabels,
} from "../../integrations/sf311-service-codes.js";
import { checkArtifactPrefix, siteMetaKey } from "../../handlers/keys.js";

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
 * @param {Record<string, unknown>} task
 * @returns {string}
 */
function problemDescriptionForTask(task) {
  return String(
    task.description ?? task.guidance ?? task.label ?? task.category ?? "",
  );
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * @param {Record<string, unknown>} task
 * @returns {{ latitude: number, longitude: number } | null}
 */
function locationFromTask(task) {
  const sources = [
    task.location,
    task.source,
    /** @type {{ location?: unknown }} */ (task.source ?? {}).location,
  ];
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    const item = /** @type {Record<string, unknown>} */ (source);
    const latitude = finiteNumber(item.latitude ?? item.Latitude);
    const longitude = finiteNumber(item.longitude ?? item.Longitude);
    if (latitude !== null && longitude !== null) return { latitude, longitude };
  }
  return null;
}

/**
 * @param {object} opts
 * @param {string} opts.tableName
 * @param {string} opts.siteId
 * @param {Record<string, unknown>} opts.task
 * @returns {Promise<{ latitude: number, longitude: number } | null>}
 */
async function resolveLocation({ tableName, siteId, task }) {
  const taskLocation = locationFromTask(task);
  if (taskLocation) return taskLocation;

  const site = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: siteMetaKey(siteId),
      ConsistentRead: true,
    }),
  );
  const location =
    site.Item && typeof site.Item.location === "object"
      ? /** @type {Record<string, unknown>} */ (site.Item.location)
      : {};
  const latitude = finiteNumber(location.latitude);
  const longitude = finiteNumber(location.longitude);
  return latitude !== null && longitude !== null
    ? { latitude, longitude }
    : null;
}

/**
 * @param {object} opts
 * @param {string} opts.tableName
 * @param {string} opts.siteId
 * @param {Record<string, unknown>} opts.task
 * @returns {Promise<{ content_type: "image/jpeg" | "image/png" | "image/webp", base64: string, metadata?: object }>}
 */
async function loadClassifierImage({ tableName, siteId, task }) {
  const artifactIds = new Set(
    /** @type {string[]} */ (task.sourceArtifactIds ?? []),
  );
  if (!task.checkId || artifactIds.size === 0) {
    throw new Error("No source image is available for 311 classifier analysis");
  }
  const result = await ddb.send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: {
        ":pk": `SITE#${siteId}`,
        ":prefix": checkArtifactPrefix(String(task.checkId)),
      },
      ConsistentRead: true,
    }),
  );
  const artifact = (result.Items ?? []).find(
    (item) =>
      artifactIds.has(String(item.artifactId ?? "")) &&
      typeof item.s3Key === "string" &&
      typeof item.contentType === "string" &&
      String(item.contentType).startsWith("image/"),
  );
  if (!artifact) {
    throw new Error("No source image is available for 311 classifier analysis");
  }
  const object = await getObjectBytes({
    bucket: getConfig().uploadBucket,
    key: String(artifact.s3Key),
  });
  const contentType = String(artifact.contentType || object.contentType);
  if (!["image/jpeg", "image/png", "image/webp"].includes(contentType)) {
    throw new Error(
      `Unsupported classifier image content type: ${contentType}`,
    );
  }
  return {
    content_type: /** @type {"image/jpeg" | "image/png" | "image/webp"} */ (
      contentType
    ),
    base64: object.bytes.toString("base64"),
  };
}

/**
 * @param {object} opts
 * @param {string} opts.tableName
 * @param {string} opts.siteId
 * @param {Record<string, unknown>} opts.task
 * @param {AppAction} opts.action
 * @param {Date} opts.nowDate
 * @param {Record<string, string | undefined>} opts.env
 * @param {AppActionResult[]} opts.priorResults
 * @returns {Promise<AppActionResult>}
 */
async function execute311Action({
  tableName,
  siteId,
  task,
  action,
  nowDate,
  env,
  priorResults,
}) {
  const now = nowDate.toISOString();
  const priorSubmitted = priorResults.find(
    (result) => result.code === action.code && result.status === "submitted",
  );
  if (priorSubmitted) return priorSubmitted;

  if (!is311SubmissionEnabled(env)) {
    return {
      code: action.code,
      status: "skipped",
      reason: "feature_disabled",
      payload: action.payload ?? {},
      recordedAt: now,
    };
  }

  const config = getConfig(/** @type {NodeJS.ProcessEnv} */ (env));
  const serviceCodeOrAction =
    /** @type {{ serviceCodeOrAction?: string | null }} */ (
      action.payload ?? {}
    ).serviceCodeOrAction;
  const parsed = parseServiceCodeOrAction(serviceCodeOrAction);
  if (parsed.kind === "none") {
    return {
      code: action.code,
      status: "failed",
      reason: "missing_service_code",
      payload: action.payload ?? {},
      recordedAt: now,
    };
  }

  let serviceCodes = [];
  if (parsed.kind === "service_code") {
    serviceCodes = [parsed.serviceCode];
  } else {
    const analyzerApiKey = await getAnalyzerApiKey(config);
    const analyzer = createAnalyzerClient({
      baseUrl: config.analyzerBaseUrl ?? "",
      apiKey: analyzerApiKey,
    });
    const image = await loadClassifierImage({ tableName, siteId, task });
    const result = /** @type {{ labels?: unknown }} */ (
      await analyzer.classifyImage({
        classifierId: parsed.classifierId,
        image,
        requestId: String(task.taskId ?? ""),
        appId: "good-neighbor-app",
      })
    );
    const labels = Array.isArray(result.labels)
      ? result.labels.filter((label) => typeof label === "string")
      : [];
    serviceCodes = serviceCodesForClassifierLabels({
      classifierId: parsed.classifierId,
      labels,
      map: parseClassifierServiceCodeMap(config.sf311ClassifierServiceCodeMap),
    });
  }

  const location = await resolveLocation({ tableName, siteId, task });
  if (!location) {
    return {
      code: action.code,
      status: "failed",
      reason: "missing_location",
      payload: action.payload ?? {},
      recordedAt: now,
    };
  }

  const sf311 = createSf311Client({ config });
  const tickets = [];
  for (const serviceCode of serviceCodes) {
    const actionPayload =
      /** @type {{ responsibleAgencyCode?: unknown }} */ (
        action.payload ?? {}
      );
    const responsibleAgency = Object.hasOwn(
      actionPayload,
      "responsibleAgencyCode",
    )
      ? String(actionPayload.responsibleAgencyCode ?? "")
      : await sf311.lookupResponsibleAgency(serviceCode);
    const payload = buildCreateSrPayload({
      taskId: String(task.taskId ?? ""),
      serviceCode,
      responsibleAgency,
      problemDescription: problemDescriptionForTask(task),
      location,
      now: nowDate,
    });
    const response = await sf311.createServiceRequest(payload);
    tickets.push({
      serviceCode,
      responsibleAgency,
      sourceRequestId: payload.SourceRequestID,
      srNum: response.srNum,
    });
  }

  return {
    code: action.code,
    status: "submitted",
    payload: { ...(action.payload ?? {}), tickets },
    externalId: tickets
      .map((ticket) => ticket.srNum)
      .filter(Boolean)
      .join(","),
    recordedAt: now,
  };
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function appActionErrorReason(error) {
  if (error instanceof Sf311Error) return error.code || "sf311_error";
  if (error instanceof Error) return error.message;
  return "app_action_failed";
}

/**
 * @param {AppAction[]} appActions
 * @param {"task_created" | "user_confirmed" | undefined} trigger
 * @returns {AppAction[]}
 */
function actionsForTrigger(appActions, trigger) {
  if (!trigger) return appActions;
  return appActions.filter((action) => {
    const actionTrigger =
      /** @type {{ executionTrigger?: unknown }} */ (action.payload ?? {})
        .executionTrigger;
    if (trigger === "task_created") return actionTrigger === "task_created";
    return actionTrigger !== "task_created";
  });
}

/**
 * @param {AppAction[]} appActions
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [opts.env]
 * @param {string} [opts.taskId]
 * @param {string} [opts.tableName]
 * @param {string} [opts.siteId]
 * @param {Record<string, unknown>} [opts.task]
 * @param {AppActionResult[]} [opts.priorResults]
 * @param {"task_created" | "user_confirmed"} [opts.trigger]
 * @param {Date} [opts.now]
 * @returns {Promise<AppActionResult[]>}
 */
export async function executeAppActions(appActions, opts = {}) {
  const nowDate = opts.now ?? new Date();
  const now = nowDate.toISOString();
  const env = opts.env ?? process.env;
  const priorResults = opts.priorResults ?? [];
  const executableActions = actionsForTrigger(appActions, opts.trigger);
  /** @type {AppActionResult[]} */
  const results = [];
  for (const action of executableActions) {
    const payload = action.payload ?? {};
    switch (action.code) {
      case "open_phone":
        results.push({
          code: action.code,
          status: "recorded",
          payload,
          recordedAt: now,
        });
        break;
      case "create_311_ticket":
        try {
          results.push(
            await execute311Action({
              tableName: opts.tableName ?? "",
              siteId: opts.siteId ?? "",
              task: opts.task ?? { taskId: opts.taskId },
              action,
              nowDate,
              env,
              priorResults,
            }),
          );
        } catch (error) {
          results.push({
            code: action.code,
            status: "failed",
            reason: appActionErrorReason(error),
            payload,
            recordedAt: now,
          });
        }
        break;
      case "compose_email":
        results.push({
          code: action.code,
          status: "not_configured",
          reason: "email_integration_pending",
          payload,
          recordedAt: now,
        });
        break;
      case "create_fire_hazard_report":
        results.push({
          code: action.code,
          status: "not_configured",
          reason: "form_integration_pending",
          payload,
          recordedAt: now,
        });
        break;
      case "manual_app_action":
        results.push({
          code: action.code,
          status: "recorded",
          payload,
          recordedAt: now,
        });
        break;
      default:
        results.push({
          code: action.code,
          status: "not_configured",
          reason: "unsupported_app_action",
          payload,
          recordedAt: now,
        });
    }
  }
  return results;
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
  if (results.every((result) => result.status === "submitted"))
    return "submitted";
  if (results.some((result) => result.status === "submitted")) return "partial";
  if (results.some((result) => result.status === "requires_user_action")) {
    return "requires_user_action";
  }
  if (results.some((result) => result.status === "failed")) return "failed";
  if (results.some((result) => result.status === "not_configured")) {
    return "not_configured";
  }
  if (results.every((result) => result.status === "skipped")) return "skipped";
  return "recorded";
}
