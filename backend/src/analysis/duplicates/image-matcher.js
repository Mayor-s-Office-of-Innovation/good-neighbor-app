import { metadataMismatch, visualPriority } from "./candidate-priority.js";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";

export const IMAGE_MATCHER_VERSION = "issue-structured-v12";
export const LOOKBACK_MS = 72 * 60 * 60 * 1000;

/** @typedef {{id:string,description:string,category?:string,label?:string}} Condition */
/** @typedef {{id:string,s3Key?:string,siteId?:string,observedAt?:string,availableAt?:string,capturedAt?:string,resolvedAt?:string,supersededAt?:string,sourceId?:string,revision:string,image?:{content_type:string,base64:string},conditions?:Condition[],description?:string,location?:object,fingerprint?:string,perceptualHash?:string}} ImageObservation */
/** @typedef {{identity_basis?:string,text_identity?:string,visual_identity:string,issue_mapping:string,matching_features:string[],visible_differences:string[],contradictions:string[],description_conflict:string,continuity_concern:string}} IssueEvidence */
/** @typedef {{source_condition_id:string,candidate_condition_id:string,evidence:IssueEvidence,confidence?:string,confidenceReasons?:string[]}} IssueMatch */
/** @typedef {{candidate_id:string,verdict:string,evidence_strength:string,reason:string,source_region:string,candidate_region:string,condition_matches:IssueMatch[],evidence:IssueEvidence,confidence?:string,confidenceReasons?:string[],stageDisagreement?:boolean,stage?:string}} Comparison */
/** @typedef {{conditionId:string,status:string,possibleDuplicate:boolean|null,duplicateOf:{observationId:string,conditionId:string,revision:string}|null,matchStrength:string|null,originalIssue?:{observationId:string,conditionId:string,revision:string}|null,originalLookupState?:string,assessmentOutcome?:string,failedCandidateCount?:number}} ConditionOutcome */
/** @typedef {{comparisons:Comparison[],comparison_version:string,model:{model_id:string}}} ComparisonResponse */
/** @typedef {{id:string,image?:{content_type:string,base64:string},context?:{conditions:Condition[],description?:string,observedAt?:string,generatedAt?:string,capturedAt?:string,location?:object,visualAssessment?:Comparison}}} Evidence */
/** @typedef {{mode:string,output?:"compact",source:Evidence,candidates:Evidence[]}} ComparisonRequest */
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
      candidate.conditions?.some(
        (c) =>
          typeof c.category === "string" &&
          !!c.category.trim() &&
          source.conditions?.some((sc) => sc.category === c.category),
      ) &&
      !(source.sourceId && candidate.sourceId === source.sourceId) &&
      Number.isFinite(capture) &&
      capture <= observed &&
      observed - capture < LOOKBACK_MS &&
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
    ...(observation.image ? { image: observation.image } : {}),
    ...(context
      ? {
          context: {
            conditions: observation.conditions ?? [],
            description: observation.description,
            observedAt: observation.observedAt,
            generatedAt: observation.observedAt,
            ...(observation.capturedAt
              ? { capturedAt: observation.capturedAt }
              : {}),
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
  if (
    value.identity_basis !== undefined &&
    !["image", "text"].includes(value.identity_basis)
  )
    throw new Error("Invalid identity basis");
  if (
    value.text_identity !== undefined &&
    !["clear", "partial", "unclear"].includes(value.text_identity)
  )
    throw new Error("Invalid text identity");
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
 * @param {boolean} [requiresTextGrounding]
 * @returns {{confidence:string,confidenceReasons:string[]}}
 */
export function assessConfidence(
  verdict,
  evidence,
  disagreement = false,
  requiresTextGrounding = false,
) {
  validateEvidence(evidence);
  const reasons = [];
  if (disagreement) reasons.push("Image-only and contextual stages disagree");
  if (verdict === "uncertain") reasons.push("Identity remains uncertain");
  const textOnly = evidence.identity_basis === "text";
  if (
    (textOnly || (requiresTextGrounding && verdict === "same_issue")) &&
    (evidence.text_identity !== "clear" ||
      evidence.matching_features.length < 2)
  )
    reasons.push("Text lacks distinctive issue-identifying details");
  if (!textOnly && evidence.visual_identity === "unclear")
    reasons.push("Visual evidence is unclear");
  if (evidence.contradictions.length)
    reasons.push("Unresolved material contradictions");
  if (evidence.description_conflict === "unresolved")
    reasons.push("Description conflict remains unresolved");
  if (verdict === "same_issue" && evidence.issue_mapping !== "clear")
    reasons.push("Issue mapping is ambiguous");
  if (reasons.length) return { confidence: "low", confidenceReasons: reasons };
  if (!textOnly && evidence.visual_identity === "partial")
    reasons.push("Only partial visual evidence");
  if (verdict === "same_issue" && !evidence.matching_features.length)
    reasons.push("No distinctive matching features recorded");
  if (verdict === "different_issue" && !evidence.visible_differences.length)
    reasons.push("No concrete visual distinction recorded");
  if (
    verdict === "same_issue" &&
    evidence.continuity_concern === "possible_resolution_or_recurrence"
  )
    reasons.push("Possible cleanup or recurrence");
  return {
    confidence: reasons.length ? "medium" : "high",
    confidenceReasons: reasons.length
      ? reasons
      : ["Clear identity evidence without unresolved conflicts"],
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
 * Newest observations first; visual hashes break age ties only.
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
    const age = (/** @type {ImageObservation} */ item) =>
      Date.parse(item.observedAt ?? "") || 0;
    return age(b) - age(a) || rank(a) - rank(b) || a.id.localeCompare(b.id);
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
      ? {
          ...row,
          status: "insufficient_evidence",
          possibleDuplicate: null,
          assessmentOutcome: "unassessed",
        }
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
 * assessed youngest first until each issue has a high-confidence match.
 * Failures are recorded diagnostically; no qualifying match returns false.
 * @param {{source:ImageObservation,candidates:ImageObservation[],compare:Compare,onBatch?:(response:ComparisonResponse,mode:string)=>Promise<void>,onProgress?:(progress:{conditionResults:ConditionOutcome[],comparisons:Comparison[],elapsedMs:number,phase?:string})=>Promise<void>,exhaustive?:boolean,strategy?:"combined"|"legacy",fastOnly?:boolean}} input
 * @returns {Promise<{matcherVersion:string,sourceId:string,sourceRevision:string,status:string,possibleDuplicate:boolean|null,suggestions:Comparison[],comparisons:Comparison[],failedCandidateIds:string[],candidateCount:number,assessedCandidateCount:number,unassessedCandidateIds:string[],calls:number,executions:{mode:string,comparisonVersion:string,modelId:string}[],conditionSuggestions:{source_condition_id:string,candidate_condition_id:string,candidateId:string}[],conditionResults:ConditionOutcome[],latency:{totalMs:number,comparisonMs:number,firstPositiveMs:number|null,fastPhaseMs:number|null},fastCandidateIds:string[],metadataDeferredCandidateIds:string[]}>}
 */
export async function matchImages({
  source,
  candidates,
  compare,
  onBatch,
  onProgress,
  exhaustive = false,
  strategy = "combined",
  fastOnly = false,
}) {
  const started = performance.now();
  let comparisonMs = 0;
  let firstPositiveMs = null;
  let fastPhaseMs = null;
  const rawCompare = compare;
  compare = async (request) => {
    const start = performance.now();
    try {
      return await rawCompare(request);
    } finally {
      comparisonMs += performance.now() - start;
    }
  };
  const categories = new Set(
    (source.conditions ?? [])
      .map((c) => c.category)
      .filter((c) => typeof c === "string" && c.trim()),
  );
  candidates = candidates
    .map((candidate) => ({
      ...candidate,
      conditions: (candidate.conditions ?? []).filter(
        (c) => typeof c.category === "string" && categories.has(c.category),
      ),
    }))
    .filter((candidate) => candidate.conditions.length > 0);
  const recent = rankImageCandidates(source, candidates);
  const fast =
    strategy === "combined"
      ? rankImageCandidates(
          source,
          visualPriority(source, candidates)
            .filter((c) => !metadataMismatch(source, c))
            .slice(0, 3),
        )
      : [];
  const background = recent.filter((c) => !fast.some((f) => f.id === c.id));
  const ranked =
    strategy === "combined"
      ? [...fast, ...(fastOnly ? [] : background)]
      : recent;
  /** @type {Comparison[]} */
  const rows = [];
  /** @type {string[]} */
  const failures = [];
  /** @type {{mode:string,comparisonVersion:string,modelId:string}[]} */
  const executions = [];
  let calls = 0;
  const batchSize = strategy === "combined" ? 3 : exhaustive ? 4 : 1;
  const matched = new Set();
  for (let offset = 0; offset < ranked.length; ) {
    // Never mix the fast shortlist and deferred candidates in the first request.
    const count =
      strategy === "combined" && offset < fast.length
        ? Math.min(batchSize, fast.length - offset)
        : batchSize;
    const activeSource = exhaustive
      ? source
      : {
          ...source,
          conditions: (source.conditions ?? []).filter(
            (c) => !matched.has(c.id),
          ),
        };
    const activeCategories = new Set(
      activeSource.conditions?.map((c) => c.category),
    );
    const batch = ranked
      .slice(offset, offset + count)
      .map((candidate) => ({
        ...candidate,
        conditions: candidate.conditions?.filter((c) =>
          activeCategories.has(c.category),
        ),
      }))
      .filter((candidate) => candidate.conditions?.length);
    offset += count;
    if (!batch.length) continue;
    const batchCategories = new Set(
      batch.flatMap(
        (candidate) => candidate.conditions?.map((c) => c.category) ?? [],
      ),
    );
    const comparisonSource = {
      ...activeSource,
      conditions: activeSource.conditions?.filter((c) =>
        batchCategories.has(c.category),
      ),
    };
    let publishing = false;
    try {
      calls++;
      const response = validated(
        await compare({
          mode: strategy === "combined" ? "context" : "image",
          ...(strategy === "combined"
            ? { output: /** @type {const} */ ("compact") }
            : {}),
          source: evidence(comparisonSource, strategy === "combined"),
          candidates: batch.map((c) => evidence(c, strategy === "combined")),
        }),
        batch,
      );
      executions.push({
        mode: strategy === "combined" ? "context" : "image",
        comparisonVersion: response.comparison_version,
        modelId: response.model.model_id,
      });
      if (onBatch)
        await onBatch(response, strategy === "combined" ? "context" : "image");
      const assessments = [...response.comparisons]
        .sort(
          (a, b) =>
            batch.findIndex((c) => c.id === a.candidate_id) -
            batch.findIndex((c) => c.id === b.candidate_id),
        )
        .map((row) => ({
          ...row,
          stage: strategy === "combined" ? "context" : "image",
        }));
      // Visual correspondence is a screen only. Every possible positive requires
      // an explicit issue mapping with descriptions, even for one-issue photos.
      const fallback =
        strategy === "combined"
          ? []
          : batch.filter((candidate) => {
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
            source: evidence(comparisonSource, true),
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
        const sourceIds = new Set(activeSource.conditions?.map((c) => c.id));
        const targetIds = new Set(candidate.conditions?.map((c) => c.id));
        if (
          row.condition_matches.some(
            (match) =>
              row.stage !== "context" ||
              row.verdict !== "same_issue" ||
              !sourceIds.has(match.source_condition_id) ||
              !targetIds.has(match.candidate_condition_id) ||
              source.conditions?.find((c) => c.id === match.source_condition_id)
                ?.category !==
                candidate.conditions?.find(
                  (c) => c.id === match.candidate_condition_id,
                )?.category,
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
        const bothImages = !!source.image && !!candidate?.image;
        for (const e of [
          row.evidence,
          ...row.condition_matches.map((m) => m.evidence),
        ]) {
          if (bothImages && e.identity_basis === "text")
            throw new Error("Images must be assessed");
          if (!source.image && !candidate?.image && e.identity_basis !== "text")
            throw new Error("Text identity basis required");
        }
        Object.assign(
          row,
          assessConfidence(
            row.verdict,
            row.evidence,
            row.stageDisagreement,
            !bothImages,
          ),
        );
        for (const match of row.condition_matches)
          Object.assign(
            match,
            assessConfidence(
              row.verdict,
              match.evidence,
              row.stageDisagreement,
              !bothImages,
            ),
          );
        if (
          row.verdict === "same_issue" &&
          (!source.observedAt || !candidate?.observedAt)
        ) {
          for (const assessment of [row, ...row.condition_matches]) {
            if (assessment.confidence === "high")
              assessment.confidence = "medium";
            assessment.confidenceReasons?.push(
              "Issue observation time unavailable",
            );
          }
        }
        if (row.evidence_strength !== "strong" && row.confidence === "high") {
          row.confidence = "medium";
          row.confidenceReasons?.push("Model reports tentative evidence");
        }
      }
      rows.push(...assessments);
      for (const row of assessments)
        if (row.verdict === "same_issue" && row.confidence === "high")
          for (const match of row.condition_matches)
            if (match.confidence === "high")
              matched.add(match.source_condition_id);
      if (strategy === "combined" && offset === fast.length)
        fastPhaseMs = Math.round(performance.now() - started);
      if (onProgress) {
        const conditionResults = (source.conditions ?? []).map((condition) => {
          const row = rows.find(
            (row) =>
              row.confidence === "high" &&
              row.verdict === "same_issue" &&
              row.condition_matches.some(
                (m) =>
                  m.source_condition_id === condition.id &&
                  m.confidence === "high",
              ),
          );
          const match = row?.condition_matches.find(
            (m) =>
              m.source_condition_id === condition.id && m.confidence === "high",
          );
          const target = candidates.find((c) => c.id === row?.candidate_id);
          return {
            conditionId: condition.id,
            status: match && target ? "evaluated" : "pending",
            possibleDuplicate: match && target ? true : null,
            duplicateOf:
              match && target
                ? {
                    observationId: target.id,
                    conditionId: match.candidate_condition_id,
                    revision: target.revision,
                  }
                : null,
            matchStrength: match ? "strong" : null,
          };
        });
        if (
          firstPositiveMs === null &&
          conditionResults.some((c) => c.possibleDuplicate === true)
        )
          firstPositiveMs = Math.round(performance.now() - started);
        publishing = true;
        await onProgress({
          conditionResults,
          comparisons: rows,
          elapsedMs: Math.round(performance.now() - started),
          phase:
            strategy === "combined" && offset <= fast.length
              ? "fast"
              : "background",
        });
        publishing = false;
      }
      if (
        !exhaustive &&
        source.conditions?.length &&
        source.conditions.every((c) => matched.has(c.id))
      )
        break;
    } catch (error) {
      if (publishing) throw error; // Persistence failures must retry, not become no match.
      // Do not leak image/context text or remote error payloads to normal logs.
      failures.push(...batch.map((item) => item.id));
      if (strategy === "combined" && offset === fast.length)
        fastPhaseMs = Math.round(performance.now() - started);
    }
  }
  const matches = rows.filter(
    (row) =>
      row.verdict === "same_issue" &&
      row.condition_matches.length > 0 &&
      row.confidence !== "low",
  );
  /** @type {ConditionOutcome[]} */
  const conditionResults = (source.conditions ?? []).map((condition) => {
    const target = matches
      .flatMap((row) => row.condition_matches.map((match) => ({ row, match })))
      .find(
        (item) =>
          item.match.source_condition_id === condition.id &&
          item.row.confidence === "high" &&
          item.match.confidence === "high",
      );
    const candidate = candidates.find((c) => c.id === target?.row.candidate_id);
    // A completed search means no qualifying suggestion, including attempts
    // that failed or remained uncertain. Retain diagnostics separately.
    const remaining = candidates.some(
      (candidate) =>
        candidate.conditions?.some((c) => c.category === condition.category) &&
        !rows.some((row) => row.candidate_id === candidate.id) &&
        !failures.includes(candidate.id),
    );
    const failedCandidateCount = candidates.filter(
      (candidate) =>
        failures.includes(candidate.id) &&
        candidate.conditions?.some((c) => c.category === condition.category),
    ).length;
    const completedNoMatch =
      !remaining &&
      typeof condition.category === "string" &&
      !!condition.category.trim();
    return {
      conditionId: condition.id,
      assessmentOutcome: target
        ? "matched"
        : completedNoMatch
          ? failedCandidateCount
            ? "no_match_with_failures"
            : "assessed_no_match"
          : "unassessed",
      failedCandidateCount,
      status:
        target || completedNoMatch
          ? "evaluated"
          : remaining
            ? "pending"
            : "insufficient_evidence",
      possibleDuplicate: target ? true : completedNoMatch ? false : null,
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
    latency: {
      totalMs: Math.round(performance.now() - started),
      comparisonMs: Math.round(comparisonMs),
      firstPositiveMs,
      fastPhaseMs,
    },
    fastCandidateIds: fast.map((c) => c.id),
    metadataDeferredCandidateIds: candidates
      .filter((c) => metadataMismatch(source, c))
      .map((c) => c.id),
    conditionResults,
    matcherVersion: IMAGE_MATCHER_VERSION,
    sourceId: source.id,
    sourceRevision: source.revision,
    status:
      conditionResults.length &&
      conditionResults.every((c) => c.status === "evaluated")
        ? "evaluated"
        : conditionResults.some((c) => c.status === "pending")
          ? "pending"
          : "insufficient_evidence",
    possibleDuplicate: conditionResults.some(
      (c) => c.possibleDuplicate === true,
    )
      ? true
      : conditionResults.length &&
          conditionResults.every((c) => c.possibleDuplicate === false)
        ? false
        : null,
    suggestions: matches,
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
    conditionSuggestions: matches.flatMap((row) =>
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
