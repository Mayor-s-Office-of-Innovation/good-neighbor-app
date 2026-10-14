import { createHash } from "node:crypto";

/**
 * Changes to background translations do not create duplicate work.
 * @param {Record<string, import("@aws-sdk/util-dynamodb").NativeAttributeValue>} analysis
 * @returns {string}
 */
export function analysisRevision(analysis) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        analysisId: analysis.analysisId,
        status: analysis.status,
        concerns: (analysis.concerns ?? []).map(
          (
            /** @type {Record<string, import("@aws-sdk/util-dynamodb").NativeAttributeValue>} */ c,
          ) => ({
            conditionId: c.conditionId,
            category: c.category,
            rating: c.rating,
            explanation: c.explanation,
            evidenceIndices: c.evidenceIndices,
          }),
        ),
      }),
    )
    .digest("hex");
}
/**
 * @param {Record<string, import("@aws-sdk/util-dynamodb").NativeAttributeValue>|undefined} previous
 * @param {Record<string, import("@aws-sdk/util-dynamodb").NativeAttributeValue>} current
 * @returns {boolean}
 */
export function needsDuplicateJob(previous, current) {
  return (
    current.status === "analyzed" &&
    typeof current.checkId === "string" &&
    typeof current.artifactId === "string" &&
    (!previous || analysisRevision(previous) !== analysisRevision(current))
  );
}
/**
 * @param {string} checkId
 * @param {string} artifactId
 * @returns {string}
 */
export const observationId = (checkId, artifactId) =>
  `${checkId}:${artifactId}`;
/**
 * @param {string} siteId
 * @param {string} capturedAt
 * @param {string} id
 * @returns {{pk:string,sk:string}}
 */
export const projectionKey = (siteId, capturedAt, id) => ({
  pk: `SITE#${siteId}`,
  sk: `DUP_OBSERVATION#${new Date(capturedAt).toISOString()}#${id}`,
});
