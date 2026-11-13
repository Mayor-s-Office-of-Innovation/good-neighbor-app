// Daily reports over the lake views (ADR 0013). The scheduled report Lambda
// (reports.js) writes each entry to a CSV with its default parameters.
//
// Conventions:
// - SQL is a single SELECT-shaped statement against the lake views
//   (lake-views.js). Promoted columns are the converter's (convert.js
//   ENTITY_COLUMNS); anything else comes from the raw JSON column via
//   `raw->>'$.field'`.
// - Parameters are `$name` placeholders, rendered as literals because
//   COPY … TO can't take prepared-statement parameters.
// - The hive `date` column is the item's own event date in UTC
//   (startedAt / createdAt / reportedAt). Day-based windows use it so
//   partition pruning applies, so they count UTC days, not Pacific ones.
// - Check status values: in_progress | analyzing | completed. Task status:
//   open | completed; task type: onsite | city_escalation.
//   gradeScore: Excellent=5 … Very Poor=1, NULL when no grade.

/**
 * @typedef {{
 *   name: string,
 *   type: "integer" | "string",
 *   default: number | string,
 * }} CatalogParam
 */

/**
 * @typedef {{
 *   id: string,
 *   description: string,
 *   params: CatalogParam[],
 *   sql: string,
 * }} CatalogQuery
 */

/** @param {number} value @returns {CatalogParam} */
const days = (value) => ({ name: "days", type: "integer", default: value });

// Window predicate on the hive date column. `date IS NOT NULL` is implied by
// the comparison (NULL dates — rows the converter couldn't date — drop out).
const IN_WINDOW = "date >= current_date - CAST($days AS INTEGER)";

/** @type {CatalogQuery[]} */
export const CATALOG = [
  {
    id: "worst-locations",
    description:
      "Sites with the lowest average grade over the window. Grade score: Excellent 5 … Very Poor 1. Checks without a grade are left out.",
    params: [days(7)],
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
    id: "open-tasks-by-site",
    description:
      "Current task load per site for tasks created in the window: open, open city escalations, and completed. Status reflects the latest export.",
    params: [days(30)],
    sql: `SELECT t.siteId,
       any_value(s.name) AS site,
       count(*) FILTER (t.taskStatus = 'open') AS open_tasks,
       count(*) FILTER (t.taskStatus = 'open' AND t.type = 'city_escalation' AND coalesce(t.raw->>'$.deliberate311DeliveryMode', 'production') <> 'simulated') AS open_escalations,
       count(*) FILTER (t.taskStatus = 'completed') AS completed
FROM tasks t
LEFT JOIN sites s ON s.siteId = t.siteId
WHERE t.${IN_WINDOW}
GROUP BY t.siteId
ORDER BY open_tasks DESC, t.siteId
LIMIT 50`,
  },
];

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
    const literal =
      p.type === "integer"
        ? String(p.default)
        : `'${String(p.default).replace(/'/g, "''")}'`;
    sql = sql.replaceAll(`$${p.name}`, literal);
  }
  return sql;
}
