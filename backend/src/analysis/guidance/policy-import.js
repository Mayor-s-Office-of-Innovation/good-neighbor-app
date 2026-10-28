import { activeCatalog } from "./catalog-registry.js";
import {
  cleanCell,
  parseBoolean,
  parsePredicate,
  parseSeverityRange,
  parseValidTimeRange,
} from "./rule-catalog.js";
import { POLICY_CATEGORY_SOURCE } from "./policy-category-source.js";
import { readPolicyCsv, writePolicyCsv } from "./policy-csv.js";

export const CATEGORY_HEADERS = [
  "Category",
  "Definition",
  "Weighting",
  "Includes",
  "Excludes",
  "Visual cues",
  "Severity guidance",
  "Description guidance",
];
export const RULE_HEADERS = [
  "Category",
  "Weighting",
  "Rule ID",
  "Evaluation order",
  "Condition: severity",
  "Condition: valid in time range",
  "Ask user",
  "Condition: user response",
  "Action type",
  "Can be in progress",
  "Primary in progress agency",
  "Action / escalation text",
  "User-facing button label(s)",
  "311 service code",
  "Phone number",
  "Responsible agency code",
  "Max acceptable response time (hours)",
  "Human-readable guidance",
];

/** @param {string} name */
const categoryId = (name) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-$/g, "");

/** @param {string} text */
function severityDescriptions(text) {
  const matches = [
    ...text.matchAll(
      /(?:^|\n)\s*([0-5])\s*:\s*([\s\S]*?)(?=\n\s*[0-5]\s*:|$)/g,
    ),
  ];
  if (matches.length !== 6 || new Set(matches.map((m) => m[1])).size !== 6)
    throw new Error("invalid_severity_guidance");
  return Array.from(
    { length: 6 },
    (_, i) => matches.find((m) => m[1] === String(i))?.[2].trim() ?? "",
  );
}

/** @param {string[][]} rows @param {import('./rule-catalog.js').GuidanceCatalog} catalog
 * @returns {import('./policy-document.js').PolicyDocument}
 */
export function policyFromCatalog(rows, catalog) {
  const categories = rows.map((row) => ({
    id: categoryId(row[0]),
    name: row[0].trim(),
    definition: row[1].trim(),
    weighting: row[2].trim(),
    includes: row[3].trim(),
    excludes: row[4].trim(),
    visualCues: row[5].trim(),
    severityGuidance: severityDescriptions(row[6]),
    descriptionGuidance: row[7].trim(),
    aliases: catalog.aliases
      .filter((a) => a.canonicalCategory === row[0].trim())
      .map((a) => a.analyzerCategory),
  }));
  const questions = new Map();
  for (const rule of catalog.rules)
    for (const q of rule.requiredQuestions) {
      if (questions.has(q.key) && questions.get(q.key).prompt !== q.prompt) {
        // Legacy fact keys can have category-specific wording. Separate question identity
        // in the editor without changing the truth value of either branch.
        questions.set(`${categoryId(rule.category)}_${q.key}`, {
          id: `${categoryId(rule.category)}_${q.key}`,
          prompt: q.prompt,
        });
      } else questions.set(q.key, { id: q.key, prompt: q.prompt });
    }
  const rules = catalog.rules.map((r) => {
    if (r.requiredQuestions.length > 1 || r.predicate.all.length > 1)
      throw new Error("unsupported_legacy_predicate");
    const q = r.requiredQuestions[0];
    const specific = q ? `${categoryId(r.category)}_${q.key}` : "";
    const questionId = q
      ? questions.get(specific)?.prompt === q.prompt
        ? specific
        : q.key
      : "";
    const predicate = r.predicate.all[0];
    if (predicate && typeof predicate.value !== "boolean")
      throw new Error("unsupported_legacy_predicate");
    const action = r.outcome.appActions.find(
      (a) => a.code === "create_311_ticket",
    );
    return {
      id: r.ruleId,
      categoryId: categoryId(r.category),
      severityMin: r.severity.min,
      severityMax: r.severity.max,
      order: r.evaluationOrder,
      schedule:
        r.validTimeRange.kind === "always"
          ? { always: true, start: 0, end: 1439, days: [0, 1, 2, 3, 4, 5, 6] }
          : {
              always: false,
              start: r.validTimeRange.startMinute,
              end: r.validTimeRange.endMinute,
              days: r.validTimeRange.daysOfWeek ?? [0, 1, 2, 3, 4, 5, 6],
            },
      questionId,
      answer: predicate
        ? predicate.op === "eq"
          ? Boolean(predicate.value)
          : !predicate.value
        : true,
      actionType:
        r.outcome.kind === "action"
          ? "site"
          : r.outcome.kind === "escalation"
            ? "ticket"
            : "phone",
      label: r.outcome.label,
      button: r.outcome.buttons.join("\n"),
      guidance: r.outcome.guidance,
      phone: r.outcome.phoneNumber ?? "",
      routing: r.outcome.category311 ?? "",
      agencyCode: String(action?.payload.responsibleAgencyCode ?? ""),
      agency: r.primaryInProgressAgency,
      inProgress: r.canBeInProgress,
      responseHours: r.maxAcceptableResponseHours ?? null,
      overrides: [],
    };
  });
  return {
    schemaVersion: 1,
    baseVersion: catalog.policyVersion,
    categories,
    questions: [...questions.values()].filter((q) =>
      rules.some((r) => r.questionId === q.id),
    ),
    rules,
    translations: {},
  };
}

/** Always seed from the repository's current catalog, never a frozen copy of uploaded rules. */
export function initialPolicyDocument() {
  return policyFromCatalog(POLICY_CATEGORY_SOURCE, activeCatalog());
}

/** @param {string} categoriesCsv @param {string} rulesCsv */
export function importPolicyCsv(categoriesCsv, rulesCsv) {
  const categories = readPolicyCsv(categoriesCsv),
    rules = readPolicyCsv(rulesCsv);
  if (
    JSON.stringify(categories.shift()) !== JSON.stringify(CATEGORY_HEADERS) ||
    JSON.stringify(rules.shift()) !== JSON.stringify(RULE_HEADERS)
  )
    throw new Error("invalid_csv_headers");
  // Question identity comes from the typed predicate, never from prompt wording.
  const catalog = /** @type {import('./rule-catalog.js').GuidanceCatalog} */ ({
    policyVersion: activeCatalog().policyVersion,
    metadata: activeCatalog().metadata,
    aliases: [],
    rules: rules.map((row) => {
      if (
        row[7].trim() &&
        !/^(?:location\s*(?:==|!=)\s*provider_controlled_property|\w+\s*(?:==|!=)\s*(?:true|false))$/.test(
          row[7].trim(),
        )
      )
        throw new Error("unsupported_legacy_predicate");
      const predicate = parsePredicate(row[7]);
      if (
        predicate.all.length > 1 ||
        predicate.all.some((p) => typeof p.value !== "boolean") ||
        Boolean(row[6].trim()) !== Boolean(predicate.all.length)
      )
        throw new Error("unsupported_legacy_predicate");
      if (!["Sidewalk action", "Phone call", "311 ticket"].includes(row[8]))
        throw new Error("invalid_action");
      return {
        policyVersion: "import",
        ruleId: cleanCell(row[2]),
        category: cleanCell(row[0]),
        weighting: cleanCell(row[1]),
        evaluationOrder: Number(row[3]),
        severity: parseSeverityRange(row[4]),
        validTimeRange: parseValidTimeRange(row[5]),
        canBeInProgress: parseBoolean(row[9]),
        primaryInProgressAgency: cleanCell(row[10]),
        requiredQuestions: predicate.all.map((p) => ({
          key: p.fact,
          prompt: row[6].trim(),
          type: "boolean",
          options: [
            { label: "Yes", value: true },
            { label: "No", value: false },
          ],
        })),
        predicate,
        outcome: {
          kind:
            row[8] === "Sidewalk action"
              ? "action"
              : row[8] === "311 ticket"
                ? "escalation"
                : "non_actionable_escalation",
          label: row[11].trim(),
          buttons: [row[12].trim()],
          phoneNumber: row[14].trim(),
          category311: cleanCell(row[13]),
          guidance: row[17].trim(),
          cannotDoReasons: [],
          source: "csv-import",
          appActions: [
            {
              code: "create_311_ticket",
              payload: { responsibleAgencyCode: cleanCell(row[15]) },
            },
          ],
        },
        maxAcceptableResponseHours: row[16].trim()
          ? Number(row[16])
          : undefined,
      };
    }),
  });
  const document = policyFromCatalog(categories, catalog);
  for (const row of rules) {
    const category = document.categories.find((c) => c.name === row[0].trim());
    if (!category || category.weighting !== row[1].trim())
      throw new Error("inconsistent_category_weight");
  }
  return document;
}

/** @param {import('./policy-document.js').PolicyDocument} d */
export function exportPolicyCsv(d) {
  const clock = (/** @type {number} */ n) =>
    `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
  const weekdays = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
  return {
    categoriesCsv: writePolicyCsv([
      CATEGORY_HEADERS,
      ...d.categories.map((c) => [
        c.name,
        c.definition,
        c.weighting,
        c.includes,
        c.excludes,
        c.visualCues,
        c.severityGuidance.map((s, i) => `${i}: ${s}`).join("\n"),
        c.descriptionGuidance,
      ]),
    ]),
    rulesCsv: writePolicyCsv([
      RULE_HEADERS,
      ...d.rules.map((r) => {
        const c = d.categories.find((c) => c.id === r.categoryId);
        const q = d.questions.find((q) => q.id === r.questionId);
        return [
          c?.name ?? r.categoryId,
          c?.weighting ?? "",
          r.id,
          String(r.order),
          r.severityMin === r.severityMax
            ? String(r.severityMin)
            : `${r.severityMin}-${r.severityMax}`,
          r.schedule.always
            ? "24 hours"
            : `${clock(r.schedule.start)}-${clock(r.schedule.end)}${r.schedule.days.length === 7 ? "" : `, ${r.schedule.days.map((day) => weekdays[day]).join("+")}`}`,
          q?.prompt ?? "",
          q ? `${q.id} == ${r.answer}` : "",
          r.actionType === "site"
            ? "Sidewalk action"
            : r.actionType === "ticket"
              ? "311 ticket"
              : "Phone call",
          r.inProgress ? "True" : "False",
          r.agency,
          r.label,
          r.button,
          r.routing,
          r.phone,
          r.agencyCode,
          r.responseHours === null ? "" : String(r.responseHours),
          r.guidance,
        ];
      }),
    ]),
  };
}
