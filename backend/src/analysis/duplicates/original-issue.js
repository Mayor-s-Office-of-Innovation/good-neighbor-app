import { analysisRevision, projectionKey } from "./jobs.js";
/** @typedef {{observationId:string,conditionId:string,revision:string}} IssueRef */
/** @typedef {Record<string,import('@aws-sdk/util-dynamodb').NativeAttributeValue>} Item */
/**
 * Walk confirmed references only, without model calls or the comparison window.
 * Revalidate every hop; never claim an original after a broken/cyclic chain.
 * @param {{siteId:string,category:string,sourceTime:string,direct:IssueRef,get:(key:{pk:string,sk:string})=>Promise<Item|undefined>}} input
 * @returns {Promise<{originalIssue:IssueRef|null,originalLookupState:string}>}
 */
export async function findOriginalIssue({
  siteId,
  category,
  sourceTime,
  direct,
  get,
}) {
  const pk = `SITE#${siteId}`;
  const seen = new Set();
  let ref = direct;
  let latest = Date.parse(sourceTime);
  for (let depth = 0; depth < 64; depth++) {
    const identity = `${ref.observationId}#${ref.conditionId}#${ref.revision}`;
    if (seen.has(identity)) break;
    seen.add(identity);
    const parts = ref.observationId.split(":");
    if (parts.length !== 2 || !parts.every(Boolean)) break;
    const [checkId, artifactId] = parts;
    const artifact = await get({
      pk,
      sk: `CHECK#${checkId}#ART#${artifactId}`,
    });
    const analysis = await get({
      pk,
      sk: `CHECK#${checkId}#ANALYSIS#${artifactId}`,
    });
    const time = Date.parse(
      analysis?.generatedAt ?? analysis?.analyzedAt ?? "",
    );
    if (
      !artifact ||
      !analysis ||
      analysis.status !== "analyzed" ||
      analysisRevision(analysis) !== ref.revision ||
      !Number.isFinite(time) ||
      time > latest ||
      !analysis.concerns?.some(
        (/** @type {Item} */ c) =>
          c.conditionId === ref.conditionId &&
          c.category === category &&
          c.rating > 0,
      )
    )
      break;
    const projection = await get(
      projectionKey(
        siteId,
        analysis.generatedAt ?? analysis.analyzedAt,
        ref.observationId,
      ),
    );
    if (
      !projection ||
      projection.revision !== ref.revision ||
      (projection.resolvedAt &&
        Date.parse(projection.resolvedAt) <= Date.parse(sourceTime)) ||
      projection.supersededAt
    )
      break;
    const separated = await get({
      pk,
      sk: `DUP_OVERRIDE#${JSON.stringify([checkId, artifactId, ref.conditionId])}`,
    });
    if (separated)
      return { originalIssue: ref, originalLookupState: "complete" };
    const result = await get({
      pk,
      sk: `DUP_RESULT#${ref.observationId}#${ref.revision}`,
    });
    const incremental = await get({
      pk,
      sk: `DUP_ISSUE#${ref.observationId}#${ref.revision}#${ref.conditionId}`,
    });
    const row =
      incremental?.possibleDuplicate === true &&
      (!result?.invalidatedAt || incremental.updatedAt > result.invalidatedAt)
        ? incremental
        : result?.conditionResults?.find(
            (/** @type {Item} */ c) => c.conditionId === ref.conditionId,
          );
    if (
      row?.possibleDuplicate === true &&
      row.matchStrength === "strong" &&
      row.duplicateOf
    ) {
      // Stored keys must not escape the authenticated site partition.
      if (
        incremental?.targetProjectionKey?.pk &&
        incremental.targetProjectionKey.pk !== pk
      )
        break;
      latest = time;
      ref = row.duplicateOf;
      continue;
    }
    // A historical issue with no duplicate work has no confirmed outgoing link.
    // Return the earliest known original; a later confirmed link will extend it.
    if (!result && !incremental)
      return { originalIssue: ref, originalLookupState: "complete" };
    if (row?.possibleDuplicate === false && row.status === "evaluated")
      return { originalIssue: ref, originalLookupState: "complete" };
    return { originalIssue: null, originalLookupState: "pending" };
  }
  return { originalIssue: null, originalLookupState: "invalid_chain" };
}
