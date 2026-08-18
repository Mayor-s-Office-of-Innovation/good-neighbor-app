import { actionsEscalationsV2Catalog } from "./actions-escalations-v2.js";
import { resolveCategory } from "./category-resolver.js";

/**
 * @typedef {import("./rule-catalog.js").GuidanceCatalog} GuidanceCatalog
 * @typedef {import("./rule-catalog.js").GuidanceRule} GuidanceRule
 * @typedef {import("./rule-catalog.js").RuleQuestion} RuleQuestion
 */

/**
 * @typedef {object} EvaluatedCondition
 * @property {string} category
 * @property {number} [severity]
 * @property {number} [rating]
 */

/**
 * @typedef {{ kind: "needs_answer", category: string, question: RuleQuestion, candidateRuleIds: string[] }} NeedsAnswerResult
 * @typedef {{ kind: "outcome", category: string, rule: GuidanceRule, outcome: GuidanceRule["outcome"] }} OutcomeResult
 * @typedef {{ kind: "manual_review", reason: string, category?: string }} ManualReviewResult
 * @typedef {{ kind: "no_guidance", reason: string, category: string }} NoGuidanceResult
 * @typedef {NeedsAnswerResult | OutcomeResult | ManualReviewResult | NoGuidanceResult} EvaluationResult
 */

/**
 * @param {EvaluatedCondition} condition
 * @returns {number}
 */
function conditionSeverity(condition) {
  return condition.severity ?? condition.rating ?? 0;
}

/**
 * @param {GuidanceRule} rule
 * @param {number} severity
 * @returns {boolean}
 */
function severityMatches(rule, severity) {
  return severity >= rule.severity.min && severity <= rule.severity.max;
}

/**
 * @param {GuidanceRule} rule
 * @param {Record<string, unknown>} answers
 * @returns {RuleQuestion | null}
 */
function firstMissingQuestion(rule, answers) {
  return (
    rule.requiredQuestions.find(
      (question) => !Object.hasOwn(answers, question.key),
    ) ?? null
  );
}

/**
 * @param {GuidanceRule} rule
 * @param {Record<string, unknown>} answers
 * @returns {boolean}
 */
function predicateMatches(rule, answers) {
  return rule.predicate.all.every((clause) => {
    const answer = answers[clause.fact];
    return clause.op === "eq"
      ? answer === clause.value
      : answer !== clause.value;
  });
}

/**
 * @param {GuidanceRule[]} rules
 * @returns {Map<number, GuidanceRule[]>}
 */
function rulesByEvaluationOrder(rules) {
  /** @type {Map<number, GuidanceRule[]>} */
  const byOrder = new Map();
  for (const rule of rules) {
    const group = byOrder.get(rule.evaluationOrder) ?? [];
    group.push(rule);
    byOrder.set(rule.evaluationOrder, group);
  }
  return new Map(
    [...byOrder.entries()]
      .sort(
        /**
         * @param {[number, GuidanceRule[]]} a
         * @param {[number, GuidanceRule[]]} b
         * @returns {number}
         */
        ([a], [b]) => a - b,
      )
      .map(([order, group]) => [
        order,
        group.sort((a, b) => a.ruleId.localeCompare(b.ruleId)),
      ]),
  );
}

/**
 * @param {object} opts
 * @param {EvaluatedCondition} opts.condition
 * @param {Record<string, unknown>} [opts.answers]
 * @param {GuidanceCatalog} [opts.catalog]
 * @returns {EvaluationResult}
 */
export function evaluateCondition({
  condition,
  answers = {},
  catalog = actionsEscalationsV2Catalog,
}) {
  const severity = conditionSeverity(condition);
  if (severity <= 0) {
    return { kind: "no_guidance", category: condition.category, reason: "severity_zero" };
  }

  const resolved = resolveCategory(condition.category, catalog);
  if (resolved.kind === "unresolved") {
    return {
      kind: "manual_review",
      reason: "unresolved_category",
      category: condition.category,
    };
  }

  const matchingRules = catalog.rules.filter(
    (rule) =>
      rule.category === resolved.category && severityMatches(rule, severity),
  );
  if (matchingRules.length === 0) {
    return {
      kind: "manual_review",
      reason: "no_matching_rule",
      category: resolved.category,
    };
  }

  for (const group of rulesByEvaluationOrder(matchingRules).values()) {
    const missing = group.map((rule) => firstMissingQuestion(rule, answers)).find(Boolean);
    if (missing) {
      return {
        kind: "needs_answer",
        category: resolved.category,
        question: missing,
        candidateRuleIds: group.map((rule) => rule.ruleId),
      };
    }

    const rule = group.find((candidate) =>
      predicateMatches(candidate, answers),
    );
    if (rule) {
      return {
        kind: "outcome",
        category: resolved.category,
        rule,
        outcome: rule.outcome,
      };
    }
  }

  return {
    kind: "manual_review",
    reason: "no_predicate_matched",
    category: resolved.category,
  };
}
