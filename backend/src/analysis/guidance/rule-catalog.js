/** @typedef {"Low" | "Moderate" | "High"} RuleWeighting */
/** @typedef {"action" | "escalation" | "manual_review"} OutcomeKind */

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
 * @param {string} raw
 * @returns {string[]}
 */
export function splitLines(raw) {
  return cleanCell(raw)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * @param {string} raw
 * @param {string} category311
 * @returns {{ code: string, payload: Record<string, unknown> }[]}
 */
export function parseAppActions(raw, category311) {
  return splitLines(raw).map((line) => {
    if (line.includes("311")) {
      return {
        code: "create_311_ticket",
        payload: { category311: cleanCell(category311) || null },
      };
    }
    if (line.includes("phone app")) {
      const phone = line.match(/\((\d{3})\)\s*(\d{3})-(\d{4})/);
      return {
        code: "open_phone",
        payload: {
          phoneNumber: phone
            ? `(${phone[1]}) ${phone[2]}-${phone[3]}`
            : "911",
        },
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
 * @param {object} opts
 * @param {string} opts.policyVersion
 * @param {string[][]} opts.rows
 * @param {{ analyzerCategory: string, canonicalCategory: string }[]} opts.aliases
 * @returns {GuidanceCatalog}
 */
export function buildCatalog({ policyVersion, rows, aliases }) {
  return {
    policyVersion,
    aliases,
    rules: rows.map((row) => {
      const [
        category,
        weighting,
        ruleId,
        evaluationOrder,
        severity,
        askUser,
        userResponse,
        thenKind,
        label,
        buttons,
        appAction,
        category311,
        guidance,
        cannotDoReasons,
        source,
      ] = row;

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
          kind: /** @type {OutcomeKind} */ (cleanCell(thenKind).toLowerCase()),
          label: cleanCell(label),
          buttons: splitLines(buttons),
          appActions: parseAppActions(appAction, category311),
          category311: cleanCell(category311) || null,
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
    if (ruleIds.has(rule.ruleId)) errors.push(`Duplicate ruleId ${rule.ruleId}`);
    ruleIds.add(rule.ruleId);

    if (!["Low", "Moderate", "High"].includes(rule.weighting)) {
      errors.push(`${rule.ruleId} has invalid weighting ${rule.weighting}`);
    }
    if (!["action", "escalation", "manual_review"].includes(rule.outcome.kind)) {
      errors.push(`${rule.ruleId} has invalid outcome kind ${rule.outcome.kind}`);
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
        errors.push(`${rule.ruleId} predicate references undeclared ${clause.fact}`);
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
