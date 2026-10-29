import { createHash } from "node:crypto";
import { GetCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../../db.js";
import { getObjectBytes } from "../../s3.js";
import { create311MediaLink } from "../../integrations/sf311-media.js";
import { downscaleImage } from "../../media/downscale.js";
import { getAnalyzerApiKey } from "../api-key.js";
import { createAnalyzerClient } from "../analyzer-client.js";
import { getConfig } from "../../config.js";
import { emitMetrics } from "../../lib/metrics.js";
import {
  buildAttachmentUpdatePayload,
  buildCloseSrPayload,
  buildCreateSrPayload,
  SILENT_TICKET_CLOSED_REASON,
  createSf311Client,
  GOOD_NEIGHBOR_AGENCY,
  Sf311Error,
} from "../../integrations/sf311-client.js";
import {
  parseClassifierServiceCodeMap,
  parseServiceCodeOrAction,
  serviceCodesForClassifierLabels,
} from "../../integrations/sf311-service-codes.js";
import {
  hasServiceRequestAttachment,
  serviceRequestClosureReason,
  serviceRequestClosureState,
} from "../../integrations/sf311-status.js";
import {
  checkArtifactPrefix,
  siteMetaKey,
  taskKey,
} from "../../handlers/keys.js";

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
 * @property {Record<string, unknown>} [diagnostics]
 * @property {string} [externalId]
 * @property {string} recordedAt
 */

/**
 * @param {AppActionResult} result
 * @returns {Array<Record<string, unknown>>}
 */
function ticketsFromActionResult(result) {
  const tickets = result.payload?.tickets;
  return Array.isArray(tickets)
    ? tickets.filter((ticket) => ticket && typeof ticket === "object")
    : [];
}

/**
 * @param {AppActionResult[]} priorResults
 * @param {string} actionCode
 * @returns {Map<string, Record<string, unknown>>}
 */
function priorTicketsByServiceCode(priorResults, actionCode) {
  const tickets = new Map();
  for (const result of priorResults) {
    if (result.code !== actionCode) continue;
    for (const ticket of ticketsFromActionResult(result)) {
      const serviceCode = String(ticket.serviceCode ?? "");
      if (serviceCode && ticket.srNum) tickets.set(serviceCode, ticket);
    }
  }
  return tickets;
}

/**
 * @param {Record<string, unknown>} attachment
 * @returns {string}
 */
function attachmentKey(attachment) {
  return String(attachment.artifactId ?? attachment.s3Key ?? "");
}

/**
 * Closure state from earlier close_311_ticket results, keyed by service code.
 * `closed` tickets are never re-attempted; `failed` ones carry their prior
 * failure forward for the retry path.
 * @param {AppActionResult[]} priorResults
 * @returns {Map<string, Record<string, unknown>>}
 */
function priorClosuresFromPriorResults(priorResults) {
  const closures = new Map();
  for (const result of priorResults) {
    if (result.code !== "close_311_ticket") continue;
    const entries = result.payload?.closures;
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const item = /** @type {Record<string, unknown>} */ (entry);
      const serviceCode = String(item.serviceCode ?? "");
      if (serviceCode) closures.set(serviceCode, item);
    }
  }
  return closures;
}

/**
 * @param {unknown} attachments
 * @returns {Map<string, Record<string, unknown>>}
 */
function submittedAttachmentsByKey(attachments) {
  const submitted = new Map();
  if (!Array.isArray(attachments)) return submitted;
  for (const attachment of attachments) {
    if (!attachment || typeof attachment !== "object") continue;
    const item = /** @type {Record<string, unknown>} */ (attachment);
    const key = attachmentKey(item);
    if (key && item.status === "submitted") submitted.set(key, item);
  }
  return submitted;
}

/**
 * @param {unknown} attachments
 * @returns {boolean}
 */
function hasIncompleteAttachment(attachments) {
  return (
    Array.isArray(attachments) &&
    attachments.some(
      (attachment) =>
        attachment &&
        typeof attachment === "object" &&
        /** @type {Record<string, unknown>} */ (attachment).status !==
          "submitted",
    )
  );
}

/**
 * @param {object} opts
 * @param {AppAction} opts.action
 * @param {string} opts.status
 * @param {string} opts.recordedAt
 * @param {Array<Record<string, unknown>>} opts.tickets
 * @param {string} [opts.reason]
 * @param {Record<string, unknown>} [opts.diagnostics]
 * @returns {AppActionResult}
 */
function build311ActionResult({
  action,
  status,
  recordedAt,
  tickets,
  reason,
  diagnostics,
}) {
  return {
    code: action.code,
    status,
    ...(reason ? { reason } : {}),
    payload: { ...(action.payload ?? {}), tickets },
    externalId: tickets
      .map((ticket) => ticket.srNum)
      .filter(Boolean)
      .join(","),
    ...(diagnostics ? { diagnostics } : {}),
    recordedAt,
  };
}

/**
 * Merge a fresh action result into the prior persisted results: same-code
 * entries are replaced in place (first occurrence wins the slot), everything
 * else is kept verbatim so results for other action codes survive the write.
 * Checkpointing with this instead of `[result]` is what keeps closure records
 * from clobbering the create results that closure eligibility depends on (and
 * vice versa) across lease-recovery retries.
 * @param {AppActionResult[]} priorResults
 * @param {AppActionResult} result
 * @returns {AppActionResult[]}
 */
export function mergeAppActionResults(priorResults, result) {
  const merged = [];
  let placed = false;
  for (const prior of priorResults) {
    if (prior.code === result.code && !placed) {
      merged.push(result);
      placed = true;
      continue;
    }
    if (prior.code === result.code) continue;
    merged.push(prior);
  }
  if (!placed) merged.push(result);
  return merged;
}

/**
 * Durably record an action result while the task is mid-completion, so a crash
 * or lease expiry after a side-effecting HUB call still leaves the persisted
 * record behind (HUB closure is non-idempotent; the persisted `closed` record
 * is our dedupe on lease-recovery retries). Merges `result` into `priorResults`
 * rather than replacing them, and — when the completion lease is known — pins
 * the write to that exact lease so a stale executor cannot checkpoint after its
 * lease was reclaimed.
 * @param {object} opts
 * @param {(result: AppActionResult) => Promise<void>} [opts.onCheckpoint]
 * @param {string} opts.tableName
 * @param {string} opts.siteId
 * @param {string} opts.taskId
 * @param {AppActionResult} opts.result
 * @param {AppActionResult[]} opts.priorResults
 * @param {string} [opts.completionLeaseExpiresAt]
 * @param {{ status: string, attribute: string, value: string }} [opts.executionLease]
 * @param {string} opts.updatedAt
 * @returns {Promise<void>}
 */
async function checkpoint311ActionResult({
  tableName,
  siteId,
  taskId,
  result,
  priorResults,
  completionLeaseExpiresAt,
  executionLease,
  updatedAt,
  onCheckpoint,
}) {
  if (onCheckpoint) return onCheckpoint(result);
  if (!tableName || !siteId || !taskId) return;
  const lease =
    executionLease ??
    (completionLeaseExpiresAt
      ? {
          status: "completing",
          attribute: "completionLeaseExpiresAt",
          value: completionLeaseExpiresAt,
        }
      : null);
  await ddb.send(
    new UpdateCommand({
      TableName: tableName,
      Key: taskKey(siteId, taskId),
      UpdateExpression:
        "SET appActionResults = :results, appActionStatus = :status, updatedAt = :updatedAt",
      ConditionExpression: executionLease
        ? "#status = :executionStatus AND #lease = :leaseExpiresAt"
        : completionLeaseExpiresAt
          ? "#status = :completing AND #lease = :leaseExpiresAt"
          : "#status = :completing",
      ExpressionAttributeNames: {
        "#status": "status",
        ...(lease ? { "#lease": lease.attribute } : {}),
      },
      ExpressionAttributeValues: {
        ":results": mergeAppActionResults(priorResults, result),
        ":status": summarizeAppActionResults([result]),
        ":updatedAt": updatedAt,
        ":completing": "completing",
        ...(lease
          ? {
              ":leaseExpiresAt": lease.value,
              ...(executionLease ? { ":executionStatus": lease.status } : {}),
            }
          : {}),
      },
    }),
  );
}

/**
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 * @returns {boolean}
 */
export function is311SubmissionEnabled(env = process.env) {
  return env.GNP_311_SUBMISSION_ENABLED === "true";
}

/**
 * When on, a "File 311 ticket" tap queues the filing for the background
 * worker instead of calling HUB inside the API request.
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 * @returns {boolean}
 */
export function is311AsyncFilingEnabled(env = process.env) {
  return env.GNP_311_ASYNC_FILING === "true";
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
 * `Number(null)` and `Number("")` are 0, so blanks must be rejected first.
 * @param {unknown} value
 * @returns {number | null}
 */
function finiteNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * A usable point, or null. 0,0 is the analyzer's placeholder for a photo
 * without device location, never a real place to send a 311 crew.
 * @param {Record<string, unknown>} item
 * @returns {{ latitude: number, longitude: number } | null}
 */
function coordinates(item) {
  const latitude = finiteNumber(item.latitude ?? item.Latitude);
  const longitude = finiteNumber(item.longitude ?? item.Longitude);
  if (latitude === null || longitude === null) return null;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  if (latitude === 0 && longitude === 0) return null;
  return { latitude, longitude };
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
    const location = coordinates(
      /** @type {Record<string, unknown>} */ (source),
    );
    if (location) return location;
  }
  return null;
}

/**
 * @param {object} opts
 * @param {string} opts.tableName
 * @param {string} opts.siteId
 * @param {Record<string, unknown>} opts.task
 * @param {Record<string, unknown>[]} opts.artifacts the task's source ART# rows
 * @returns {Promise<{ latitude: number, longitude: number } | null>}
 */
async function resolveLocation({ tableName, siteId, task, artifacts }) {
  const taskLocation = locationFromTask(task);
  if (taskLocation) return taskLocation;
  // A location sent after upload can land after the task was written.
  for (const artifact of artifacts) {
    const location = coordinates(artifact);
    if (location) return location;
  }

  const site = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: siteMetaKey(siteId),
      ConsistentRead: true,
    }),
  );
  const location =
    site.Item?.location && typeof site.Item.location === "object"
      ? /** @type {Record<string, unknown>} */ (site.Item.location)
      : {};
  const siteLocation = coordinates(location);
  if (siteLocation) {
    // Shows how often 311 gets the site's address, not the photo's (#560).
    emitMetrics({
      marker: "LocationFallbackToSite",
      metrics: [{ name: "LocationFallbackToSite", value: 1 }],
      props: {
        siteId,
        taskId: String(task.taskId ?? ""),
        checkId: String(task.checkId ?? ""),
      },
    });
  }
  return siteLocation;
}

/**
 * @param {object} opts
 * @param {string} opts.tableName
 * @param {string} opts.siteId
 * @param {Record<string, unknown>} opts.task
 * @param {import("../../config.js").AppConfig} opts.config
 * @returns {Promise<import("../analyzer-client.js").ClassifierEvidence>}
 */
async function loadClassifierEvidence({ tableName, siteId, task, config }) {
  const artifactIds = new Set(
    /** @type {string[]} */ (task.sourceArtifactIds ?? []),
  );
  if (!task.checkId || artifactIds.size === 0) {
    throw new Error(
      "No source image or text is available for 311 classifier analysis",
    );
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
  const artifacts = (result.Items ?? []).filter((item) =>
    artifactIds.has(String(item.artifactId ?? "")),
  );
  const imageArtifact = artifacts.find(
    (item) =>
      typeof item.s3Key === "string" &&
      typeof item.contentType === "string" &&
      String(item.contentType).startsWith("image/"),
  );
  if (imageArtifact) {
    const object = await getObjectBytes({
      bucket: config.uploadBucket,
      key: String(imageArtifact.s3Key),
    });
    const downscaled = await downscaleImage(
      object.bytes,
      String(object.contentType || imageArtifact.contentType),
    );
    const contentType = downscaled.contentType;
    if (!["image/jpeg", "image/png", "image/webp"].includes(contentType)) {
      throw new Error(
        `Unsupported classifier image content type: ${contentType}`,
      );
    }
    return {
      type: "image",
      image: {
        content_type: /** @type {"image/jpeg" | "image/png" | "image/webp"} */ (
          contentType
        ),
        base64: downscaled.bytes.toString("base64"),
      },
    };
  }
  const textArtifact = artifacts.find(
    (item) => typeof item.text === "string" && item.text.trim().length > 0,
  );
  if (textArtifact) {
    return { type: "text", text: String(textArtifact.text).trim() };
  }
  throw new Error(
    "No source image or text is available for 311 classifier analysis",
  );
}

/**
 * @param {object} opts
 * @param {string} opts.tableName
 * @param {string} opts.siteId
 * @param {Record<string, unknown>} opts.task
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function sourceArtifactsForTask({ tableName, siteId, task }) {
  const artifactIds = new Set(
    /** @type {string[]} */ (task.sourceArtifactIds ?? []),
  );
  if (!task.checkId || artifactIds.size === 0) return [];
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
  return (result.Items ?? []).filter((item) =>
    artifactIds.has(String(item.artifactId ?? "")),
  );
}

/**
 * @param {object} opts
 * @param {ReturnType<typeof createSf311Client>} opts.sf311
 * @param {import("../../config.js").AppConfig} opts.config
 * @param {string | null} opts.srNum
 * @param {Array<{ artifactId: string, s3Key: string }>} opts.artifacts
 * @param {unknown} [opts.priorAttachments]
 * @param {Date} opts.nowDate
 * @param {(attachments: Array<Record<string, unknown>>) => Promise<void>} [opts.onCheckpoint]
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
export async function attachImagesToServiceRequest({
  sf311,
  config,
  srNum,
  artifacts,
  priorAttachments,
  nowDate,
  onCheckpoint,
}) {
  const submittedPriorAttachments = submittedAttachmentsByKey(priorAttachments);
  if (!srNum) {
    return artifacts.map((artifact) => ({
      ...artifact,
      status: "skipped",
      reason: "missing_srnum",
    }));
  }

  const prior = Array.isArray(priorAttachments) ? priorAttachments : [];
  const attachments = [...prior];
  /** @param {Record<string, unknown>} entry */
  const save = async (entry) => {
    const index = attachments.findIndex(
      (item) => attachmentKey(item) === attachmentKey(entry),
    );
    if (index < 0) attachments.push(entry);
    else attachments[index] = entry;
    if (onCheckpoint) await onCheckpoint([...attachments]);
  };
  for (const artifact of artifacts) {
    const priorAttachment =
      submittedPriorAttachments.get(attachmentKey(artifact)) ??
      submittedPriorAttachments.get(artifact.s3Key);
    if (priorAttachment) continue;
    const pending = prior.find(
      (item) =>
        attachmentKey(item) === attachmentKey(artifact) &&
        item.status === "pending",
    );
    if (pending) {
      let accepted = false;
      try {
        accepted = hasServiceRequestAttachment(
          await sf311.getLatestUpdatesBySourceAgency(),
          srNum,
          String(pending.urlHash),
        );
      } catch {
        /* Unavailable evidence must never cause a blind resend. */
      }
      await save({
        ...pending,
        ...(accepted
          ? { status: "submitted", reconciled: true }
          : { reason: "sf311_attachment_uncertain_requires_reconciliation" }),
      });
      continue;
    }
    let imageUrl;
    try {
      imageUrl = await create311MediaLink({ config, key: artifact.s3Key });
    } catch (error) {
      await save({
        ...artifact,
        status: "failed",
        reason: appActionErrorReason(error),
      });
      continue;
    }
    // Persist intent before sending. Keep a hash, never the bearer media URL.
    const intent = {
      ...artifact,
      status: "pending",
      urlHash: createHash("sha256").update(imageUrl).digest("hex"),
    };
    if (onCheckpoint) await save(intent);
    let outcome;
    try {
      const response = await sf311.updateServiceRequest(
        buildAttachmentUpdatePayload({ srNum, imageUrl, now: nowDate }),
      );
      outcome = {
        ...artifact,
        status: "submitted",
        updateId: response.updateId,
      };
    } catch (error) {
      outcome = {
        ...(onCheckpoint ? intent : artifact),
        status: onCheckpoint ? "pending" : "failed",
        reason: onCheckpoint
          ? "sf311_attachment_uncertain_requires_reconciliation"
          : appActionErrorReason(error),
        ...(!onCheckpoint && appActionErrorDiagnostics(error)
          ? { diagnostics: appActionErrorDiagnostics(error) }
          : {}),
      };
    }
    // A failed durable write must abort rather than advance to the next image.
    await save(outcome);
  }
  return attachments;
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
 * @param {"task_created" | "user_confirmed" | undefined} opts.trigger
 * @param {string} [opts.completionLeaseExpiresAt]
 * @param {(result: AppActionResult) => Promise<void>} [opts.onCheckpoint]
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
  trigger,
  onCheckpoint,
  completionLeaseExpiresAt = "",
}) {
  const now = nowDate.toISOString();
  const priorTickets = priorTicketsByServiceCode(priorResults, action.code);

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
    const evidence = await loadClassifierEvidence({
      tableName,
      siteId,
      task,
      config,
    });
    const result = /** @type {{ labels?: unknown }} */ (
      await analyzer.classifyEvidence({
        classifierId: parsed.classifierId,
        evidence,
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
  if (serviceCodes.length === 0) {
    return {
      code: action.code,
      status: "failed",
      reason:
        parsed.kind === "classifier"
          ? "insufficient_classifier_information"
          : "no_service_codes",
      payload: action.payload ?? {},
      recordedAt: now,
    };
  }

  const artifacts = await sourceArtifactsForTask({ tableName, siteId, task });
  const location = await resolveLocation({
    tableName,
    siteId,
    task,
    artifacts,
  });
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
  const imageArtifacts = artifacts
    .filter(
      (item) =>
        typeof item.s3Key === "string" &&
        typeof item.contentType === "string" &&
        String(item.contentType).startsWith("image/"),
    )
    .map((item) => ({
      artifactId: String(item.artifactId),
      s3Key: String(item.s3Key),
    }));
  /** @type {Array<Record<string, unknown>>} */
  const tickets = [];
  for (const serviceCode of serviceCodes) {
    const priorTicket = priorTickets.get(serviceCode);
    if (priorTicket) {
      const attachments = await attachImagesToServiceRequest({
        sf311,
        config,
        srNum: String(priorTicket.srNum),
        artifacts: imageArtifacts,
        priorAttachments: priorTicket.attachments,
        nowDate,
        onCheckpoint: onCheckpoint
          ? (attachments) =>
              onCheckpoint(
                build311ActionResult({
                  action,
                  status: "partial",
                  reason: "attachments_pending",
                  recordedAt: now,
                  tickets: [...tickets, { ...priorTicket, attachments }],
                }),
              )
          : undefined,
      });
      tickets.push({ ...priorTicket, attachments });
      continue;
    }
    const actionPayload = /** @type {{ responsibleAgencyCode?: unknown }} */ (
      action.payload ?? {}
    );
    try {
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
      if (onCheckpoint) {
        const uncertain = priorResults
          .flatMap(ticketsFromActionResult)
          .some(
            (ticket) =>
              ticket.serviceCode === serviceCode &&
              !ticket.srNum &&
              ticket.creationState === "pending",
          );
        if (uncertain)
          throw new Error("sf311_creation_uncertain_requires_reconciliation");
        await onCheckpoint(
          build311ActionResult({
            action,
            status: "partial",
            reason: "creation_pending",
            recordedAt: now,
            tickets: [
              ...tickets,
              {
                serviceCode,
                responsibleAgency,
                sourceRequestId: payload.SourceRequestID,
                creationState: "pending",
              },
            ],
          }),
        );
      }
      let response;
      try {
        response = await sf311.createServiceRequest(payload);
      } catch (error) {
        // HUB answered and created nothing. Durably replacing the pending
        // checkpoint before rethrowing lets the next attempt file again, even
        // if this run stops before the caller records its result.
        if (onCheckpoint && isCreateSrRejection(error)) {
          tickets.push({
            serviceCode,
            responsibleAgency,
            sourceRequestId: payload.SourceRequestID,
            creationState: "rejected",
          });
          await onCheckpoint(
            build311ActionResult({
              action,
              status: "partial",
              reason: "creation_rejected",
              recordedAt: now,
              tickets,
            }),
          );
        }
        throw error;
      }
      if (onCheckpoint)
        await onCheckpoint(
          build311ActionResult({
            action,
            status: "partial",
            reason: "attachments_pending",
            recordedAt: now,
            tickets: [
              ...tickets,
              {
                serviceCode,
                responsibleAgency,
                sourceRequestId: payload.SourceRequestID,
                srNum: response.srNum,
                attachments: [],
              },
            ],
          }),
        );
      const attachments = await attachImagesToServiceRequest({
        sf311,
        config,
        srNum: response.srNum,
        artifacts: imageArtifacts,
        nowDate,
        onCheckpoint: onCheckpoint
          ? (attachments) =>
              onCheckpoint(
                build311ActionResult({
                  action,
                  status: "partial",
                  reason: "attachments_pending",
                  recordedAt: now,
                  tickets: [
                    ...tickets,
                    {
                      serviceCode,
                      responsibleAgency,
                      sourceRequestId: payload.SourceRequestID,
                      srNum: response.srNum,
                      attachments,
                    },
                  ],
                }),
              )
          : undefined,
      });
      tickets.push({
        serviceCode,
        responsibleAgency,
        sourceRequestId: payload.SourceRequestID,
        srNum: response.srNum,
        attachments,
      });
      if (trigger === "user_confirmed" || onCheckpoint) {
        await checkpoint311ActionResult({
          tableName,
          siteId,
          taskId: String(task.taskId ?? ""),
          result: build311ActionResult({
            action,
            status: "failed",
            reason: "fanout_incomplete",
            recordedAt: now,
            tickets,
          }),
          priorResults,
          completionLeaseExpiresAt: completionLeaseExpiresAt,
          onCheckpoint,
          updatedAt: now,
        });
      }
    } catch (error) {
      return build311ActionResult({
        action,
        status: "failed",
        reason: appActionErrorReason(error),
        diagnostics: appActionErrorDiagnostics(error),
        recordedAt: now,
        tickets,
      });
    }
  }
  if (tickets.some((ticket) => hasIncompleteAttachment(ticket.attachments))) {
    return build311ActionResult({
      action,
      status: "failed",
      reason: "attachment_submission_failed",
      recordedAt: now,
      tickets,
    });
  }

  return build311ActionResult({
    action,
    status: "submitted",
    recordedAt: now,
    tickets,
  });
}

/**
 * CreateSR got a definite "no" from HUB (a non-zero return code or a 4xx), so
 * no SR exists. Timeouts, network errors, 5xx and a missing SRNum stay
 * uncertain: HUB may have created the SR.
 * @param {unknown} error
 * @returns {boolean}
 */
function isCreateSrRejection(error) {
  return (
    error instanceof Sf311Error &&
    error.code !== "sf311_timeout" &&
    error.code !== "missing_srnum" &&
    typeof error.status === "number" &&
    error.status < 500
  );
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
 * Tickets this app is allowed to close: informational tickets we filed under
 * our own agency (76) and reached `submitted` state. City-managed tickets
 * (filed on user confirmation under a looked-up agency) are never closed by
 * us. Already-closed tickets stay in the map so the executor can carry their
 * closure records forward without re-calling HUB.
 * @param {AppActionResult[]} priorResults
 * @returns {Map<string, { ticket: Record<string, unknown>, closedReasonCode: string }>}
 */
export function eligibleTicketsForClosure(priorResults) {
  const eligible = new Map();
  for (const result of priorResults) {
    if (result.code !== "create_311_ticket") continue;
    if (result.status !== "submitted") continue;
    for (const ticket of ticketsFromActionResult(result)) {
      const serviceCode = String(ticket.serviceCode ?? "");
      if (!serviceCode || !ticket.srNum) continue;
      if (String(ticket.responsibleAgency ?? "") !== GOOD_NEIGHBOR_AGENCY) {
        continue;
      }
      eligible.set(serviceCode, {
        ticket,
        closedReasonCode: SILENT_TICKET_CLOSED_REASON,
      });
    }
  }
  return eligible;
}

/**
 * @param {object} opts
 * @param {AppAction} opts.action
 * @param {string} opts.status
 * @param {string} opts.recordedAt
 * @param {Array<Record<string, unknown>>} opts.closures
 * @param {string} [opts.reason]
 * @param {Record<string, unknown>} [opts.diagnostics]
 * @returns {AppActionResult}
 */
function buildCloseActionResult({
  action,
  status,
  recordedAt,
  closures,
  reason,
  diagnostics,
}) {
  return {
    code: action.code,
    status,
    ...(reason ? { reason } : {}),
    payload: { ...(action.payload ?? {}), closures },
    ...(diagnostics ? { diagnostics } : {}),
    recordedAt,
  };
}

/**
 * @param {object} opts
 * @param {AppAction} opts.action
 * @param {AppActionResult[]} opts.priorResults
 * @param {import("../../config.js").AppConfig} opts.config
 * @param {Date} opts.nowDate
 * @param {string} [opts.tableName]
 * @param {string} [opts.siteId]
 * @param {string} [opts.taskId]
 * @param {string} [opts.completionLeaseExpiresAt]
 * @param {{ status: string, attribute: string, value: string }} [opts.executionLease]
 * @param {boolean} [opts.reconcile311Closures]
 * @param {(result: AppActionResult) => Promise<void>} [opts.onCheckpoint]
 * @returns {Promise<AppActionResult>}
 */
async function execute311ClosureAction({
  action,
  priorResults,
  config,
  nowDate,
  tableName = "",
  siteId = "",
  taskId = "",
  completionLeaseExpiresAt = "",
  executionLease,
  reconcile311Closures = false,
  onCheckpoint,
}) {
  const now = nowDate.toISOString();
  const priorClosuresByServiceCode =
    priorClosuresFromPriorResults(priorResults);
  const eligible = eligibleTicketsForClosure(priorResults);

  if (eligible.size === 0) {
    return {
      code: action.code,
      status: "recorded",
      payload: { closures: [] },
      recordedAt: now,
    };
  }

  const sf311 = createSf311Client({ config });
  let latestUpdates;
  const needsReconciliation =
    reconcile311Closures &&
    [...eligible].some(
      ([serviceCode]) =>
        priorClosuresByServiceCode.get(serviceCode)?.status !== "closed",
    );
  if (needsReconciliation) {
    try {
      latestUpdates = await sf311.getLatestUpdatesBySourceAgency();
    } catch (error) {
      return buildCloseActionResult({
        action,
        status: "failed",
        recordedAt: now,
        closures: [...eligible].map(([serviceCode, { ticket }]) => ({
          serviceCode,
          srNum: String(ticket.srNum),
          closedReasonCode: SILENT_TICKET_CLOSED_REASON,
          status: "failed",
          reason: "sf311_closure_reconciliation_failed",
        })),
        diagnostics: appActionErrorDiagnostics(error),
      });
    }
  }
  /** @type {Array<Record<string, unknown>>} */
  const closures = [];
  /** Persist the current closure accumulator while this executor owns the lease. */
  const checkpoint = async () => {
    if (!tableName || !siteId || !taskId) return true;
    try {
      await checkpoint311ActionResult({
        tableName,
        siteId,
        taskId,
        completionLeaseExpiresAt,
        executionLease,
        onCheckpoint,
        result: buildCloseActionResult({
          action,
          status: closures.every((closure) => closure.status === "closed")
            ? "submitted"
            : "partial",
          recordedAt: now,
          closures: [...closures],
        }),
        priorResults,
        updatedAt: now,
      });
      return true;
    } catch {
      return false;
    }
  };
  for (const [serviceCode, { ticket }] of eligible) {
    const priorClosure = priorClosuresByServiceCode.get(serviceCode);
    // Already closed on an earlier attempt: carry the record forward without
    // another UpdateSR call (HUB closure is not idempotent on its side).
    if (priorClosure && priorClosure.status === "closed") {
      closures.push({ ...priorClosure });
      continue;
    }
    if (needsReconciliation) {
      const closureState = serviceRequestClosureState(
        latestUpdates,
        String(ticket.srNum),
      );
      if (closureState === "closed") {
        const closedReasonCode = serviceRequestClosureReason(
          latestUpdates,
          String(ticket.srNum),
        );
        closures.push({
          serviceCode,
          srNum: String(ticket.srNum),
          ...(closedReasonCode ? { closedReasonCode } : {}),
          status: "closed",
          reconciled: true,
        });
        if (!(await checkpoint())) break;
        continue;
      }
      if (closureState === "unknown") {
        closures.push({
          serviceCode,
          srNum: String(ticket.srNum),
          closedReasonCode: SILENT_TICKET_CLOSED_REASON,
          status: "failed",
          reason: "sf311_closure_state_unknown",
        });
        continue;
      }
    }
    try {
      const payload = buildCloseSrPayload({
        srNum: String(ticket.srNum),
        now: nowDate,
      });
      const response = await sf311.updateServiceRequest(payload);
      closures.push({
        serviceCode,
        srNum: String(ticket.srNum),
        closedReasonCode: SILENT_TICKET_CLOSED_REASON,
        status: "closed",
        ...(response.updateId ? { updateId: response.updateId } : {}),
      });
      // Persist the closed record immediately: HUB closure is non-idempotent,
      // so if this process dies (or the lease is lost) before the final task
      // write, lease recovery must see `closed` here instead of re-closing
      // the same SR from the original CreateSR result.
      // If the lease was reclaimed, stop issuing further HUB updates because
      // this in-memory closure is not durably visible to the next executor.
      if (!(await checkpoint())) break;
    } catch (error) {
      closures.push({
        serviceCode,
        srNum: String(ticket.srNum),
        closedReasonCode: SILENT_TICKET_CLOSED_REASON,
        status: "failed",
        reason: appActionErrorReason(error),
        ...(appActionErrorDiagnostics(error)
          ? { diagnostics: appActionErrorDiagnostics(error) }
          : {}),
      });
    }
  }

  const allTicketsProcessed = closures.length === eligible.size;
  if (
    allTicketsProcessed &&
    closures.every((closure) => closure.status === "closed")
  ) {
    return buildCloseActionResult({
      action,
      status: "submitted",
      recordedAt: now,
      closures,
    });
  }
  if (closures.some((closure) => closure.status === "closed")) {
    return buildCloseActionResult({
      action,
      status: "partial",
      recordedAt: now,
      closures,
    });
  }
  return buildCloseActionResult({
    action,
    status: "failed",
    recordedAt: now,
    closures,
  });
}

/**
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {unknown}
 */
function sanitizeDiagnosticValue(value, depth = 0) {
  if (depth > 4) return "[truncated]";
  if (value == null) return value;
  if (typeof value === "string") {
    const redacted = redactSignedUrl(value);
    return redacted.length > 1000 ? `${redacted.slice(0, 1000)}...` : redacted;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value
      .slice(0, 20)
      .map((item) => sanitizeDiagnosticValue(item, depth + 1));
  }
  if (typeof value === "object") {
    /** @type {Record<string, unknown>} */
    const sanitized = {};
    for (const [key, item] of Object.entries(
      /** @type {Record<string, unknown>} */ (value),
    ).slice(0, 60)) {
      const safeKey = redactSignedUrl(key);
      if (/authorization|password|secret|token|api[-_]?key/i.test(key)) {
        sanitized[safeKey] = "[redacted]";
      } else {
        sanitized[safeKey] = sanitizeDiagnosticValue(item, depth + 1);
      }
    }
    return sanitized;
  }
  return String(value);
}

/**
 * @param {string} value
 * @returns {string}
 */
function redactSignedUrl(value) {
  // Decode escaped query separators in diagnostic echoes before redaction.
  // Never decode or mutate the actual outbound SF311 payload.
  let text = value;
  let previous;
  do {
    previous = text;
    text = text
      .replace(/%([0-9a-f]{2})/gi, (_, hex) =>
        String.fromCharCode(parseInt(hex, 16)),
      )
      .replace(/&amp;|&#0*38;|&#x0*26;/gi, "&")
      .replace(/\\u00([0-9a-f]{2})/gi, (_, hex) =>
        String.fromCharCode(parseInt(hex, 16)),
      );
  } while (text !== previous);
  return text.replace(
    /([?&](?:token|X-Amz-(?:Credential|Signature|Security-Token))=)[^&\s"'<>\\]*/gi,
    "$1[redacted]",
  );
}

/**
 * @param {unknown} error
 * @returns {Record<string, unknown> | undefined}
 */
function appActionErrorDiagnostics(error) {
  if (error instanceof Sf311Error) {
    return {
      integration: "sf311",
      ...(error.status ? { status: error.status } : {}),
      ...(error.code ? { code: error.code } : {}),
      ...(error.request !== undefined
        ? { request: sanitizeDiagnosticValue(error.request) }
        : {}),
      ...(error.body !== undefined
        ? { body: sanitizeDiagnosticValue(error.body) }
        : {}),
    };
  }
  return undefined;
}

/**
 * @param {AppAction[]} appActions
 * @param {"task_created" | "user_confirmed" | undefined} trigger
 * @returns {AppAction[]}
 */
function actionsForTrigger(appActions, trigger) {
  if (!trigger) return appActions;
  return appActions.filter((action) => {
    const actionTrigger = /** @type {{ executionTrigger?: unknown }} */ (
      action.payload ?? {}
    ).executionTrigger;
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
 * @param {string} [opts.completionLeaseExpiresAt]
 * @param {{ status: string, attribute: string, value: string }} [opts.executionLease]
 * @param {boolean} [opts.reconcile311Closures]
 * @param {(result: AppActionResult) => Promise<void>} [opts.onCheckpoint]
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
              trigger: opts.trigger,
              onCheckpoint: opts.onCheckpoint,
              completionLeaseExpiresAt: opts.completionLeaseExpiresAt ?? "",
            }),
          );
        } catch (error) {
          const diagnostics = appActionErrorDiagnostics(error);
          results.push({
            code: action.code,
            status: "failed",
            reason: appActionErrorReason(error),
            payload,
            ...(diagnostics ? { diagnostics } : {}),
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
      case "close_311_ticket":
        try {
          results.push(
            await execute311ClosureAction({
              action,
              priorResults,
              config: getConfig(/** @type {NodeJS.ProcessEnv} */ (env)),
              nowDate,
              tableName: opts.tableName ?? "",
              siteId: opts.siteId ?? "",
              taskId: opts.taskId ?? "",
              completionLeaseExpiresAt: opts.completionLeaseExpiresAt ?? "",
              executionLease: opts.executionLease,
              reconcile311Closures: opts.reconcile311Closures,
              onCheckpoint: opts.onCheckpoint,
            }),
          );
        } catch (error) {
          const diagnostics = appActionErrorDiagnostics(error);
          results.push({
            code: action.code,
            status: "failed",
            reason: appActionErrorReason(error),
            payload,
            ...(diagnostics ? { diagnostics } : {}),
            recordedAt: now,
          });
        }
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
