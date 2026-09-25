// Canned analytics queries over the lake views (ADR 0013). One definition
// serves three consumers: the admin analytics page (buttons, no SQL
// knowledge needed), the catalog API, and the scheduled report Lambda
// (entries flagged `scheduled` are materialized daily with their default
// parameters).
//
// Conventions:
// - SQL is a single SELECT-shaped statement against the lake views
//   (lake-views.js): checks, tasks, conditions, assessments, artifacts,
//   analyses, sites, providers, devices. Promoted columns are the
//   converter's (convert.js ENTITY_COLUMNS); anything else comes from the raw
//   JSON column via `raw->>'$.field'`.
// - Parameters are `$name` placeholders bound through DuckDB prepared
//   statements (query.js) — never interpolated. Integers are always wrapped
//   in CAST($x AS INTEGER) because the binding may arrive as a DOUBLE.
// - The hive `date` column is the item's own event date in UTC
//   (startedAt / createdAt / reportedAt). Day-based windows use it so
//   partition pruning applies. Note: legal per-day compliance is a local-day
//   duty; these reports count UTC days until the converter partitions by
//   America/Los_Angeles.
// - Check status values: in_progress | analyzing | completed. Task status:
//   open | completed | cannot_do; task type: onsite | city_escalation.
//   gradeScore: Excellent=5 … Very Poor=1, NULL when no grade.

import { ENTITIES } from "./lake-views.js";

/**
 * @typedef {{
 *   name: string,
 *   label: string,
 *   type: "integer" | "string",
 *   default?: number | string,
 *   required?: boolean,
 *   min?: number,
 *   max?: number,
 *   hint?: string,
 * }} CatalogParam
 */

/**
 * @typedef {{
 *   id: string,
 *   title: string,
 *   description: string,
 *   group: string,
 *   params: CatalogParam[],
 *   sql: string,
 *   scheduled?: boolean,
 * }} CatalogQuery
 */

/** @type {CatalogParam} */
const DAYS_7 = {
  name: "days",
  label: "Days back",
  type: "integer",
  default: 7,
  min: 1,
  max: 365,
};
/** @type {CatalogParam} */
const DAYS_14 = { ...DAYS_7, default: 14 };
/** @type {CatalogParam} */
const DAYS_30 = { ...DAYS_7, default: 30 };
/** @type {CatalogParam} */
const SITE_ID = {
  name: "siteId",
  label: "Site",
  type: "string",
  required: true,
  hint: "A site id from the Sites list",
};

// Window predicate on the hive date column. `date IS NOT NULL` is implied by
// the comparison (NULL dates — rows the converter couldn't date — drop out).
const IN_WINDOW = "date >= current_date - CAST($days AS INTEGER)";

/** @type {CatalogQuery[]} */
export const CATALOG = [
  {
    id: "lake-freshness",
    title: "Lake freshness",
    description:
      "Row counts and the newest export stamp per entity. Exports run every 6 hours; the lake trails live data by up to that plus conversion time.",
    group: "Health",
    params: [],
    sql: ENTITIES.map(
      (entity) => `SELECT '${entity}' AS entity,
       count(*) AS rows,
       max(exportedAt) AS newest_export,
       max(date) AS newest_date
FROM ${entity}`,
    ).join("\nUNION ALL\n"),
  },
  {
    id: "sites",
    title: "Sites",
    description:
      "Every site in the lake with its provider and status. Use a site id from here for the per-site queries.",
    group: "Reference",
    params: [],
    sql: `SELECT siteId,
       name,
       raw->>'$.providerName' AS provider,
       raw->>'$.status' AS status,
       raw->>'$.address' AS address
FROM sites
ORDER BY name`,
  },
  {
    id: "checks-per-day",
    title: "Checks per day, citywide",
    description:
      "Daily check volume across all sites: started, completed, and how many sites were active. A completed check has a scorecard.",
    group: "Activity",
    params: [DAYS_14],
    sql: `SELECT date,
       count(*) AS checks,
       count(*) FILTER (status = 'completed') AS completed,
       count(DISTINCT siteId) AS active_sites
FROM checks
WHERE ${IN_WINDOW}
GROUP BY date
ORDER BY date`,
  },
  {
    id: "compliance-by-site",
    title: "Compliance by site",
    description:
      "Share of days each site met the legal duty of at least 3 completed checks per day. Counts every site on every day in the window, so inactive sites show 0%. Days are UTC.",
    group: "Compliance",
    params: [DAYS_7],
    scheduled: true,
    sql: `WITH dates AS (
  SELECT unnest(generate_series(
    current_date - CAST($days AS INTEGER),
    current_date - 1,
    INTERVAL 1 DAY
  ))::DATE AS date
),
site_ids AS (
  SELECT siteId FROM sites WHERE siteId IS NOT NULL
  UNION
  SELECT DISTINCT siteId FROM checks WHERE siteId IS NOT NULL
),
population AS (
  SELECT s.siteId, d.date FROM site_ids s CROSS JOIN dates d
),
per_day AS (
  SELECT siteId, date, count(*) AS checks
  FROM checks
  WHERE status = 'completed' AND date IS NOT NULL
  GROUP BY siteId, date
)
SELECT p.siteId,
       any_value(s.name) AS site,
       count(*) AS days,
       count(*) FILTER (COALESCE(c.checks, 0) >= 3) AS compliant_days,
       round(100.0 * count(*) FILTER (COALESCE(c.checks, 0) >= 3) / count(*), 1) AS compliance_pct,
       sum(COALESCE(c.checks, 0)) AS checks
FROM population p
LEFT JOIN per_day c ON c.siteId = p.siteId AND c.date = p.date
LEFT JOIN sites s ON s.siteId = p.siteId
GROUP BY p.siteId
ORDER BY compliance_pct ASC, p.siteId`,
  },
  {
    id: "worst-locations",
    title: "Worst locations",
    description:
      "Sites with the lowest average grade over the window. Grade score: Excellent 5 … Very Poor 1. Checks without a grade are left out.",
    group: "Cleanliness",
    params: [DAYS_7],
    scheduled: true,
    sql: `SELECT c.siteId,
       any_value(s.name) AS site,
       round(avg(c.gradeScore), 2) AS avg_grade_score,
       min(c.gradeScore) AS worst_grade_score,
       count(*) AS graded_checks
FROM checks c
LEFT JOIN sites s ON s.siteId = c.siteId
WHERE c.${IN_WINDOW}
  AND c.status = 'completed'
  AND c.gradeScore IS NOT NULL
GROUP BY c.siteId
ORDER BY avg_grade_score ASC, graded_checks DESC
LIMIT 25`,
  },
  {
    id: "grade-distribution",
    title: "Grade distribution",
    description:
      "How completed checks in the window split across Excellent, Good, Fair, Poor, and Very Poor.",
    group: "Cleanliness",
    params: [DAYS_7],
    sql: `SELECT grade,
       count(*) AS checks,
       round(100.0 * count(*) / sum(count(*)) OVER (), 1) AS pct
FROM checks
WHERE ${IN_WINDOW}
  AND status = 'completed'
GROUP BY grade
ORDER BY max(gradeScore) DESC NULLS LAST`,
  },
  {
    id: "open-tasks-by-site",
    title: "Open tasks by site",
    description:
      "Current task load per site for tasks created in the window: open, open city escalations, completed, and cannot-do. Status reflects the latest export.",
    group: "Tasks",
    params: [DAYS_30],
    scheduled: true,
    sql: `SELECT t.siteId,
       any_value(s.name) AS site,
       count(*) FILTER (t.taskStatus = 'open') AS open_tasks,
       count(*) FILTER (t.taskStatus = 'open' AND t.type = 'city_escalation') AS open_escalations,
       count(*) FILTER (t.taskStatus = 'completed') AS completed,
       count(*) FILTER (t.taskStatus = 'cannot_do') AS cannot_do
FROM tasks t
LEFT JOIN sites s ON s.siteId = t.siteId
WHERE t.${IN_WINDOW}
GROUP BY t.siteId
ORDER BY open_tasks DESC, t.siteId
LIMIT 50`,
  },
  {
    id: "open-escalations",
    title: "Open city escalations",
    description:
      "Every open task escalated to the city, most severe first, with the site and when it was created.",
    group: "Tasks",
    params: [],
    sql: `SELECT t.siteId,
       s.name AS site,
       t.shortId,
       t.category,
       t.severity,
       t.kind,
       t.createdAt
FROM tasks t
LEFT JOIN sites s ON s.siteId = t.siteId
WHERE t.taskStatus = 'open'
  AND t.type = 'city_escalation'
ORDER BY t.severity DESC NULLS LAST, t.createdAt
LIMIT 200`,
  },
  {
    id: "condition-categories",
    title: "Top condition categories",
    description:
      "Which kinds of conditions were reported most in the window, with average severity and how many sites saw each.",
    group: "Conditions",
    params: [DAYS_30],
    sql: `SELECT canonicalCategory AS category,
       count(*) AS conditions,
       round(avg(severity), 2) AS avg_severity,
       count(DISTINCT siteId) AS sites
FROM conditions
WHERE ${IN_WINDOW}
GROUP BY canonicalCategory
ORDER BY conditions DESC, category
LIMIT 50`,
  },
  {
    id: "inactive-sites",
    title: "Sites with no recent checks",
    description:
      "Sites with no completed check inside the window, and when each last had one. Sites that have never checked show an empty last check.",
    group: "Compliance",
    params: [DAYS_7],
    sql: `SELECT s.siteId,
       s.name AS site,
       s.raw->>'$.providerName' AS provider,
       max(c.date) AS last_check
FROM sites s
LEFT JOIN checks c ON c.siteId = s.siteId AND c.status = 'completed'
GROUP BY s.siteId, s.name, s.raw
HAVING max(c.date) IS NULL
    OR max(c.date) < current_date - CAST($days AS INTEGER)
ORDER BY last_check NULLS FIRST, site`,
  },
  {
    id: "evidence-mix",
    title: "Evidence mix",
    description:
      "How completed checks in the window were evidenced: photos, a written description, both, or nothing. Shows how often the text path replaces photos.",
    group: "Activity",
    params: [DAYS_30],
    sql: `SELECT COALESCE(raw->>'$.evidenceKind', 'unknown') AS evidence,
       count(*) AS checks,
       round(100.0 * count(*) / sum(count(*)) OVER (), 1) AS pct
FROM checks
WHERE ${IN_WINDOW}
  AND status = 'completed'
GROUP BY 1
ORDER BY checks DESC`,
  },
  {
    id: "provider-rollup",
    title: "Provider rollup",
    description:
      "Per provider: number of sites, completed checks in the window, and average grade score across those checks.",
    group: "Cleanliness",
    params: [DAYS_30],
    sql: `SELECT s.raw->>'$.providerId' AS providerId,
       any_value(s.raw->>'$.providerName') AS provider,
       count(DISTINCT s.siteId) AS sites,
       count(c.checkId) AS completed_checks,
       round(avg(c.gradeScore), 2) AS avg_grade_score
FROM sites s
LEFT JOIN checks c
  ON c.siteId = s.siteId
 AND c.status = 'completed'
 AND c.${IN_WINDOW}
GROUP BY 1
ORDER BY completed_checks DESC, provider`,
  },
  {
    id: "site-recent-checks",
    title: "Recent checks for one site",
    description:
      "The latest checks at a single site, newest first: when, status, grade, issue count, and how it was evidenced.",
    group: "Site detail",
    params: [SITE_ID, DAYS_14],
    sql: `SELECT date,
       startedAt,
       completedAt,
       status,
       grade,
       issueCount,
       maxSeverity,
       raw->>'$.evidenceKind' AS evidence
FROM checks
WHERE siteId = $siteId
  AND ${IN_WINDOW}
ORDER BY startedAt DESC
LIMIT 200`,
  },
  {
    id: "site-open-tasks",
    title: "Open tasks for one site",
    description: "Every open task at a single site, most severe first.",
    group: "Site detail",
    params: [SITE_ID],
    sql: `SELECT shortId,
       type,
       kind,
       category,
       severity,
       createdAt
FROM tasks
WHERE siteId = $siteId
  AND taskStatus = 'open'
ORDER BY severity DESC NULLS LAST, createdAt
LIMIT 200`,
  },
];

/**
 * Invalid caller-supplied parameters. Message is safe to echo to the admin.
 */
export class ParamError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "ParamError";
  }
}

/**
 * @param {string} id
 * @returns {CatalogQuery | undefined}
 */
export function getQuery(id) {
  return CATALOG.find((q) => q.id === id);
}

/**
 * Validate and coerce caller parameters against a query's declarations.
 * Unknown keys are ignored; declared ones are required or defaulted; types
 * and ranges are enforced. The result is what gets bound to the prepared
 * statement.
 * @param {CatalogQuery} query
 * @param {unknown} raw caller-supplied params (any JSON)
 * @returns {Record<string, number | string>}
 */
export function bindParams(query, raw) {
  const input =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? /** @type {Record<string, unknown>} */ (raw)
      : {};
  /** @type {Record<string, number | string>} */
  const bound = {};
  for (const p of query.params) {
    let value = input[p.name];
    if (value === undefined || value === null || value === "") {
      if (p.required) throw new ParamError(`${p.name} is required`);
      if (p.default === undefined) continue;
      value = p.default;
    }
    if (p.type === "integer") {
      const n = typeof value === "string" ? Number(value.trim()) : value;
      if (typeof n !== "number" || !Number.isInteger(n))
        throw new ParamError(`${p.name} must be a whole number`);
      if (p.min !== undefined && n < p.min)
        throw new ParamError(`${p.name} must be at least ${p.min}`);
      if (p.max !== undefined && n > p.max)
        throw new ParamError(`${p.name} must be at most ${p.max}`);
      bound[p.name] = n;
    } else {
      if (typeof value !== "string")
        throw new ParamError(`${p.name} must be text`);
      const s = value.trim();
      if (s.length === 0) throw new ParamError(`${p.name} is required`);
      if (s.length > 200)
        throw new ParamError(`${p.name} must be 200 characters or fewer`);
      bound[p.name] = s;
    }
  }
  return bound;
}

/**
 * Render a query with its default parameters as SQL literals, for the
 * scheduled report path (COPY … TO can't take prepared-statement params).
 * Only the catalog's own defaults are ever rendered — never caller input —
 * and strings are single-quote escaped regardless.
 * @param {CatalogQuery} query
 * @returns {string}
 */
export function renderWithDefaults(query) {
  let sql = query.sql;
  for (const p of query.params) {
    if (p.default === undefined) {
      throw new Error(
        `catalog query ${query.id} param ${p.name} has no default; cannot schedule`,
      );
    }
    const literal =
      p.type === "integer"
        ? String(p.default)
        : `'${String(p.default).replace(/'/g, "''")}'`;
    sql = sql.replaceAll(`$${p.name}`, literal);
  }
  return sql;
}

/**
 * The catalog as served to the admin page: everything the UI needs to
 * render a button, its parameter controls, and the SQL behind it.
 * @returns {CatalogQuery[]}
 */
export function listCatalog() {
  return CATALOG.map((q) => ({
    id: q.id,
    title: q.title,
    description: q.description,
    group: q.group,
    params: q.params,
    sql: q.sql,
    scheduled: q.scheduled === true,
  }));
}
