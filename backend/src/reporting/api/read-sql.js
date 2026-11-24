// The read model's queries over one snapshot's Parquet views, so read-model.js
// only builds replies. Every request value is a bound parameter.

import { sqlString } from "../../analytics/convert.js";
import { SITE_DAY_METRICS } from "../activity.js";
import { snapshotMacrosSql } from "../projection-sql.js";
import { TABLE_SCHEMAS } from "../projection.js";

const DAY_MS = 86_400_000;

/** @typedef {{ sql: string, params: Record<string, unknown> }} Statement */

/**
 * A table's contract columns in contract order, days as their YYYY-MM-DD text,
 * so a row has the keys and values the in-memory reader gave.
 * @param {string} table
 * @param {string} alias
 * @param {string[]} [only] just these columns, still in contract order
 * @returns {string}
 */
export function columnsOf(table, alias, only) {
  return Object.entries(TABLE_SCHEMAS[table])
    .filter(([column]) => !only || only.includes(column))
    .map(([column, type]) =>
      type === "DATE"
        ? `CAST(${alias}."${column}" AS VARCHAR) AS "${column}"`
        : `${alias}."${column}"`,
    )
    .join(", ");
}

// Each dated table and its day column; rows before their Site was added aren't its activity.
/** @type {Record<string, string>} */
const DATED = { site_days: "day", checks: "day", issues: "createdDay" };

/**
 * The statements that open a snapshot: its macros, a view per table and the
 * Site name ranks' table. The only text spliced in is the reader's own paths.
 * @param {{ schema: string, pathOf: (table: string) => string, evaluatedAt: string, unresolvedDays: number }} opts
 * @returns {string[]}
 */
export function openSql({ schema, pathOf, evaluatedAt, unresolvedDays }) {
  /** @param {string} table */
  const file = (table) => `read_parquet(${sqlString(pathOf(table))})`;
  return [
    `CREATE SCHEMA ${schema}`,
    `USE ${schema}`,
    // The projection's own time parsing, so long-unresolved reads times as it does.
    snapshotMacrosSql(evaluatedAt).replaceAll(
      "CREATE OR REPLACE TEMP MACRO",
      "CREATE MACRO",
    ),
    ...Object.keys(TABLE_SCHEMAS)
      .filter((table) => !DATED[table])
      .map((table) => `CREATE VIEW ${table} AS SELECT * FROM ${file(table)}`),
    `CREATE VIEW all_site_days AS SELECT * FROM ${file("site_days")}`,
    `CREATE VIEW all_checks AS SELECT * FROM ${file("checks")}`,
    // As isLongUnresolved judges it, at the snapshot's evaluation time.
    `CREATE VIEW all_issues AS SELECT *,
       parse_time(createdAt) AS createdTs,
       CASE WHEN responseState IN ('overdue', 'late') THEN false
         ELSE coalesce(epoch_ms(CASE WHEN coalesce(resolvedAt, '') <> ''
             THEN parse_time(resolvedAt) ELSE snapshot_at() END)
           - epoch_ms(parse_time(createdAt)) > ${unresolvedDays * DAY_MS}, false)
       END AS longUnresolved
     FROM ${file("issues")}`,
    `CREATE VIEW site_added AS
       SELECT siteId, pacific_day(parse_time(createdAt)) AS addedDay FROM sites`,
    // Dropped once here, so every total, comparison and list counts the same days.
    ...Object.entries(DATED).map(
      ([
        table,
        column,
      ]) => `CREATE VIEW ${table} AS SELECT r.* FROM all_${table} r
       WHERE NOT coalesce(r.${column} < (SELECT a.addedDay FROM site_added a
         WHERE a.siteId = r.siteId LIMIT 1), false)`,
    ),
    `CREATE TABLE site_rank (siteId VARCHAR, nameRank INTEGER)`,
  ];
}

export const SITE_RANK_INSERT = `INSERT INTO site_rank
  SELECT unnest(CAST($ids AS VARCHAR[])), unnest(CAST($ranks AS INTEGER[]))`;

export const OPEN_FACTS_SQL = {
  sites: `SELECT ${columnsOf("sites", "s")} FROM sites s`,
  contacts: `SELECT ${columnsOf("site_contacts", "c")} FROM site_contacts c`,
  // Over all three dated tables, as the in-memory reader read them.
  coverageStart: `SELECT CAST(least(
      (SELECT min(day) FROM all_site_days), (SELECT min(day) FROM all_checks),
      (SELECT min(createdDay) FROM all_issues)) AS VARCHAR) AS coverageStart`,
  categories: `SELECT DISTINCT category FROM issues
    WHERE coalesce(category, '') <> ''`,
  dataDays: `SELECT DISTINCT CAST(day AS VARCHAR) AS day FROM site_days
    ORDER BY day`,
};

/**
 * Rows only for these Sites; null means every Site in the snapshot's list,
 * which leaves out records of Sites the list doesn't hold, as before.
 * @param {string} alias
 * @param {string[] | null} ids
 * @returns {string}
 */
const siteScope = (alias, ids) =>
  ids
    ? `${alias}.siteId IN (SELECT unnest(CAST($ids AS VARCHAR[])))`
    : `${alias}.siteId IN (SELECT siteId FROM sites)`;

/**
 * @param {string} alias
 * @param {string} column
 * @param {string} start
 * @param {string} end
 */
const within = (alias, column, start, end) =>
  `${alias}.${column} >= CAST($${start} AS DATE) AND ${alias}.${column} < CAST($${end} AS DATE)`;

/**
 * @param {string} prefix
 * @param {string} [filter]
 */
const metricSums = (prefix, filter) =>
  SITE_DAY_METRICS.map(
    (m) =>
      `CAST(coalesce(sum(d."${m}")${filter ? ` FILTER (WHERE ${filter})` : ""}, 0) AS INTEGER) AS "${prefix}${m}"`,
  ).join(",\n  ");

/**
 * Each range's site_days totals, one column set per range, optionally by Site.
 * @param {{ startDay: string, endDay: string }[]} ranges
 * @param {string[] | null} ids
 * @param {boolean} bySite
 * @returns {Statement}
 */
export function rangeSums(ranges, ids, bySite) {
  /** @type {Record<string, unknown>} */
  const params = ids ? { ids } : {};
  ranges.forEach((r, k) => {
    params[`s${k}`] = r.startDay;
    params[`e${k}`] = r.endDay;
  });
  const inRange = ranges.map((_, k) => within("d", "day", `s${k}`, `e${k}`));
  return {
    sql: `SELECT ${bySite ? "d.siteId, " : ""}${ranges
      .map((_, k) => metricSums(`r${k}_`, inRange[k]))
      .join(",\n  ")}
      FROM site_days d
      WHERE ${siteScope("d", ids)} AND (${inRange.map((c) => `(${c})`).join(" OR ")})
      ${bySite ? "GROUP BY d.siteId" : ""}`,
    params,
  };
}

/**
 * Each Site's period totals from the day it was added, its perimeter Checks on
 * its own whole days, and the Issues its Issues per 30 days counts.
 * @param {string[]} ids
 * @param {string[]} from each Site's first day in the period
 * @param {(string | null)[]} starts whole days' first day per Site, or null
 * @param {(string | null)[]} ends
 * @param {(string | null)[]} spans Issues per 30 days' first day per Site, or null
 * @param {{ startDay: string, endDay: string }} period
 * @returns {Statement}
 */
export function siteFactSums(ids, from, starts, ends, spans, period) {
  return {
    sql: `WITH w AS (SELECT unnest(CAST($ids AS VARCHAR[])) AS siteId,
        unnest(CAST($from AS DATE[])) AS wf,
        unnest(CAST($starts AS DATE[])) AS ws, unnest(CAST($ends AS DATE[])) AS we,
        unnest(CAST($spans AS DATE[])) AS sp)
      SELECT d.siteId, ${metricSums("")},
        CAST(coalesce(sum(d.completedPerimeterChecks)
          FILTER (WHERE d.day >= w.ws AND d.day < w.we), 0) AS INTEGER) AS wholeDayChecks,
        CAST(coalesce(sum(d.issuesCreated)
          FILTER (WHERE d.day >= w.sp), 0) AS INTEGER) AS spanIssues
      FROM site_days d JOIN w ON w.siteId = d.siteId
      WHERE ${within("d", "day", "start", "end")} AND d.day >= w.wf
      GROUP BY d.siteId`,
    params: {
      ids,
      from,
      starts,
      ends,
      spans,
      start: period.startDay,
      end: period.endDay,
    },
  };
}

/**
 * The days each Site owed Checks in its window, with what it owed and did.
 * @param {string[]} ids
 * @param {string[]} starts
 * @param {string[]} ends
 * @returns {Statement}
 */
export function owedSums(ids, starts, ends) {
  return {
    sql: `WITH w AS (SELECT unnest(CAST($ids AS VARCHAR[])) AS siteId,
        unnest(CAST($starts AS DATE[])) AS ws, unnest(CAST($ends AS DATE[])) AS we)
      SELECT o.siteId, CAST(count(*) AS INTEGER) AS days,
        CAST(coalesce(sum(o.checksOwed), 0) AS INTEGER) AS owed,
        CAST(coalesce(sum(d.completedPerimeterChecks), 0) AS INTEGER) AS completed
      FROM checks_owed o
      JOIN w ON w.siteId = o.siteId AND o.day >= w.ws AND o.day < w.we
      LEFT JOIN site_days d ON d.siteId = o.siteId AND d.day = o.day
        AND ${within("d", "day", "first", "last")}
      GROUP BY o.siteId`,
    // Fixed bounds DuckDB can push into the scan, so it skips site_days' row groups outside every window.
    params: {
      ids,
      starts,
      ends,
      first: starts.reduce((a, b) => (b < a ? b : a), starts[0]),
      last: ends.reduce((a, b) => (b > a ? b : a), ends[0]),
    },
  };
}

/**
 * Each Site's period Issues by severity band, from the day it was added.
 * @param {string[]} ids
 * @param {string[]} from each Site's first day in the period
 * @param {{ startDay: string, endDay: string }} period
 * @returns {Statement}
 */
export function issueBands(ids, from, period) {
  return {
    sql: `WITH w AS (SELECT DISTINCT * FROM (SELECT unnest(CAST($ids AS VARCHAR[])) AS siteId,
        unnest(CAST($from AS DATE[])) AS wf))
      SELECT i.siteId, i.severityBand, CAST(count(*) AS INTEGER) AS n,
        max(i.severity) FILTER (WHERE i.severity > 0) AS maxSeverity,
        CAST(count(*) FILTER (WHERE i.longUnresolved) AS INTEGER) AS longUnresolved
      FROM issues i JOIN w ON w.siteId = i.siteId
      WHERE ${within("i", "createdDay", "start", "end")} AND i.createdDay >= w.wf
      GROUP BY i.siteId, i.severityBand`,
    params: { ids, from, start: period.startDay, end: period.endDay },
  };
}

/**
 * One Site's day rows in a period.
 * @param {string} siteId
 * @param {{ startDay: string, endDay: string }} period
 * @returns {Statement}
 */
export function siteDays(siteId, period) {
  return {
    sql: `SELECT ${columnsOf("site_days", "d")} FROM site_days d
      WHERE d.siteId = $siteId AND ${within("d", "day", "start", "end")}`,
    params: { siteId, start: period.startDay, end: period.endDay },
  };
}

/**
 * Totals per bucket, by its index in the lists.
 * @param {{ start: string, end: string }[]} buckets
 * @param {string[] | null} ids
 * @returns {Statement}
 */
export function bucketSums(buckets, ids) {
  return {
    sql: `WITH b AS (SELECT unnest(CAST($starts AS DATE[])) AS bs,
        unnest(CAST($ends AS DATE[])) AS be, unnest(CAST($ks AS INTEGER[])) AS k)
      SELECT b.k, ${metricSums("")}
      FROM b JOIN site_days d ON d.day >= b.bs AND d.day < b.be
      WHERE ${siteScope("d", ids)}
      GROUP BY b.k`,
    params: {
      ...(ids && { ids }),
      starts: buckets.map((b) => b.start),
      ends: buckets.map((b) => b.end),
      ks: buckets.map((_, k) => k),
    },
  };
}

/**
 * The period's Issues per category; a blank one counts as unknown.
 * @param {string[] | null} ids
 * @param {{ startDay: string, endDay: string }} period
 * @returns {Statement}
 */
export function categoryCounts(ids, period) {
  return {
    sql: `SELECT coalesce(i.category, 'unknown') AS category,
        CAST(count(*) AS INTEGER) AS issues,
        CAST(count(*) FILTER (WHERE i.severityBand = 'severe') AS INTEGER) AS severeIssues
      FROM issues i
      WHERE ${siteScope("i", ids)} AND ${within("i", "createdDay", "start", "end")}
      GROUP BY 1`,
    params: {
      ...(ids && { ids }),
      start: period.startDay,
      end: period.endDay,
    },
  };
}

/**
 * The list filters as SQL, bound; values were checked against LIST_FILTERS.
 * @type {Record<"issues" | "checks", Record<string, (value: string) => { sql: string, params: Record<string, unknown> }>>}
 */
const FILTER_SQL = {
  issues: {
    severityBand: (v) => ({
      sql: "r.severityBand IN (SELECT unnest(CAST($severityBand AS VARCHAR[])))",
      params: { severityBand: v.split(",") },
    }),
    responseState: (v) => ({
      sql: "r.responseState IN (SELECT unnest(CAST($responseState AS VARCHAR[])))",
      params: { responseState: v.split(",") },
    }),
    source: (v) => ({ sql: "r.source = $source", params: { source: v } }),
    category: (v) => ({
      sql: "r.category = $category",
      params: { category: v },
    }),
    issueStatus: (v) => ({
      sql:
        v === "resolved" ? "r.resolvedAt IS NOT NULL" : "r.resolvedAt IS NULL",
      params: {},
    }),
    concern: (v) => ({
      sql:
        v === "slowResponse"
          ? "(r.responseState IN ('overdue', 'late') OR r.longUnresolved)"
          : "r.severityBand = 'severe'",
      params: {},
    }),
  },
  checks: {
    state: (v) => ({ sql: "r.state = $state", params: { state: v } }),
    source: (v) => ({ sql: "r.source = $source", params: { source: v } }),
  },
};

const RECORDS = {
  issues: { table: "issues", day: "createdDay", id: "issueId" },
  checks: { table: "checks", day: "day", id: "checkId" },
};

// Sort keys as SQL; a name sorts by its rank, since SQL can't copy the collator.
/** @type {Record<"issues" | "checks", Record<string, string>>} */
const SORT_SQL = {
  issues: {
    createdAt: "r.createdAt",
    latestActivityAt: "r.latestActivityAt",
    severity: "r.severity",
    deadlineAt: "r.deadlineAt",
    siteName: "n.nameRank",
  },
  checks: { activityAt: "r.activityAt", siteName: "n.nameRank" },
};

/**
 * The WHERE for an Issues or Checks list.
 * @param {"issues" | "checks"} kind
 * @param {string[] | null} ids
 * @param {{ startDay: string, endDay: string }} period
 * @param {Record<string, string>} filters
 */
function recordWhere(kind, ids, period, filters) {
  const { day } = RECORDS[kind];
  const parts = [siteScope("r", ids), within("r", day, "start", "end")];
  /** @type {Record<string, unknown>} */
  const params = {
    ...(ids && { ids }),
    start: period.startDay,
    end: period.endDay,
  };
  for (const [name, value] of Object.entries(filters)) {
    const one = FILTER_SQL[kind][name]?.(value);
    if (!one) continue;
    parts.push(one.sql);
    Object.assign(params, one.params);
  }
  return { where: parts.join(" AND "), params };
}

/**
 * @param {"issues" | "checks"} kind
 * @param {string[] | null} ids
 * @param {{ startDay: string, endDay: string }} period
 * @param {Record<string, string>} filters
 * @returns {Statement}
 */
export function recordCount(kind, ids, period, filters) {
  const { where, params } = recordWhere(kind, ids, period, filters);
  return {
    sql: `SELECT CAST(count(*) AS INTEGER) AS n FROM ${RECORDS[kind].table} r WHERE ${where}`,
    params,
  };
}

/**
 * A sorted list of Issues or Checks with each Site's name, as a page or a CSV.
 * Checks can carry the IDs of the Issues each raised.
 * @param {"issues" | "checks"} kind
 * @param {{ ids: string[] | null, period: { startDay: string, endDay: string }, filters: Record<string, string>, sort: { key: string, dir: "asc" | "desc" }, page?: { limit: number, offset: number }, issueIds?: boolean, only?: string[] }} opts
 * @returns {Statement}
 */
export function recordList(
  kind,
  { ids, period, filters, sort, page, issueIds = false, only },
) {
  const { table, id } = RECORDS[kind];
  const { where, params } = recordWhere(kind, ids, period, filters);
  const key = SORT_SQL[kind][sort.key];
  if (!key) throw new Error(`no SQL for the ${sort.key} sort`);
  // Blanks last either way; ties always ascending, as sortRows breaks them.
  const dir = sort.dir === "desc" ? "DESC" : "ASC";
  const raised = issueIds
    ? `LEFT JOIN (SELECT siteId, checkId, list(issueId ORDER BY issueId) AS issueIds
         FROM issues WHERE coalesce(checkId, '') <> '' GROUP BY siteId, checkId) x
       ON x.siteId = r.siteId AND x.checkId = r.checkId`
    : "";
  return {
    sql: `SELECT ${columnsOf(table, "r", only)}, s.name AS siteName
        ${issueIds ? ", coalesce(x.issueIds, []) AS issueIds" : ""}
      FROM ${table} r
      LEFT JOIN sites s ON s.siteId = r.siteId
      LEFT JOIN site_rank n ON n.siteId = r.siteId
      ${raised}
      WHERE ${where}
      ORDER BY ${key} ${dir} NULLS LAST, r.siteId, r.${id}
      ${page ? "LIMIT $limit OFFSET $offset" : ""}`,
    params: page
      ? { ...params, limit: page.limit, offset: page.offset }
      : params,
  };
}

/**
 * Up to two records with this ID, so a shared ID can be told apart.
 * @param {"issues" | "checks"} kind
 * @param {string} recordId
 * @param {string | undefined} siteId
 * @returns {Statement}
 */
export function recordById(kind, recordId, siteId) {
  const { table, id } = RECORDS[kind];
  return {
    // From every row, so a record linked from elsewhere still opens.
    sql: `SELECT ${columnsOf(table, "r")} FROM all_${table} r
      WHERE r.${id} = $recordId ${siteId ? "AND r.siteId = $siteId" : ""}
      LIMIT 2`,
    params: { recordId, ...(siteId && { siteId }) },
  };
}

/**
 * A Check's Issues, in the order the projection writes them within a Site.
 * @param {string} siteId
 * @param {string} checkId
 * @returns {Statement}
 */
export function checkIssues(siteId, checkId) {
  return {
    sql: `SELECT ${columnsOf("issues", "i")} FROM issues i
      WHERE i.siteId = $siteId AND i.checkId = $checkId
      ORDER BY i.createdTs, i.issueId`,
    params: { siteId, checkId },
  };
}

/**
 * The period's Severe Issues of these Sites, for a report.
 * @param {string[]} ids
 * @param {{ startDay: string, endDay: string }} period
 * @returns {Statement}
 */
export function severeIssues(ids, period) {
  return {
    sql: `SELECT ${columnsOf("issues", "i")} FROM issues i
      WHERE ${siteScope("i", ids)} AND i.severityBand = 'severe'
        AND ${within("i", "createdDay", "start", "end")}
      ORDER BY i.siteId, i.createdTs, i.issueId`,
    params: { ids, start: period.startDay, end: period.endDay },
  };
}
