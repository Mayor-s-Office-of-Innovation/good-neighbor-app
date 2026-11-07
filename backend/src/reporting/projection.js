// Built once per snapshot; nothing downstream recounts, so screens, CSVs and
// reports agree. Only `sites` holds names (of Sites); no table holds
// addresses, contact details, people or free text.

import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { activeCatalog } from "../analysis/guidance/catalog-registry.js";
import { resolveCategory } from "../analysis/guidance/category-resolver.js";
import { sqlString } from "../analytics/convert.js";
import { PACIFIC_TIME_ZONE } from "../lib/pacific-dates.js";
import { SITE_DAY_METRICS } from "./activity.js";
import {
  CONTRACT_VERSION,
  RULE_VERSION,
  assertNoJudgementFields,
} from "./contract.js";
import { publicContactState, siteContactState } from "./indicators.js";
import { RULES_SQL, TABLE_ORDER, snapshotMacrosSql } from "./projection-sql.js";

// Promoted columns where the converter has them, raw JSON otherwise. Copied
// once into temp tables, since the rules read some inputs more than once.
/** @type {Record<string, string>} */
const LAKE_INPUT_SQL = {
  in_tasks: `SELECT siteId, taskId, taskStatus AS status, createdAt, category,
    TRY_CAST(CASE WHEN severity = floor(severity) THEN severity END AS INTEGER)
      AS severity, kind, type,
    raw->>'$.checkId' AS checkId, raw->>'$.assessmentId' AS assessmentId,
    raw->>'$.conditionId' AS conditionId, raw->>'$.inProgressAt' AS inProgressAt,
    raw->>'$.completedAt' AS completedAt, resolvedAt, raw->>'$.updatedAt' AS updatedAt,
    raw->>'$.ruleId' AS ruleId,
    TRY_CAST(raw->>'$.maxAcceptableResponseHours' AS DOUBLE) AS maxAcceptableResponseHours
    FROM tasks`,
  in_conditions: `SELECT siteId, assessmentId, conditionId,
    CASE WHEN json_type(raw->'$.taskIds') = 'ARRAY'
      THEN from_json(raw->'$.taskIds', '["VARCHAR"]') END AS taskIds
    FROM conditions`,
  in_updates: `SELECT siteId, taskId, updateType AS type, occurredAt FROM task_updates`,
  in_links: `SELECT siteId, taskId, originalTaskId FROM duplicate_links`,
  in_overrides: `SELECT siteId, taskId FROM duplicate_overrides`,
  in_checks: `SELECT siteId, checkId, status, raw->>'$.flowType' AS flowType,
    startedAt, completedAt, synthesizedAt FROM checks`,
};
const SITES_SQL = `SELECT siteId, raw FROM sites`;
const AS_OF_SQL = `SELECT max(exportedAt) AS asOf FROM (
    SELECT exportedAt FROM checks UNION ALL SELECT exportedAt FROM tasks
    UNION ALL SELECT exportedAt FROM conditions
    UNION ALL SELECT exportedAt FROM task_updates
    UNION ALL SELECT exportedAt FROM duplicate_links
    UNION ALL SELECT exportedAt FROM duplicate_overrides
    UNION ALL SELECT exportedAt FROM sites)`;

/**
 * @param {any} conn
 * @param {string} sql
 * @returns {Promise<Record<string, any>[]>}
 */
async function rows(conn, sql) {
  const reader = await conn.runAndReadAll(sql);
  return reader.getRowObjectsJS();
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function isoOrNull(value) {
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" && value ? value : null;
}

/**
 * @param {string} category
 * @returns {string}
 */
function reportCategory(category) {
  const found = resolveCategory(category, activeCatalog());
  return found.kind === "resolved" ? found.category : category;
}

/**
 * Contacts are labelled "current", because the app keeps no contact history.
 * @param {Record<string, any>[]} sites
 * @param {string} evaluatedAt
 * @returns {{ sites: Record<string, any>[], siteContacts: Record<string, any>[] }}
 */
function buildSiteTables(sites, evaluatedAt) {
  return {
    sites: sites.map((s) => ({
      siteId: String(s.siteId),
      name: s.name ?? null,
      status: s.status ?? null,
      siteType: s.siteType ?? null,
      providerId: s.providerId ?? null,
      programId: s.leadProgramId ?? null,
      department: s.oversight?.managingCityDepartment || null,
      managerId: s.oversight?.cityProgramManagerId || null,
      hasLocation:
        Number.isFinite(s.location?.latitude) &&
        Number.isFinite(s.location?.longitude),
      hasPerimeter:
        typeof s.perimeter === "string" && s.perimeter.trim() !== "",
      createdAt: s.createdAt ?? null,
    })),
    siteContacts: sites.map((s) => {
      const pub = publicContactState(s);
      const site = siteContactState(s);
      return {
        siteId: String(s.siteId),
        publicContact: pub.state,
        publicContactReasons: pub.reasonCodes.join(","),
        siteContact: site.state,
        siteContactReasons: site.reasonCodes.join(","),
        basis: "current",
        observedAt: s.updatedAt ?? evaluatedAt,
      };
    }),
  };
}

const V = "VARCHAR";
const I = "INTEGER";
const B = "BOOLEAN";
// Timestamps stay ISO strings so no reader shifts them a time zone.
/** @type {Record<string, Record<string, string>>} */
export const TABLE_SCHEMAS = {
  site_days: {
    siteId: V,
    day: "DATE",
    ...Object.fromEntries(SITE_DAY_METRICS.map((m) => [m, I])),
  },
  issues: {
    issueId: V,
    siteId: V,
    checkId: V,
    source: V,
    createdAt: V,
    createdDay: "DATE",
    category: V,
    severity: I,
    severityBand: V,
    kind: V,
    type: V,
    status: V,
    deadlineAt: V,
    firstResponseAt: V,
    responseBasis: V,
    responseState: V,
    resolvedAt: V,
    reopened: B,
    sightings: I,
    followUpTasks: I,
    latestActivityAt: V,
  },
  site_contacts: {
    siteId: V,
    publicContact: V,
    publicContactReasons: V,
    siteContact: V,
    siteContactReasons: V,
    basis: V,
    observedAt: V,
  },
  sites: {
    siteId: V,
    name: V,
    status: V,
    siteType: V,
    providerId: V,
    programId: V,
    department: V,
    managerId: V,
    hasLocation: B,
    hasPerimeter: B,
    createdAt: V,
  },
};
for (const schema of Object.values(TABLE_SCHEMAS))
  assertNoJudgementFields(Object.keys(schema));

/**
 * Built in a side folder and swapped in, so a failed run can't mix old and new.
 * @param {string} dir
 * @param {(partial: string) => Promise<string[]>} write
 * @returns {Promise<string[]>} file names written
 */
async function swapIn(dir, write) {
  const partial = `${dir}.partial`;
  await rm(partial, { recursive: true, force: true });
  await mkdir(partial, { recursive: true });
  const written = await write(partial);
  await rm(dir, { recursive: true, force: true });
  await rename(partial, dir);
  return written;
}

const D = "DOUBLE";
// Types for rows handed in as JavaScript, matching what the lake reads give.
/** @type {Record<string, Record<string, string>>} */
const INPUT_SCHEMAS = {
  in_tasks: {
    siteId: V,
    taskId: V,
    status: V,
    createdAt: V,
    category: V,
    severity: D,
    kind: V,
    type: V,
    checkId: V,
    assessmentId: V,
    conditionId: V,
    inProgressAt: V,
    completedAt: V,
    resolvedAt: V,
    updatedAt: V,
    ruleId: V,
    maxAcceptableResponseHours: D,
  },
  in_conditions: {
    siteId: V,
    assessmentId: V,
    conditionId: V,
    taskIds: "VARCHAR[]",
  },
  in_updates: { siteId: V, taskId: V, type: V, occurredAt: V },
  in_links: { siteId: V, taskId: V, originalTaskId: V },
  in_overrides: { siteId: V, taskId: V },
  in_checks: {
    siteId: V,
    checkId: V,
    status: V,
    flowType: V,
    startedAt: V,
    completedAt: V,
    synthesizedAt: V,
  },
};

/** @type {Record<string, string>} projection table → rules table */
const SQL_TABLES = {
  site_days: "p_site_days",
  issues: "p_issues",
  site_contacts: "p_site_contacts",
  sites: "p_sites",
};

/**
 * @param {any} conn
 * @param {string} name
 * @param {Record<string, string>} schema
 * @param {Record<string, any>[]} list
 * @returns {Promise<void>}
 */
async function loadRows(conn, name, schema, list) {
  await conn.run(
    `CREATE OR REPLACE TEMP TABLE ${name} AS
     SELECT unnest(from_json($1::JSON, ${sqlString(`[${JSON.stringify(schema)}]`)}), recursive := true)`,
    [JSON.stringify(list)],
  );
}

/**
 * Rows handed in instead of the lake, shaped like its reads (INPUT_SCHEMAS).
 * @typedef {{ tasks?: Record<string, any>[], conditions?: Record<string, any>[], updates?: Record<string, any>[],
 *   links?: Record<string, any>[], overrides?: Record<string, any>[], checks?: Record<string, any>[],
 *   sites?: Record<string, any>[], asOf?: string | null }} ProjectionInputs
 */

/**
 * Counts in DuckDB, straight to Parquet. Without `inputs` it reads the lake views.
 * An empty table still gets a file, so readers see zero rows, not a missing file.
 * @param {any} conn
 * @param {string} dir
 * @param {{ evaluatedAt: string, snapshotId: string, inputs?: ProjectionInputs }} opts
 * @returns {Promise<{ manifest: Record<string, any>, written: string[] }>}
 */
export async function buildProjection(
  conn,
  dir,
  { evaluatedAt, snapshotId, inputs },
) {
  // A bad snapshot time would quietly mark every Issue as awaiting.
  if (!Number.isFinite(Date.parse(evaluatedAt)))
    throw new Error("buildProjection needs a valid evaluatedAt");
  try {
    return await project(conn, dir, { evaluatedAt, snapshotId, inputs });
  } finally {
    // Frees the connection's memory, even after a failed build.
    for (const name of TEMP_TABLES)
      await conn.run(`DROP TABLE IF EXISTS ${name}`);
    for (const name of TEMP_MACROS)
      await conn.run(`DROP MACRO IF EXISTS ${name}`);
  }
}

const TEMP_TABLES = [
  ...Object.keys(INPUT_SCHEMAS),
  "category_names",
  "rule_hours",
  "p_sites",
  "p_site_contacts",
  ...Array.from(RULES_SQL.matchAll(/TEMP TABLE (\w+)/g), (m) => m[1]),
];
const TEMP_MACROS = Array.from(
  snapshotMacrosSql(new Date(0).toISOString()).matchAll(/TEMP MACRO (\w+)/g),
  (m) => m[1],
);

/**
 * @param {any} conn
 * @param {string} dir
 * @param {{ evaluatedAt: string, snapshotId: string, inputs?: ProjectionInputs }} opts
 * @returns {Promise<{ manifest: Record<string, any>, written: string[] }>}
 */
async function project(conn, dir, { evaluatedAt, snapshotId, inputs }) {
  /** @type {Record<string, any>[]} */
  let siteRecords;
  /** @type {string | null} */
  let asOf;
  if (inputs) {
    for (const [name, schema] of Object.entries(INPUT_SCHEMAS))
      await loadRows(
        conn,
        name,
        schema,
        /** @type {any} */ (inputs)[name.slice(3)] ?? [],
      );
    siteRecords = inputs.sites ?? [];
    asOf = inputs.asOf ?? null;
  } else {
    for (const [name, sql] of Object.entries(LAKE_INPUT_SQL))
      await conn.run(`CREATE OR REPLACE TEMP TABLE ${name} AS ${sql}`);
    // The view's siteId falls back to the key when the item has none.
    siteRecords = (await rows(conn, SITES_SQL)).map((s) => ({
      ...JSON.parse(String(s.raw)),
      siteId: s.siteId,
    }));
    asOf = isoOrNull((await rows(conn, AS_OF_SQL))[0]?.asOf);
  }
  // Task status is the latest export's, so it can't be judged earlier.
  if (asOf && Date.parse(evaluatedAt) < Date.parse(asOf))
    throw new Error("evaluatedAt is before the lake's latest export");
  // The app's own resolver names each category, so no second alias list.
  const categories = await rows(
    conn,
    "SELECT DISTINCT category FROM in_tasks WHERE category <> ''",
  );
  await loadRows(
    conn,
    "category_names",
    { category: V, reportCategory: V },
    categories.map(({ category }) => ({
      category,
      reportCategory: reportCategory(category),
    })),
  );
  const ruleHours = new Map(
    activeCatalog().rules.map((r) => [r.ruleId, r.maxAcceptableResponseHours]),
  );
  await loadRows(
    conn,
    "rule_hours",
    { ruleId: V, hours: D },
    [...ruleHours].map(([ruleId, hours]) => ({ ruleId, hours })),
  );
  const { sites, siteContacts } = buildSiteTables(siteRecords, evaluatedAt);
  await loadRows(conn, "p_sites", TABLE_SCHEMAS.sites, sites);
  await loadRows(
    conn,
    "p_site_contacts",
    TABLE_SCHEMAS.site_contacts,
    siteContacts,
  );
  await conn.run(snapshotMacrosSql(evaluatedAt));
  await conn.run(RULES_SQL);

  /** @type {Record<string, number>} */
  const rowCounts = {};
  for (const [name, source] of Object.entries(SQL_TABLES))
    rowCounts[name] = Number(
      (await rows(conn, `SELECT count(*) AS n FROM ${source}`))[0].n,
    );
  const quality = (await rows(conn, "SELECT * FROM p_data_quality"))[0];
  const manifest = {
    contractVersion: CONTRACT_VERSION,
    ruleVersion: RULE_VERSION,
    snapshotId,
    asOf,
    evaluatedAt,
    timezone: PACIFIC_TIME_ZONE,
    rowCounts,
    dataQuality: Object.fromEntries(
      Object.entries(quality).map(([k, v]) => [k, Number(v)]),
    ),
  };
  const written = await swapIn(dir, async (partial) => {
    const names = [];
    for (const [name, source] of Object.entries(SQL_TABLES)) {
      // Cast to the contract, so a rule that drifts fails here, not in a reader.
      const columns = Object.entries(TABLE_SCHEMAS[name])
        .map(([column, type]) => `CAST("${column}" AS ${type}) AS "${column}"`)
        .join(", ");
      const order = TABLE_ORDER[name] ? `ORDER BY ${TABLE_ORDER[name]}` : "";
      await conn.run(
        `COPY (SELECT ${columns} FROM ${source} ${order})
         TO ${sqlString(join(partial, `${name}.parquet`))} (FORMAT PARQUET, COMPRESSION ZSTD)`,
      );
      names.push(`${name}.parquet`);
    }
    await writeFile(
      join(partial, "manifest.json"),
      JSON.stringify(manifest, null, 2),
    );
    return [...names, "manifest.json"];
  });
  return { manifest, written };
}
