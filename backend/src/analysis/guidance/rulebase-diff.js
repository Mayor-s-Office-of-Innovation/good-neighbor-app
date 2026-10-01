import { evaluateCondition } from "./evaluator.js";

/**
 * @typedef {import("./rule-catalog.js").GuidanceCatalog} GuidanceCatalog
 * @typedef {import("./rule-catalog.js").GuidanceRule} GuidanceRule
 */

/**
 * @typedef {object} GuidanceFixture
 * @property {string} id
 * @property {{ category: string, severity: number }} condition
 * @property {Record<string, unknown>} [answers]
 * @property {string} [reportedAt]
 */

const ROUTING_PATHS = new Set([
  "category",
  "evaluationOrder",
  "severity",
  "validTimeRange",
  "canBeInProgress",
  "requiredQuestions",
  "predicate",
  "outcome.kind",
]);

const INTEGRATION_PATHS = new Set([
  "maxAcceptableResponseHours",
  "primaryInProgressAgency",
  "outcome.appActions",
  "outcome.category311",
]);

const USER_EXPERIENCE_PATHS = new Set([
  "outcome.label",
  "outcome.buttons",
  "outcome.guidance",
  "outcome.cannotDoReasons",
]);

/**
 * @param {unknown} value
 * @returns {string}
 */
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
function sameValue(a, b) {
  return stableStringify(a) === stableStringify(b);
}

/**
 * @param {string} path
 * @returns {"routing" | "integration" | "user_experience" | "provenance"}
 */
function classifyPath(path) {
  if (ROUTING_PATHS.has(path)) return "routing";
  if (INTEGRATION_PATHS.has(path)) return "integration";
  if (USER_EXPERIENCE_PATHS.has(path)) return "user_experience";
  return "provenance";
}

/**
 * @param {GuidanceRule} rule
 * @returns {Record<string, unknown>}
 */
function comparableRule(rule) {
  return {
    category: rule.category,
    weighting: rule.weighting,
    maxAcceptableResponseHours: rule.maxAcceptableResponseHours,
    evaluationOrder: rule.evaluationOrder,
    severity: rule.severity,
    validTimeRange: rule.validTimeRange,
    canBeInProgress: rule.canBeInProgress,
    primaryInProgressAgency: rule.primaryInProgressAgency,
    requiredQuestions: rule.requiredQuestions,
    predicate: rule.predicate,
    "outcome.kind": rule.outcome.kind,
    "outcome.label": rule.outcome.label,
    "outcome.buttons": rule.outcome.buttons,
    "outcome.appActions": rule.outcome.appActions,
    "outcome.category311": rule.outcome.category311,
    "outcome.guidance": rule.outcome.guidance,
    "outcome.cannotDoReasons": rule.outcome.cannotDoReasons,
    "outcome.source": rule.outcome.source,
  };
}

/**
 * @param {ReturnType<typeof evaluateCondition>} result
 * @returns {Record<string, unknown>}
 */
function evaluationFingerprint(result) {
  if (result.kind === "outcome") {
    return {
      kind: result.kind,
      category: result.category,
      ruleId: result.rule.ruleId,
      outcome: result.outcome,
    };
  }
  if (result.kind === "needs_answer") {
    return {
      kind: result.kind,
      category: result.category,
      questionKey: result.question.key,
      candidateRuleIds: result.candidateRuleIds,
    };
  }
  return result;
}

/**
 * @param {GuidanceCatalog} before
 * @param {GuidanceCatalog} after
 * @returns {{ addedRules: string[], removedRules: string[], changedRules: { ruleId: string, category: string, changes: { path: string, impact: string, before: unknown, after: unknown }[] }[], aliasChanges: { added: string[], removed: string[] }, metadataChanges: { path: string, before: unknown, after: unknown }[] }}
 */
export function diffCatalogs(before, after) {
  const beforeRules = new Map(before.rules.map((rule) => [rule.ruleId, rule]));
  const afterRules = new Map(after.rules.map((rule) => [rule.ruleId, rule]));

  const addedRules = [...afterRules.keys()]
    .filter((ruleId) => !beforeRules.has(ruleId))
    .sort();
  const removedRules = [...beforeRules.keys()]
    .filter((ruleId) => !afterRules.has(ruleId))
    .sort();

  const changedRules = [...beforeRules.keys()]
    .filter((ruleId) => afterRules.has(ruleId))
    .sort()
    .flatMap((ruleId) => {
      const prior = beforeRules.get(ruleId);
      const next = afterRules.get(ruleId);
      if (!prior || !next) return [];
      const priorComparable = comparableRule(prior);
      const nextComparable = comparableRule(next);
      const changes = Object.keys(priorComparable)
        .filter(
          (path) => !sameValue(priorComparable[path], nextComparable[path]),
        )
        .map((path) => ({
          path,
          impact: classifyPath(path),
          before: priorComparable[path],
          after: nextComparable[path],
        }));
      return changes.length
        ? [{ ruleId, category: next.category, changes }]
        : [];
    });

  const beforeAliases = new Set(
    before.aliases.map(
      (alias) => `${alias.analyzerCategory} -> ${alias.canonicalCategory}`,
    ),
  );
  const afterAliases = new Set(
    after.aliases.map(
      (alias) => `${alias.analyzerCategory} -> ${alias.canonicalCategory}`,
    ),
  );

  const metadataChanges = ["policyVersion", "metadata"].flatMap((path) => {
    const prior =
      path === "policyVersion" ? before.policyVersion : before.metadata;
    const next =
      path === "policyVersion" ? after.policyVersion : after.metadata;
    return sameValue(prior, next) ? [] : [{ path, before: prior, after: next }];
  });

  return {
    addedRules,
    removedRules,
    changedRules,
    aliasChanges: {
      added: [...afterAliases]
        .filter((alias) => !beforeAliases.has(alias))
        .sort(),
      removed: [...beforeAliases]
        .filter((alias) => !afterAliases.has(alias))
        .sort(),
    },
    metadataChanges,
  };
}

/**
 * @param {GuidanceCatalog} before
 * @param {GuidanceCatalog} after
 * @param {GuidanceFixture[]} fixtures
 * @returns {{ fixtureId: string, before: Record<string, unknown>, after: Record<string, unknown> }[]}
 */
export function evaluateRulebaseImpact(before, after, fixtures) {
  return fixtures.flatMap((fixture) => {
    const prior = evaluationFingerprint(
      evaluateCondition({
        condition: fixture.condition,
        answers: fixture.answers ?? {},
        catalog: before,
        reportedAt: fixture.reportedAt ?? "2026-10-01T19:00:00.000Z",
      }),
    );
    const next = evaluationFingerprint(
      evaluateCondition({
        condition: fixture.condition,
        answers: fixture.answers ?? {},
        catalog: after,
        reportedAt: fixture.reportedAt ?? "2026-10-01T19:00:00.000Z",
      }),
    );
    return sameValue(prior, next)
      ? []
      : [{ fixtureId: fixture.id, before: prior, after: next }];
  });
}

/**
 * @param {ReturnType<typeof diffCatalogs>} diff
 * @param {ReturnType<typeof evaluateRulebaseImpact>} impact
 * @returns {{ summary: Record<string, number> }}
 */
export function summarizeRulebaseDiff(diff, impact) {
  const changeCounts = {
    addedRules: diff.addedRules.length,
    removedRules: diff.removedRules.length,
    changedRules: diff.changedRules.length,
    routingChanges: diff.changedRules.filter((rule) =>
      rule.changes.some((change) => change.impact === "routing"),
    ).length,
    integrationChanges: diff.changedRules.filter((rule) =>
      rule.changes.some((change) => change.impact === "integration"),
    ).length,
    userExperienceChanges: diff.changedRules.filter((rule) =>
      rule.changes.some((change) => change.impact === "user_experience"),
    ).length,
    aliasChanges:
      diff.aliasChanges.added.length + diff.aliasChanges.removed.length,
    fixtureOutcomeChanges: impact.length,
  };
  return { summary: changeCounts };
}
