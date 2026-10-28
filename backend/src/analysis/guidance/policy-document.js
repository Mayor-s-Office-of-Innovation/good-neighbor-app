import { evaluateCondition } from "./evaluator.js";
import { timeRangeContains } from "./rule-catalog.js";

/** @typedef {{id:string, name:string, weighting:string, definition:string, includes:string, excludes:string, visualCues:string, descriptionGuidance:string, severityGuidance:string[], aliases:string[]}} PolicyCategory */
/** @typedef {{id:string, prompt:string}} PolicyQuestion */
/** @typedef {{id:string, categoryId:string, severityMin:number, severityMax:number, order:number, schedule:{always:boolean,start:number,end:number,days:number[]}, questionId:string, answer:boolean, actionType:string, label:string, button:string, guidance:string, phone:string, routing:string, agencyCode:string, agency:string, inProgress:boolean, responseHours:number|null, overrides:string[]}} PolicyRule */
/** @typedef {{schemaVersion:1, baseVersion:string, categories:PolicyCategory[], questions:PolicyQuestion[], rules:PolicyRule[], translations:Record<string,Record<string,string>>}} PolicyDocument */
/** @typedef {{code:string, path:string, ruleId?:string, categoryId?:string, scenario?:Record<string,any>, relatedRuleIds?:string[]}} PolicyIssue */

export const POLICY_LOCALES = ["es", "fil", "vi", "zh-Hant"];
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const textFields = [
  "definition",
  "includes",
  "excludes",
  "visualCues",
  "descriptionGuidance",
];

/** Bound requests and reject unknown shapes before any enumeration or storage. Drafts may be incomplete.
 * @param {unknown} input
 * @returns {input is PolicyDocument}
 */
export function isPolicyDocument(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const d = /** @type {PolicyDocument} */ (input);
  const text = (/** @type {unknown} */ v) =>
    typeof v === "string" && v.length <= 8000;
  const strings = (/** @type {unknown} */ v, /** @type {number} */ max) =>
    Array.isArray(v) && v.length <= max && v.every(text);
  const object = (/** @type {unknown} */ v) =>
    !!v && typeof v === "object" && !Array.isArray(v);
  if (
    d.schemaVersion !== 1 ||
    !text(d.baseVersion) ||
    !Array.isArray(d.categories) ||
    d.categories.length > 50 ||
    !Array.isArray(d.questions) ||
    d.questions.length > 100 ||
    !Array.isArray(d.rules) ||
    d.rules.length > 250 ||
    !object(d.translations)
  )
    return false;
  if (
    !d.categories.every(
      (c) =>
        object(c) &&
        [
          c.id,
          c.name,
          c.weighting,
          c.definition,
          c.includes,
          c.excludes,
          c.visualCues,
          c.descriptionGuidance,
        ].every(text) &&
        strings(c.severityGuidance, 6) &&
        c.severityGuidance.length === 6 &&
        strings(c.aliases, 30),
    )
  )
    return false;
  if (!d.questions.every((q) => object(q) && [q.id, q.prompt].every(text)))
    return false;
  if (
    !d.rules.every(
      (r) =>
        object(r) &&
        [
          r.id,
          r.categoryId,
          r.questionId,
          r.actionType,
          r.label,
          r.button,
          r.guidance,
          r.phone,
          r.routing,
          r.agencyCode,
          r.agency,
        ].every(text) &&
        [r.severityMin, r.severityMax, r.order].every(Number.isFinite) &&
        typeof r.answer === "boolean" &&
        typeof r.inProgress === "boolean" &&
        (r.responseHours === null || Number.isFinite(r.responseHours)) &&
        strings(r.overrides, 250) &&
        object(r.schedule) &&
        typeof r.schedule.always === "boolean" &&
        [r.schedule.start, r.schedule.end].every(Number.isFinite) &&
        Array.isArray(r.schedule.days) &&
        r.schedule.days.length <= 7 &&
        r.schedule.days.every(Number.isInteger),
    )
  )
    return false;
  return Object.entries(d.translations).every(
    ([locale, values]) =>
      POLICY_LOCALES.includes(locale) &&
      object(values) &&
      Object.keys(values).length <= 4000 &&
      Object.entries(values).every(
        ([key, value]) => key.length <= 200 && text(value),
      ),
  );
}

/** User-facing fields requiring translations, with stable keys independent of wording.
 * @param {PolicyDocument} d
 */
export function policyTexts(d) {
  return Object.fromEntries([
    ...d.categories.map((c) => [`category.${c.id}.name`, c.name]),
    ...d.questions
      .filter((q) => d.rules.some((r) => r.questionId === q.id))
      .map((q) => [`question.${q.id}.prompt`, q.prompt]),
    ...d.rules.flatMap((r) => [
      [`rule.${r.id}.label`, r.label],
      [`rule.${r.id}.button`, r.button],
      [`rule.${r.id}.guidance`, r.guidance],
      [`rule.${r.id}.agency`, r.agency],
    ]),
  ]);
}

/** Compile structured authoring fields directly; never infer behavior from display copy.
 * @param {PolicyDocument} d
 * @param {string} [version]
 * @returns {import("./rule-catalog.js").GuidanceCatalog}
 */
export function compilePolicy(d, version = "draft") {
  const categories = new Map(d.categories.map((c) => [c.id, c]));
  const questions = new Map(d.questions.map((q) => [q.id, q]));
  return {
    policyVersion: version,
    metadata: {
      sourceAsset: "policy-editor",
      effectiveDate: "unpublished",
      createdAt: "unpublished",
    },
    aliases: d.categories.flatMap((c) =>
      c.aliases.map((alias) => ({
        analyzerCategory: alias,
        canonicalCategory: c.name,
      })),
    ),
    rules: d.rules.map((r) => {
      const c = categories.get(r.categoryId);
      const q = questions.get(r.questionId);
      return {
        policyVersion: version,
        ruleId: r.id,
        category: c?.name ?? r.categoryId,
        weighting: /** @type {import("./rule-catalog.js").RuleWeighting} */ (
          c?.weighting
        ),
        evaluationOrder: r.order,
        severity: { min: r.severityMin, max: r.severityMax },
        validTimeRange: r.schedule.always
          ? { kind: "always" }
          : {
              kind: "daily",
              startMinute: r.schedule.start,
              endMinute: r.schedule.end,
              timeZone: "America/Los_Angeles",
              daysOfWeek: r.schedule.days,
            },
        canBeInProgress: r.inProgress,
        primaryInProgressAgency: r.agency,
        ...(r.responseHours === null
          ? {}
          : { maxAcceptableResponseHours: r.responseHours }),
        requiredQuestions: q
          ? [
              {
                key: q.id,
                prompt: q.prompt,
                type: "boolean",
                options: [
                  { label: "Yes", value: true },
                  { label: "No", value: false },
                ],
              },
            ]
          : [],
        predicate: {
          all: r.questionId
            ? [{ fact: r.questionId, op: "eq", value: r.answer }]
            : [],
        },
        outcome: {
          kind:
            r.actionType === "site"
              ? "action"
              : r.actionType === "ticket"
                ? "escalation"
                : "non_actionable_escalation",
          label: r.label,
          buttons: r.button
            .split("\n")
            .map((value) => value.trim())
            .filter(Boolean),
          phoneNumber: r.phone || undefined,
          category311: r.routing || null,
          guidance: r.guidance,
          cannotDoReasons: [],
          source: "policy-editor",
          appActions: r.routing
            ? [
                {
                  code: "create_311_ticket",
                  payload: {
                    serviceCodeOrAction: r.routing,
                    responsibleAgencyCode: r.agencyCode,
                    executionTrigger:
                      r.actionType === "ticket"
                        ? "user_confirmed"
                        : "task_created",
                  },
                },
              ]
            : [],
        },
      };
    }),
  };
}

/** Validate the complete decision space using production evaluation, plus reachability.
 * Time partitions include every minute where any schedule can change its result.
 * @param {PolicyDocument} d
 * @param {{translations?:boolean}} [options]
 */
export function validatePolicy(d, { translations = false } = {}) {
  /** @type {PolicyIssue[]} */
  const issues = [];
  const add = (
    /** @type {string} */ code,
    /** @type {string} */ path,
    /** @type {Partial<PolicyIssue>} */ detail = {},
  ) => issues.push({ code, path, ...detail });
  /** @param {{id:string}[]} items @param {string} path */
  function ids(items, path) {
    const seen = new Set();
    for (const item of items) {
      if (!idPattern.test(item.id) || seen.has(item.id))
        add("invalidId", `${path}.${item.id}`);
      seen.add(item.id);
    }
  }
  ids(d.categories, "categories");
  ids(d.questions, "questions");
  ids(d.rules, "rules");
  if (!d.categories.length) add("required", "categories");
  const names = new Map();
  for (const c of d.categories) {
    for (const field of ["name", ...textFields])
      if (!String(c[/** @type {keyof PolicyCategory} */ (field)]).trim())
        add("required", `categories.${c.id}.${field}`);
    if (!["Low", "Moderate", "High"].includes(c.weighting))
      add("invalidWeight", `categories.${c.id}.weighting`);
    c.severityGuidance.forEach((v, i) => {
      if (!v.trim())
        add("required", `categories.${c.id}.severityGuidance.${i}`);
    });
    for (const name of [c.name, ...c.aliases]) {
      const normalized = name.trim().toLowerCase().replace(/\s+/g, " ");
      if (
        !normalized ||
        (names.has(normalized) && names.get(normalized) !== c.id)
      )
        add("categoryCollision", `categories.${c.id}.name`);
      names.set(normalized, c.id);
    }
  }
  for (const q of d.questions)
    if (d.rules.some((r) => r.questionId === q.id) && !q.prompt.trim())
      add("required", `questions.${q.id}.prompt`);
  for (const r of d.rules) {
    const path = `rules.${r.id}`;
    if (!d.categories.some((c) => c.id === r.categoryId))
      add("unknownCategory", path);
    if (
      !Number.isInteger(r.severityMin) ||
      !Number.isInteger(r.severityMax) ||
      r.severityMin < 1 ||
      r.severityMax > 5 ||
      r.severityMin > r.severityMax
    )
      add("invalidSeverity", `${path}.severity`);
    if (!Number.isInteger(r.order) || r.order < 1 || r.order > 250)
      add("invalidOrder", `${path}.order`);
    if (
      !r.schedule.always &&
      (!r.schedule.days.length ||
        new Set(r.schedule.days).size !== r.schedule.days.length ||
        r.schedule.days.some((n) => n < 0 || n > 6) ||
        ![r.schedule.start, r.schedule.end].every(
          (n) => Number.isInteger(n) && n >= 0 && n < 1440,
        ))
    )
      add("invalidSchedule", `${path}.schedule`);
    if (r.questionId && !d.questions.some((q) => q.id === r.questionId))
      add("unknownQuestion", `${path}.questionId`);
    if (!["site", "ticket", "phone"].includes(r.actionType))
      add("invalidAction", `${path}.actionType`);
    for (const field of ["label", "button", "guidance", "agency"])
      if (!String(r[/** @type {keyof PolicyRule} */ (field)]).trim())
        add("required", `${path}.${field}`);
    if (
      r.actionType === "phone" &&
      !/^(?:911|311|[2-9]\d{2}-\d{3}-\d{4})$/.test(r.phone)
    )
      add("invalidPhone", `${path}.phone`);
    if (
      r.responseHours === null ||
      r.responseHours < 0 ||
      r.responseHours > 8760
    )
      add("invalidDeadline", `${path}.responseHours`);
    if (
      (r.actionType === "ticket" && !r.routing) ||
      (r.routing &&
        !/^(?:\d+(?:\.\d+)+|Run bulky item analysis|Run graffiti analysis)$/.test(
          r.routing,
        ))
    )
      add("invalidRouting", `${path}.routing`);
    if (r.agencyCode && !/^\d+$/.test(r.agencyCode))
      add("invalidAgency", `${path}.agencyCode`);
    for (const id of r.overrides) {
      const other = d.rules.find((rule) => rule.id === id);
      if (
        !other ||
        other.categoryId !== r.categoryId ||
        r.order >= other.order ||
        r.id === id
      )
        add("invalidOverride", `${path}.overrides`);
    }
  }
  /** @type {Record<string,Record<string,any>>} */
  const witnesses = Object.create(null);
  /** @type {Record<string,any>[]} */
  const coverage = [];
  let scenarioBudget = 50000;
  if (!issues.length) {
    const catalog = compilePolicy(d);
    const seen = new Set();
    /** @param {string} code @param {string} path @param {Partial<PolicyIssue>} detail */
    const once = (code, path, detail) => {
      const key = code + path + JSON.stringify(detail.relatedRuleIds ?? []);
      if (!seen.has(key)) {
        seen.add(key);
        add(code, path, detail);
      }
    };
    for (const c of d.categories) {
      const rules = catalog.rules.filter((r) => r.category === c.name);
      const keys = [
        ...new Set(rules.flatMap((r) => r.requiredQuestions.map((q) => q.key))),
      ];
      if (keys.length > 8) {
        add("tooManyQuestions", `categories.${c.id}`);
        continue;
      }
      const minutes = [
        ...new Set([
          0,
          ...rules.flatMap((r) =>
            r.validTimeRange.kind === "daily"
              ? [
                  r.validTimeRange.startMinute,
                  (r.validTimeRange.endMinute + 1) % 1440,
                ]
              : [],
          ),
        ]),
      ].sort((a, b) => a - b);
      const scenarios = 5 * 7 * minutes.length * 2 ** keys.length;
      if (scenarios > scenarioBudget) {
        add("tooManyQuestions", `categories.${c.id}`);
        continue;
      }
      scenarioBudget -= scenarios;
      for (let severity = 1; severity <= 5; severity++)
        for (let day = 0; day < 7; day++)
          for (const minute of minutes)
            for (let mask = 0; mask < 2 ** keys.length; mask++) {
              const answers = Object.fromEntries(
                keys.map((key, i) => [key, Boolean(mask & (1 << i))]),
              );
              // 2026-01-04 is Sunday; fixed winter offset produces the requested Pacific minute.
              const reportedAt = new Date(
                Date.UTC(2026, 0, 4 + day, 8, minute),
              ).toISOString();
              const scenario = {
                category: c.name,
                severity,
                day,
                minute,
                answers,
                reportedAt,
              };
              const result = evaluateCondition({
                condition: { category: c.name, severity },
                answers,
                catalog,
                reportedAt,
              });
              const matches = rules.filter(
                (r) =>
                  severity >= r.severity.min &&
                  severity <= r.severity.max &&
                  timeRangeContains(r.validTimeRange, minute, day) &&
                  r.predicate.all.every((p) => answers[p.fact] === p.value),
              );
              if (result.kind !== "outcome")
                once("coverageGap", `categories.${c.id}`, {
                  categoryId: c.id,
                  scenario,
                });
              else {
                witnesses[result.rule.ruleId] ??= scenario;
                const winner = d.rules.find((r) => r.id === result.rule.ruleId);
                const others = matches.filter((r) => r.ruleId !== winner?.id);
                for (const other of others)
                  if (!winner?.overrides.includes(other.ruleId))
                    once("overlap", `rules.${winner?.id}`, {
                      ruleId: winner?.id,
                      relatedRuleIds: [other.ruleId],
                      scenario,
                    });
              }
              if (coverage.length < 1000)
                coverage.push({
                  ...scenario,
                  ruleId: result.kind === "outcome" ? result.rule.ruleId : null,
                });
            }
      for (const r of rules)
        if (!witnesses[r.ruleId])
          add("unreachable", `rules.${r.ruleId}`, { ruleId: r.ruleId });
    }
  }
  if (translations)
    for (const locale of POLICY_LOCALES)
      for (const [key, value] of Object.entries(policyTexts(d)))
        if (value && !d.translations[locale]?.[key]?.trim())
          add("missingTranslation", `translations.${locale}.${key}`);
  return {
    valid: issues.length === 0,
    issues,
    witnesses,
    coverage,
    coverageTruncated: coverage.length === 1000,
  };
}
