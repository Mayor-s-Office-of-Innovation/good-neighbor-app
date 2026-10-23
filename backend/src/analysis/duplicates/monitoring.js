import { emitMetrics } from "../../lib/metrics.js";
/** Strict allowlist: never log images, S3 keys, descriptions, prompts or model narratives.
 * @param {string} event @param {Record<string,unknown>} values @param {import('../../lib/metrics.js').MetricValue[]} [metrics]
 */
export function duplicateEvent(event, values, metrics = []) {
  if (
    ![
      "comparison",
      "issue_result",
      "search_complete",
      "linked",
      "separated",
      "worker_complete",
      "worker_failed",
    ].includes(event)
  )
    return;
  /** @type {Record<string,unknown>} */ const props = {
    event: `duplicate_${event}`,
  };
  for (const key of [
    "errorName",
    "messageId",
    "siteId",
    "observationId",
    "candidateId",
    "conditionId",
    "candidateConditionId",
    "taskId",
    "originalTaskId",
    "modelId",
    "matcherVersion",
    "comparisonVersion",
  ]) {
    const value = values[key];
    if (typeof value === "string" && /^[A-Za-z0-9_.:/-]{1,200}$/.test(value))
      props[key] = value;
  }
  const enums = {
    outcome: [
      "matched",
      "no_match",
      "no_match_with_failures",
      "uncertain",
      "failed",
      "pending",
      "complete",
      "retrying",
    ],
    jobKind: ["prepare", "reconcile", "compare"],
    confidence: ["high", "medium", "low"],
    evidenceKind: ["image", "mixed", "text"],
    phase: ["fast", "background"],
  };
  for (const [key, allowed] of Object.entries(enums))
    if (allowed.includes(String(values[key]))) props[key] = values[key];
  for (const key of [
    "attempt",
    "elapsedMs",
    "queueMs",
    "totalMs",
    "failedCandidates",
    "candidateCount",
    "cacheHits",
    "firstMatchMs",
  ])
    if (
      typeof values[key] === "number" &&
      Number.isFinite(values[key]) &&
      values[key] >= 0
    )
      props[key] = values[key];
  emitMetrics({
    marker: `Duplicate${event
      .split("_")
      .map((part) => part[0].toUpperCase() + part.slice(1))
      .join("")}`,
    metrics,
    props,
  });
}
