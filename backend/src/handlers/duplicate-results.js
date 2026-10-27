import { findOriginalIssue } from "../analysis/duplicates/original-issue.js";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../db.js";
import { getConfig } from "../config.js";
import { deriveSiteId } from "../lib/principal.js";
import { jsonResponse } from "../http.js";
import {
  analysisRevision,
  projectionKey,
} from "../analysis/duplicates/jobs.js";
import {
  normalizeConditionOutcome,
  pendingConditions,
  processingState,
} from "../analysis/duplicates/result-state.js";
/**
 * Independent polling endpoint; never invokes the analyzer or prepares images.
 * @type {import('aws-lambda').APIGatewayProxyHandlerV2WithJWTAuthorizer}
 */
export const getDuplicateResult = async (event) => {
  const { dynamoTable } = getConfig();
  const siteId = deriveSiteId(event);
  const { checkId, artifactId } = event.pathParameters ?? {};
  if (!checkId || !artifactId)
    return jsonResponse(400, { error: "Missing check or artifact ID" });
  const pk = `SITE#${siteId}`;
  /**
   * @param {{pk:string,sk:string}} Key
   * @returns {Promise<Record<string,import("@aws-sdk/util-dynamodb").NativeAttributeValue>|undefined>}
   */
  const get = async (Key) =>
    (
      await ddb.send(
        new GetCommand({ TableName: dynamoTable, Key, ConsistentRead: true }),
      )
    ).Item;
  const artifact = await get({ pk, sk: `CHECK#${checkId}#ART#${artifactId}` });
  if (!artifact) return jsonResponse(404, { error: "Artifact not found" });
  if (process.env.DUPLICATE_DETECTION_ENABLED !== "true")
    return jsonResponse(200, {
      processingState: "disabled",
      possibleDuplicate: null,
      conditionResults: [],
    });
  const analysis = await get({
    pk,
    sk: `CHECK#${checkId}#ANALYSIS#${artifactId}`,
  });
  if (!analysis || analysis.status !== "analyzed")
    return jsonResponse(200, {
      processingState: "awaiting_analysis",
      possibleDuplicate: null,
      conditionResults: [],
    });
  const revision = analysisRevision(analysis),
    id = `${checkId}:${artifactId}`;
  const result = await get({ pk, sk: `DUP_RESULT#${id}#${revision}` });
  const sourceProjection =
    (analysis.generatedAt ?? analysis.analyzedAt)
      ? await get(
          projectionKey(
            siteId,
            analysis.generatedAt ?? analysis.analyzedAt,
            id,
          ),
        )
      : undefined;
  const conditions = pendingConditions(
    (analysis.concerns ?? [])
      .filter(
        (/** @type {{rating:number,conditionId?:string}} */ c) =>
          c.rating > 0 && c.conditionId,
      )
      .map((/** @type {{conditionId:string}} */ c) => ({ id: c.conditionId })),
  );
  if (!conditions.length || sourceProjection?.resolvedAt)
    return jsonResponse(200, {
      processingState: "complete",
      possibleDuplicate: null,
      conditionResults: conditions.map((c) => ({
        ...c,
        status: "insufficient_evidence",
      })),
      reason: sourceProjection?.resolvedAt
        ? "source_resolved"
        : "no_conditions",
      shadow: false,
    });
  for (let i = 0; i < conditions.length; i++) {
    const pending = conditions[i];
    const saved = result?.conditionResults?.find(
      (/** @type {{conditionId:string}} */ c) =>
        c.conditionId === pending.conditionId,
    );
    const incremental = await get({
      pk,
      sk: `DUP_ISSUE#${id}#${revision}#${pending.conditionId}`,
    });
    let row = saved ?? pending;
    if (
      incremental?.possibleDuplicate === true &&
      (!result?.invalidatedAt || incremental.updatedAt > result.invalidatedAt)
    )
      row = incremental;
    if (row.possibleDuplicate === true) {
      const targetProjection = incremental?.targetProjectionKey
        ? await get(incremental.targetProjectionKey)
        : undefined;
      const targetArtifact = incremental?.targetArtifactKey
        ? await get(incremental.targetArtifactKey)
        : undefined;
      const targetAnalysis = incremental?.targetAnalysisKey
        ? await get(incremental.targetAnalysisKey)
        : undefined;
      if (
        !sourceProjection ||
        sourceProjection.resolvedAt ||
        sourceProjection.revision !== revision ||
        !targetProjection ||
        targetProjection.resolvedAt ||
        targetProjection.revision !== row.duplicateOf?.revision ||
        !targetArtifact ||
        !targetAnalysis ||
        analysisRevision(targetAnalysis) !== row.duplicateOf?.revision
      )
        row = pending;
    }
    row = normalizeConditionOutcome(row);
    const original =
      row.possibleDuplicate === true && row.duplicateOf
        ? await findOriginalIssue({
            siteId,
            category: analysis.concerns.find(
              (/** @type {{conditionId:string}} */ c) =>
                c.conditionId === row.conditionId,
            )?.category,
            sourceTime: analysis.generatedAt ?? analysis.analyzedAt,
            direct: row.duplicateOf,
            get,
          })
        : { originalIssue: null, originalLookupState: "not_applicable" };
    conditions[i] = {
      ...original,
      conditionId: row.conditionId,
      status: row.status,
      assessmentOutcome: row.assessmentOutcome,
      failedCandidateCount: row.failedCandidateCount,
      possibleDuplicate: row.possibleDuplicate,
      duplicateOf: row.duplicateOf,
      matchStrength: row.matchStrength,
    };
  }
  const hasPositive = conditions.some((c) => c.possibleDuplicate === true);
  const state = processingState(result);
  const stale =
    (state === "complete" || state === "incomplete") &&
    conditions.some((c) => c.status === "pending");
  return jsonResponse(200, {
    sourceRevision: revision,
    processingState: stale
      ? "pending"
      : state === "pending" && hasPositive
        ? "partial"
        : state,
    possibleDuplicate: hasPositive
      ? true
      : conditions.length &&
          conditions.every((c) => c.possibleDuplicate === false)
        ? false
        : null,
    conditionResults: conditions,
    latency: result?.latency ?? null,
    shadow: false,
  });
};
