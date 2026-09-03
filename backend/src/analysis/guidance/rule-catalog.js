/** @typedef {"Low" | "Moderate" | "High"} RuleWeighting */
/** @typedef {"action" | "escalation" | "non_actionable_escalation" | "manual_review"} OutcomeKind */

/**
 * @typedef {object} RuleQuestion
 * @property {string} key
 * @property {string} prompt
 * @property {"boolean"} type
 * @property {{ label: string, value: boolean }[]} options
 */

/**
 * @typedef {object} RulePredicateClause
 * @property {string} fact
 * @property {"eq" | "neq"} op
 * @property {string | boolean} value
 */

/**
 * @typedef {object} RuleOutcome
 * @property {OutcomeKind} kind
 * @property {string} label
 * @property {string[]} buttons
 * @property {{ code: string, payload: Record<string, unknown> }[]} appActions
 * @property {string | null} category311
 * @property {string} guidance
 * @property {string[]} cannotDoReasons
 * @property {string} source
 */

/**
 * @typedef {object} GuidanceRule
 * @property {string} policyVersion
 * @property {string} ruleId
 * @property {string} category
 * @property {RuleWeighting} weighting
 * @property {number} evaluationOrder
 * @property {{ min: number, max: number }} severity
 * @property {RuleQuestion[]} requiredQuestions
 * @property {{ all: RulePredicateClause[] }} predicate
 * @property {RuleOutcome} outcome
 */

/**
 * @typedef {object} GuidanceCatalog
 * @property {string} policyVersion
 * @property {{ sourceAsset: string, effectiveDate: string, createdAt: string, changelogPath?: string }} metadata
 * @property {GuidanceRule[]} rules
 * @property {{ analyzerCategory: string, canonicalCategory: string }[]} aliases
 */

const EMPTY_MARKERS = new Set(["", "-", "'-", "'-'", "''"]);

const BOOLEAN_OPTIONS = [
  { label: "Yes", value: true },
  { label: "No", value: false },
];

/**
 * @param {string | undefined} value
 * @returns {string}
 */
export function cleanCell(value) {
  const cleaned = (value ?? "").trim().replaceAll("\t", "");
  return EMPTY_MARKERS.has(cleaned) ? "" : cleaned;
}

/**
 * @param {string} raw
 * @returns {{ min: number, max: number }}
 */
export function parseSeverityRange(raw) {
  const value = cleanCell(raw);
  const match = value.match(/^(\d)(?:-(\d))?$/);
  if (!match) throw new Error(`Invalid severity range: ${raw}`);
  const min = Number(match[1]);
  const max = Number(match[2] ?? match[1]);
  if (min < 0 || max > 5 || min > max) {
    throw new Error(`Severity range out of bounds: ${raw}`);
  }
  return { min, max };
}

/**
 * @param {string} prompt
 * @returns {string | null}
 */
export function questionKeyForPrompt(prompt) {
  const value = cleanCell(prompt).toLowerCase();
  if (!value) return null;
  if (value.includes("items from your site")) return "provider_generated";
  if (value.includes("on site property")) return "onsite";
  if (value.includes("client or resident")) return "affiliated";
  if (value.includes("clients or residents")) return "affiliated";
  if (value.includes("asking for medical help")) return "medical_help";
  if (value.includes("likely to leave if asked")) return "refusal_leave";
  throw new Error(`Unknown question prompt: ${prompt}`);
}

/**
 * @param {string} prompt
 * @returns {RuleQuestion[]}
 */
export function questionsForPrompt(prompt) {
  const cleaned = cleanCell(prompt);
  const key = questionKeyForPrompt(cleaned);
  return key
    ? [{ key, prompt: cleaned, type: "boolean", options: BOOLEAN_OPTIONS }]
    : [];
}

/**
 * @param {string} raw
 * @returns {{ all: RulePredicateClause[] }}
 */
export function parsePredicate(raw) {
  const value = cleanCell(raw);
  if (!value) return { all: [] };

  /** @type {RulePredicateClause[]} */
  const all = value.split("\n").map((line) => {
    const match = line.trim().match(/^(\w+)\s*([!=]=)\s*(.+)$/);
    if (!match) throw new Error(`Invalid predicate clause: ${line}`);

    let [, fact, op, rawValue] = match;
    rawValue = rawValue.trim();

    if (fact === "location") {
      return /** @type {RulePredicateClause} */ ({
        fact: "onsite",
        op: "eq",
        value:
          op === "==" && rawValue === "provider_controlled_property"
            ? true
            : false,
      });
    }

    const parsedValue =
      rawValue === "true" ? true : rawValue === "false" ? false : rawValue;
    return /** @type {RulePredicateClause} */ ({
      fact,
      op: op === "==" ? "eq" : "neq",
      value: parsedValue,
    });
  });

  return { all };
}

/**
 * @param {string | undefined} raw
 * @returns {string[]}
 */
export function splitLines(raw) {
  return cleanCell(raw)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * @param {string | undefined} raw
 * @param {{ serviceCodeOrAction?: string, responsibleAgencyCode?: string }} [options]
 * @returns {{ code: string, payload: Record<string, unknown> }[]}
 */
export function parseAppActions(raw, options = {}) {
  const { serviceCodeOrAction = "", responsibleAgencyCode = "" } =
    /** @type {{ serviceCodeOrAction?: string, responsibleAgencyCode?: string }} */ (
      options
    );
  return splitLines(raw).map((line) => {
    if (line.includes("311")) {
      const normalizedLine = line.toLowerCase();
      const executionTrigger =
        normalizedLine.includes("action creation") ||
        normalizedLine.includes("escalation creation")
          ? "task_created"
          : "user_confirmed";
      return {
        code: "create_311_ticket",
        payload: {
          serviceCodeOrAction: cleanCell(serviceCodeOrAction) || null,
          responsibleAgencyCode: cleanCell(responsibleAgencyCode),
          executionTrigger,
        },
      };
    }
    if (line.includes("phone app")) {
      return {
        code: "manual_app_action",
        payload: { description: line },
      };
    }
    if (line.startsWith("E-mail") || line.startsWith("Email")) {
      return {
        code: "compose_email",
        payload: { to: line.match(/[\w.-]+@[\w.-]+/)?.[0] ?? null },
      };
    }
    if (line.includes("Bureau of Fire Protection")) {
      return {
        code: "create_fire_hazard_report",
        payload: { formType: "bureau_of_fire_protection_hazardous_report" },
      };
    }
    return { code: "manual_app_action", payload: { description: line } };
  });
}

/**
 * @param {string} raw
 * @returns {OutcomeKind}
 */
export function normalizeOutcomeKind(raw) {
  const value = cleanCell(raw).toLowerCase();
  if (value === "non-actionable escalation") {
    return "non_actionable_escalation";
  }
  return /** @type {OutcomeKind} */ (value.replaceAll(" ", "_"));
}

/**
 * @param {object} opts
 * @param {string} opts.policyVersion
 * @param {{ sourceAsset: string, effectiveDate: string, createdAt: string, changelogPath?: string }} [opts.metadata]
 * @param {string[][]} opts.rows
 * @param {{ analyzerCategory: string, canonicalCategory: string }[]} opts.aliases
 * @returns {GuidanceCatalog}
 */
export function buildCatalog({ policyVersion, metadata, rows, aliases }) {
  return {
    policyVersion,
    metadata: {
      sourceAsset: "inline",
      effectiveDate: "unknown",
      createdAt: "unknown",
      ...(metadata ?? {}),
    },
    aliases,
    rules: rows.map((row) => {
      const isResponsibleAgencyRulebaseShape = row.length === 16;
      const category = row[0];
      const weighting = row[1];
      const ruleId = row[2];
      const evaluationOrder = row[3];
      const severity = row[4];
      const askUser = row[5];
      const userResponse = row[6];
      const thenKind = row[7];
      const label = row[8];
      const buttons = row[9];
      const appAction = row[10];
      const serviceCodeOrAction = row[11];
      const responsibleAgencyCode = isResponsibleAgencyRulebaseShape
        ? row[12]
        : "";
      const guidance = isResponsibleAgencyRulebaseShape ? row[13] : row[12];
      const cannotDoReasons = isResponsibleAgencyRulebaseShape
        ? row[14]
        : row[13];
      const source = isResponsibleAgencyRulebaseShape ? row[15] : row[14];

      return {
        policyVersion,
        ruleId: cleanCell(ruleId),
        category: cleanCell(category),
        weighting: /** @type {RuleWeighting} */ (cleanCell(weighting)),
        evaluationOrder: Number(cleanCell(evaluationOrder)),
        severity: parseSeverityRange(severity),
        requiredQuestions: questionsForPrompt(askUser),
        predicate: parsePredicate(userResponse),
        outcome: {
          kind: normalizeOutcomeKind(thenKind),
          label: cleanCell(label),
          buttons: splitLines(buttons),
          appActions: parseAppActions(appAction, {
            serviceCodeOrAction,
            responsibleAgencyCode,
          }),
          category311: cleanCell(serviceCodeOrAction) || null,
          guidance: cleanCell(guidance),
          cannotDoReasons: splitLines(cannotDoReasons),
          source: cleanCell(source),
        },
      };
    }),
  };
}

/**
 * @param {GuidanceCatalog} catalog
 * @returns {string[]}
 */
export function validateCatalog(catalog) {
  /** @type {string[]} */
  const errors = [];
  const ruleIds = new Set();
  const questionTypes = new Map();
  const categories = new Set(catalog.rules.map((rule) => rule.category));

  for (const rule of catalog.rules) {
    if (!rule.ruleId) errors.push("Rule is missing ruleId");
    if (ruleIds.has(rule.ruleId))
      errors.push(`Duplicate ruleId ${rule.ruleId}`);
    ruleIds.add(rule.ruleId);

    if (!["Low", "Moderate", "High"].includes(rule.weighting)) {
      errors.push(`${rule.ruleId} has invalid weighting ${rule.weighting}`);
    }
    if (
      ![
        "action",
        "escalation",
        "non_actionable_escalation",
        "manual_review",
      ].includes(rule.outcome.kind)
    ) {
      errors.push(
        `${rule.ruleId} has invalid outcome kind ${rule.outcome.kind}`,
      );
    }
    if (!Number.isInteger(rule.evaluationOrder) || rule.evaluationOrder < 1) {
      errors.push(`${rule.ruleId} has invalid evaluationOrder`);
    }

    for (const question of rule.requiredQuestions) {
      const prior = questionTypes.get(question.key);
      if (prior && prior !== question.type) {
        errors.push(`${question.key} has inconsistent question type`);
      }
      questionTypes.set(question.key, question.type);
    }

    const questionKeys = new Set(rule.requiredQuestions.map((q) => q.key));
    for (const clause of rule.predicate.all) {
      if (!questionKeys.has(clause.fact)) {
        errors.push(
          `${rule.ruleId} predicate references undeclared ${clause.fact}`,
        );
      }
    }
  }

  for (const alias of catalog.aliases) {
    if (!categories.has(alias.canonicalCategory)) {
      errors.push(
        `Alias ${alias.analyzerCategory} points to unknown ${alias.canonicalCategory}`,
      );
    }
  }

  return errors;
}
