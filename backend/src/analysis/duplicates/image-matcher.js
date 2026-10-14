import { createHash } from "node:crypto";

export const IMAGE_MATCHER_VERSION = "issue-evidence-v5";
export const LOOKBACK_MS = 5 * 24 * 60 * 60 * 1000;

/** @typedef {{id:string,description:string,label?:string}} Condition */
/** @typedef {{id:string,siteId?:string,observedAt?:string,availableAt?:string,resolvedAt?:string,supersededAt?:string,sourceId?:string,revision:string,image:{content_type:string,base64:string},conditions?:Condition[],description?:string,location?:object,fingerprint?:string,perceptualHash?:string}} ImageObservation */
/** @typedef {{visual_identity:string,issue_mapping:string,matching_features:string[],visible_differences:string[],contradictions:string[],description_conflict:string,continuity_concern:string}} IssueEvidence */
/** @typedef {{source_condition_id:string,candidate_condition_id:string,evidence:IssueEvidence,confidence?:string,confidenceReasons?:string[]}} IssueMatch */
/** @typedef {{candidate_id:string,verdict:string,evidence_strength:string,reason:string,source_region:string,candidate_region:string,condition_matches:IssueMatch[],evidence:IssueEvidence,confidence?:string,confidenceReasons?:string[],stageDisagreement?:boolean,stage?:string}} Comparison */
/** @typedef {{conditionId:string,status:string,possibleDuplicate:boolean|null,duplicateOf:{observationId:string,conditionId:string,revision:string}|null,matchStrength:string|null}} ConditionOutcome */
/** @typedef {{comparisons:Comparison[],comparison_version:string,model:{model_id:string}}} ComparisonResponse */
/** @typedef {{id:string,image:{content_type:string,base64:string},context?:{conditions:Condition[],description?:string,observedAt?:string,location?:object,visualAssessment?:Comparison}}} Evidence */
/** @typedef {{mode:string,source:Evidence,candidates:Evidence[]}} ComparisonRequest */
/** @typedef {(request:ComparisonRequest)=>Promise<ComparisonResponse>} Compare */

/**
 * @param {Omit<ImageObservation,"image">} source
 * @param {Omit<ImageObservation,"image">[]} observations
 * @returns {Omit<ImageObservation,"image">[]}
 */
export function eligibleImages(source, observations) {
  const observed = Date.parse(source.observedAt ?? "");
  const available = Date.parse(source.availableAt ?? "");
  if (
    !source.siteId ||
    !Number.isFinite(observed) ||
    !Number.isFinite(available)
  ) {
    throw new Error(
      "Production eligibility requires site and valid observation/availability times",
    );
  }
  return observations.filter((candidate) => {
    const capture = Date.parse(candidate.observedAt ?? "");
    return (
      candidate.id !== source.id &&
      candidate.siteId === source.siteId &&
      !(source.sourceId && candidate.sourceId === source.sourceId) &&
      Number.isFinite(capture) &&
      capture <= observed &&
      observed - capture <= LOOKBACK_MS &&
      Date.parse(candidate.availableAt ?? "") <= available &&
      !(candidate.resolvedAt && Date.parse(candidate.resolvedAt) <= observed) &&
      !(
        candidate.supersededAt &&
        Date.parse(candidate.supersededAt) <= available
      )
    );
  });
}

/**
 * Fingerprint identifies evidence reuse, never physical incident continuity.
 * @param {Buffer} bytes
 * @returns {string}
 */
export const imageFingerprint = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
/**
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function hashDistance(a, b) {
  if (!/^[01]{64}$/.test(a) || !/^[01]{64}$/.test(b)) return 64;
  return [...a].reduce(
    (total, bit, index) => total + Number(bit !== b[index]),
    0,
  );
}
/**
 * @param {ImageObservation} observation
 * @param {boolean} context
 * @returns {Evidence}
 */
function evidence(observation, context) {
  return {
    id: observation.id,
    image: observation.image,
    ...(context
      ? {
          context: {
            conditions: observation.conditions ?? [],
            description: observation.description,
            observedAt: observation.observedAt,
            location: observation.location,
          },
        }
      : {}),
  };
}
/** @param {IssueEvidence} value */
function validateEvidence(value) {
  const categories = {
    visual_identity: ["clear", "partial", "unclear"],
    issue_mapping: ["clear", "ambiguous", "none"],
    description_conflict: ["none", "resolved", "unresolved"],
    continuity_concern: [
      "none",
      "unknown",
      "possible_resolution_or_recurrence",
    ],
  };
  if (!value || typeof value !== "object")
    throw new Error("Missing issue evidence");
  for (const [key, values] of Object.entries(categories))
    if (!values.includes(value[/** @type {keyof typeof categories} */ (key)]))
      throw new Error("Invalid evidence category");
  for (const key of /** @type {const} */ ([
    "matching_features",
    "visible_differences",
    "contradictions",
  ]))
    if (
      !Array.isArray(value[key]) ||
      value[key].length > 4 ||
      value[key].some(
        (v) => typeof v !== "string" || !v.trim() || [...v].length > 240,
      )
    )
      throw new Error("Invalid evidence details");
}
/**
 * Evidence bands are policy, not calibrated probabilities.
 * @param {string} verdict
 * @param {IssueEvidence} evidence
 * @param {boolean} [disagreement]
 * @returns {{confidence:string,confidenceReasons:string[]}}
 */
export function assessConfidence(verdict, evidence, disagreement = false) {
  validateEvidence(evidence);
  const reasons = [];
  if (disagreement) reasons.push("Image-only and contextual stages disagree");
  if (verdict === "uncertain") reasons.push("Identity remains uncertain");
  if (evidence.visual_identity === "unclear")
    reasons.push("Visual evidence is unclear");
  if (evidence.contradictions.length)
    reasons.push("Unresolved material contradictions");
  if (evidence.description_conflict === "unresolved")
    reasons.push("Description conflict remains unresolved");
  if (verdict === "same_issue" && evidence.issue_mapping !== "clear")
    reasons.push("Issue mapping is ambiguous");
  if (reasons.length) return { confidence: "low", confidenceReasons: reasons };
  if (evidence.visual_identity === "partial")
    reasons.push("Only partial visual evidence");
  if (verdict === "same_issue" && !evidence.matching_features.length)
    reasons.push("No distinctive matching features recorded");
  if (verdict === "different_issue" && !evidence.visible_differences.length)
    reasons.push("No concrete visual distinction recorded");
  if (verdict === "same_issue" && evidence.continuity_concern !== "none")
    reasons.push(
      evidence.continuity_concern === "unknown"
        ? "Capture/lifecycle evidence does not establish continuity"
        : "Possible cleanup or recurrence",
    );
  return {
    confidence: reasons.length ? "medium" : "high",
    confidenceReasons: reasons.length
      ? reasons
      : ["Clear visual evidence without unresolved conflicts"],
  };
}

/**
 * Never trust a remote prediction merely because its HTTP status is 200.
 * @param {ComparisonResponse} response
 * @param {ImageObservation[]} batch
 * @returns {ComparisonResponse}
 */
function validated(response, batch) {
  const ids = new Set(batch.map((item) => item.id));
  if (
    !Array.isArray(response?.comparisons) ||
    response.comparisons.length !== batch.length ||
    typeof response.comparison_version !== "string" ||
    typeof response.model?.model_id !== "string"
  ) {
    throw new Error("Incomplete comparison response");
  }
  for (const row of response.comparisons) {
    if (
      !ids.delete(row.candidate_id) ||
      !["same_issue", "different_issue", "uncertain"].includes(row.verdict) ||
      !["strong", "tentative", "none"].includes(row.evidence_strength) ||
      typeof row.reason !== "string" ||
      !Array.isArray(row.condition_matches)
    )
      throw new Error("Invalid comparison response");
    validateEvidence(row.evidence);
    for (const match of row.condition_matches) validateEvidence(match.evidence);
  }
  return response;
}

/**
 * Rank visual evidence without excluding candidates in the production matcher.
 * @param {ImageObservation} source
 * @param {ImageObservation[]} candidates
 * @returns {ImageObservation[]}
 */
export function rankImageCandidates(source, candidates) {
  return [...candidates].sort((a, b) => {
    const rank = (/** @type {ImageObservation} */ item) =>
      source.fingerprint && item.fingerprint === source.fingerprint
        ? -1
        : hashDistance(source.perceptualHash ?? "", item.perceptualHash ?? "");
    return rank(a) - rank(b) || a.id.localeCompare(b.id);
  });
}

/**
 * Apply an explicit evaluation-only shortlist without fabricating negative flags.
 * @param {Awaited<ReturnType<typeof matchImages>>} result
 * @param {ImageObservation[]} allCandidates
 * @returns {Awaited<ReturnType<typeof matchImages>>}
 */
export function markUnassessedCandidates(result, allCandidates) {
  const unassessed = allCandidates
    .filter(
      (candidate) =>
        !result.comparisons.some((row) => row.candidate_id === candidate.id) &&
        !result.failedCandidateIds.includes(candidate.id),
    )
    .map((candidate) => candidate.id);
  if (!unassessed.length) return result;
  const conditionResults = result.conditionResults.map((row) =>
    row.possibleDuplicate === false
      ? { ...row, status: "insufficient_evidence", possibleDuplicate: null }
      : row,
  );
  const completePositive =
    conditionResults.length > 0 &&
    conditionResults.every((row) => row.possibleDuplicate === true);
  return {
    ...result,
    candidateCount: allCandidates.length,
    unassessedCandidateIds: unassessed,
    status:
      result.status === "failed"
        ? "failed"
        : completePositive
          ? "evaluated"
          : "insufficient_evidence",
    possibleDuplicate:
      result.possibleDuplicate === false ? null : result.possibleDuplicate,
    conditionResults,
  };
}

/**
 * Shared by the SQS worker and the local real-image runner. All candidates are
 * assessed; cheap hashes only order them. A failure is not an evaluated negative.
 * @param {{source:ImageObservation,candidates:ImageObservation[],compare:Compare,onBatch?:(response:ComparisonResponse,mode:string)=>Promise<void>,exhaustive?:boolean}} input
 * @returns {Promise<{matcherVersion:string,sourceId:string,sourceRevision:string,status:string,possibleDuplicate:boolean|null,suggestions:Comparison[],comparisons:Comparison[],failedCandidateIds:string[],candidateCount:number,assessedCandidateCount:number,unassessedCandidateIds:string[],calls:number,executions:{mode:string,comparisonVersion:string,modelId:string}[],conditionSuggestions:{source_condition_id:string,candidate_condition_id:string,candidateId:string}[],conditionResults:ConditionOutcome[]}>}
 */
export async function matchImages({
  source,
  candidates,
  compare,
  onBatch,
  exhaustive = false,
}) {
  const ranked = rankImageCandidates(source, candidates);
  /** @type {Comparison[]} */
  const rows = [];
  /** @type {string[]} */
  const failures = [];
  /** @type {{mode:string,comparisonVersion:string,modelId:string}[]} */
  const executions = [];
  let calls = 0;
  for (let offset = 0; offset < ranked.length; offset += 4) {
    const batch = ranked.slice(offset, offset + 4);
    try {
      calls++;
      const response = validated(
        await compare({
          mode: "image",
          source: evidence(source, false),
          candidates: batch.map((c) => evidence(c, false)),
        }),
        batch,
      );
      executions.push({
        mode: "image",
        comparisonVersion: response.comparison_version,
        modelId: response.model.model_id,
      });
      if (onBatch) await onBatch(response, "image");
      const assessments = response.comparisons.map((row) => ({
        ...row,
        stage: "image",
      }));
      // Visual correspondence is a screen only. Every possible positive requires
      // an explicit issue mapping with descriptions, even for one-issue photos.
      const fallback = batch.filter((candidate) => {
        const row = assessments.find(
          (item) => item.candidate_id === candidate.id,
        );
        return (
          source.conditions?.length &&
          candidate.conditions?.length &&
          row &&
          (row.verdict === "uncertain" ||
            row.evidence_strength !== "strong" ||
            row.verdict === "same_issue")
        );
      });
      if (fallback.length) {
        calls++;
        const enriched = validated(
          await compare({
            mode: "context",
            source: evidence(source, true),
            candidates: fallback.map((c) => {
              const item = evidence(c, true);
              if (item.context)
                item.context.visualAssessment = assessments.find(
                  (row) => row.candidate_id === c.id,
                );
              return item;
            }),
          }),
          fallback,
        );
        executions.push({
          mode: "context",
          comparisonVersion: enriched.comparison_version,
          modelId: enriched.model.model_id,
        });
        if (onBatch) await onBatch(enriched, "context");
        for (const row of enriched.comparisons) {
          const index = assessments.findIndex(
            (item) => item.candidate_id === row.candidate_id,
          );
          // A contradictory contextual rejection cannot silently erase a strong
          // image-only correspondence. Keep it unknown rather than auto-linking IDs.
          if (
            assessments[index].verdict === "same_issue" &&
            assessments[index].evidence_strength === "strong" &&
            row.verdict === "different_issue"
          ) {
            row.stageDisagreement = true;
            row.verdict = "uncertain";
            row.evidence_strength = "tentative";
            row.reason = `Image-only and contextual assessments disagree; issue identity remains unresolved. ${row.reason}`;
          }
          assessments[index] = { ...row, stage: "context" };
        }
      }
      for (const row of assessments) {
        const candidate = batch.find((item) => item.id === row.candidate_id);
        if (!candidate) throw new Error("Unknown candidate");
        if (row.stage === "image" && row.condition_matches.length)
          throw new Error("Image-only assessment cannot bind issue IDs");
        if (row.verdict === "same_issue" && !row.condition_matches.length) {
          row.verdict = "uncertain";
          row.evidence_strength = "tentative";
        }
        const sourceIds = new Set(source.conditions?.map((c) => c.id));
        const targetIds = new Set(candidate.conditions?.map((c) => c.id));
        if (
          row.condition_matches.some(
            (match) =>
              row.stage !== "context" ||
              row.verdict !== "same_issue" ||
              !sourceIds.has(match.source_condition_id) ||
              !targetIds.has(match.candidate_condition_id),
          )
        )
          throw new Error("Invalid condition target");
      }
      for (const row of assessments) {
        const candidate = batch.find((item) => item.id === row.candidate_id);
        if (
          row.verdict === "same_issue" &&
          (!source.observedAt || !candidate?.observedAt)
        ) {
          if (row.evidence.continuity_concern === "none")
            row.evidence.continuity_concern = "unknown";
          for (const match of row.condition_matches)
            if (match.evidence.continuity_concern === "none")
              match.evidence.continuity_concern = "unknown";
        }
        Object.assign(
          row,
          assessConfidence(row.verdict, row.evidence, row.stageDisagreement),
        );
        for (const match of row.condition_matches)
          Object.assign(
            match,
            assessConfidence(
              row.verdict,
              match.evidence,
              row.stageDisagreement,
            ),
          );
        if (row.evidence_strength !== "strong" && row.confidence === "high") {
          row.confidence = "medium";
          row.confidenceReasons?.push("Model reports tentative evidence");
        }
      }
      rows.push(...assessments);
      // Once every identified source condition has a strong, unambiguous target,
      // another model call cannot improve the required flag/reference outcome.
      // Uncertain batches never take this shortcut; negatives inspect all candidates.
      if (
        !exhaustive &&
        source.conditions?.length &&
        source.conditions.every((condition) =>
          rows.some(
            (row) =>
              row.verdict === "same_issue" &&
              row.confidence === "high" &&
              row.condition_matches.some(
                (match) =>
                  match.source_condition_id === condition.id &&
                  match.confidence === "high",
              ),
          ),
        ) &&
        !assessments.some(
          (row) =>
            row.verdict === "uncertain" ||
            row.evidence_strength === "tentative",
        )
      )
        break;
    } catch {
      // Do not leak image/context text or remote error payloads to normal logs.
      failures.push(...batch.map((item) => item.id));
    }
  }
  const matches = rows.filter(
    (row) =>
      row.verdict === "same_issue" &&
      row.condition_matches.length > 0 &&
      row.confidence !== "low",
  );
  const uncertain = rows.some(
    (row) => row.verdict === "uncertain" || row.confidence !== "high",
  );
  /** @type {ConditionOutcome[]} */
  const conditionResults = (source.conditions ?? []).map((condition) => {
    if (failures.length)
      return {
        conditionId: condition.id,
        status: "failed",
        possibleDuplicate: null,
        duplicateOf: null,
        matchStrength: null,
      };
    const target = matches
      .flatMap((row) => row.condition_matches.map((match) => ({ row, match })))
      .find(
        (item) =>
          item.match.source_condition_id === condition.id &&
          item.row.confidence === "high" &&
          item.match.confidence === "high",
      );
    const candidate = candidates.find((c) => c.id === target?.row.candidate_id);
    const definiteNegative =
      !failures.length &&
      rows.length === candidates.length &&
      rows.every(
        (row) => row.verdict === "different_issue" && row.confidence === "high",
      );
    return {
      conditionId: condition.id,
      status:
        target || definiteNegative
          ? "evaluated"
          : failures.length
            ? "failed"
            : "insufficient_evidence",
      possibleDuplicate: target ? true : definiteNegative ? false : null,
      duplicateOf:
        target && candidate
          ? {
              observationId: candidate.id,
              conditionId: target.match.candidate_condition_id,
              revision: candidate.revision,
            }
          : null,
      matchStrength: target ? "strong" : null,
    };
  });
  return {
    conditionResults,
    matcherVersion: IMAGE_MATCHER_VERSION,
    sourceId: source.id,
    sourceRevision: source.revision,
    status: failures.length
      ? "failed"
      : !source.conditions?.length
        ? "insufficient_evidence"
        : uncertain
          ? "insufficient_evidence"
          : "evaluated",
    possibleDuplicate: !source.conditions?.length
      ? null
      : failures.length
        ? null
        : conditionResults.some((row) => row.possibleDuplicate === true)
          ? true
          : uncertain
            ? null
            : false,
    suggestions: failures.length ? [] : matches,
    comparisons: rows,
    failedCandidateIds: failures,
    candidateCount: candidates.length,
    assessedCandidateCount: rows.length,
    unassessedCandidateIds: candidates
      .filter(
        (c) =>
          !rows.some((row) => row.candidate_id === c.id) &&
          !failures.includes(c.id),
      )
      .map((c) => c.id),
    calls,
    executions,
    // Region correspondences may be useful even when the condition target is ambiguous.
    conditionSuggestions: (failures.length ? [] : matches).flatMap((row) =>
      row.condition_matches.map((match) => ({
        ...match,
        candidateId: row.candidate_id,
      })),
    ),
  };
}

/**
 * @param {{baseUrl:string,apiKey:string,fetchImpl?:typeof fetch}} options
 * @returns {Compare}
 */
export function createComparisonClient({ baseUrl, apiKey, fetchImpl = fetch }) {
  const endpoint = new URL(
    "v1/image-comparisons",
    baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`,
  );
  if (
    endpoint.protocol !== "https:" &&
    !(
      endpoint.protocol === "http:" &&
      ["127.0.0.1", "localhost"].includes(endpoint.hostname)
    )
  )
    throw new Error("Comparison endpoint must use TLS or loopback");
  return async (request) => {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify(request),
      signal: globalThis.AbortSignal.timeout(27000),
    });
    if (!response.ok) throw new Error(`Comparison HTTP ${response.status}`);
    return response.json();
  };
}
