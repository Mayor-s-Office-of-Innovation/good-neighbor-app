// Built once per snapshot; nothing downstream recounts, so screens, CSVs and
// reports agree. Only `sites` holds names (of Sites); no table holds
// addresses, contact details, people or free text.

import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sqlString } from "../analytics/convert.js";
import { PACIFIC_TIME_ZONE } from "../lib/pacific-dates.js";
import { SITE_DAY_METRICS, buildSiteDays } from "./activity.js";
import {
  CONTRACT_VERSION,
  RULE_VERSION,
  assertNoJudgementFields,
} from "./contract.js";
import {
  RULE_HOURS,
  publicContactState,
  siteContactState,
} from "./indicators.js";
import { buildIssueFacts, reportCategory } from "./issue-facts.js";
import { RULES_SQL, TABLE_ORDER, snapshotMacrosSql } from "./projection-sql.js";

// Promoted columns where the converter has them, raw JSON otherwise.
export const LAKE_INPUT_SQL = {
  tasks: `SELECT siteId, taskId, taskStatus AS status, createdAt, category,
    TRY_CAST(CASE WHEN severity = floor(severity) THEN severity END AS INTEGER)
      AS severity, kind, type,
    raw->>'$.checkId' AS checkId, raw->>'$.assessmentId' AS assessmentId,
    raw->>'$.conditionId' AS conditionId, raw->>'$.inProgressAt' AS inProgressAt,
    raw->>'$.completedAt' AS completedAt, resolvedAt, raw->>'$.updatedAt' AS updatedAt,
    raw->>'$.ruleId' AS ruleId,
    TRY_CAST(raw->>'$.maxAcceptableResponseHours' AS DOUBLE) AS maxAcceptableResponseHours
    FROM tasks`,
  conditions: `SELECT siteId, assessmentId, conditionId,
    CAST(raw->'$.taskIds' AS VARCHAR) AS taskIds FROM conditions`,
  updates: `SELECT siteId, taskId, updateType AS type, occurredAt FROM task_updates`,
  links: `SELECT siteId, taskId, originalTaskId FROM duplicate_links`,
  overrides: `SELECT siteId, taskId FROM duplicate_overrides`,
  checks: `SELECT siteId, checkId, status, raw->>'$.flowType' AS flowType,
    startedAt, completedAt, synthesizedAt FROM checks`,
  sites: `SELECT siteId, raw FROM sites`,
  asOf: `SELECT max(exportedAt) AS asOf FROM (
    SELECT exportedAt FROM checks UNION ALL SELECT exportedAt FROM tasks
    UNION ALL SELECT exportedAt FROM conditions
    UNION ALL SELECT exportedAt FROM task_updates
    UNION ALL SELECT exportedAt FROM duplicate_links
    UNION ALL SELECT exportedAt FROM duplicate_overrides
    UNION ALL SELECT exportedAt FROM sites)`,
};

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
 * @returns {string[]}
 */
function idList(value) {
  try {
    const list = JSON.parse(String(value ?? "[]"));
    return Array.isArray(list) ? list.map(String) : [];
  } catch {
    return [];
  }
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
 * Read everything the projection needs from the lake views.
 * @param {any} conn
 * @returns {Promise<{ inputs: import("./issue-facts.js").IssueInputs, sites: Record<string, any>[], asOf: string | null }>}
 */
export async function readLakeInputs(conn) {
  /** @type {Record<string, Record<string, any>[]>} */
  const read = {};
  // One connection runs one query at a time.
  for (const [name, sql] of Object.entries(LAKE_INPUT_SQL))
    read[name] = await rows(conn, sql);
  const {
    tasks,
    conditions,
    updates,
    links,
    overrides,
    checks,
    sites,
    asOf: freshness,
  } = read;
  return {
    inputs: {
      tasks: /** @type {any[]} */ (tasks),
      conditions: /** @type {any[]} */ (
        conditions.map((c) => ({ ...c, taskIds: idList(c.taskIds) }))
      ),
      updates: /** @type {any[]} */ (updates),
      links: /** @type {any[]} */ (links),
      overrides: /** @type {any[]} */ (overrides),
      checks: /** @type {any[]} */ (checks),
    },
    // The view's siteId falls back to the key when the item has none.
    sites: sites.map((s) => ({
      ...JSON.parse(String(s.raw)),
      siteId: s.siteId,
    })),
    asOf: isoOrNull(freshness[0]?.asOf),
  };
}

/**
 * Contacts are labelled "current", because the app keeps no contact history.
 * @param {Record<string, any>[]} sites
 * @param {string} evaluatedAt
 * @returns {{ sites: Record<string, any>[], siteContacts: Record<string, any>[] }}
 */
export function buildSiteTables(sites, evaluatedAt) {
  const sorted = [...sites].sort((a, b) =>
    String(a.siteId).localeCompare(String(b.siteId)),
  );
  return {
    sites: sorted.map((s) => ({
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
    siteContacts: sorted.map((s) => {
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

/**
 * @param {Awaited<ReturnType<typeof readLakeInputs>>} lake
 * @param {{ evaluatedAt: string, snapshotId: string }} opts
 * @returns {{ manifest: Record<string, any>, tables: Record<string, Record<string, any>[]> }}
 */
export function buildProjection(lake, { evaluatedAt, snapshotId }) {
  // A bad snapshot time would quietly mark every Issue as awaiting.
  if (!Number.isFinite(Date.parse(evaluatedAt)))
    throw new Error("buildProjection needs a valid evaluatedAt");
  // Task status is the latest export's, so it can't be judged earlier.
  if (lake.asOf && Date.parse(evaluatedAt) < Date.parse(lake.asOf))
    throw new Error("evaluatedAt is before the lake's latest export");
  const { issues, dropped } = buildIssueFacts(lake.inputs, evaluatedAt);
  const { siteDays, undatedChecks } = buildSiteDays(
    { checks: lake.inputs.checks, issues },
    evaluatedAt,
  );
  const { sites, siteContacts } = buildSiteTables(lake.sites, evaluatedAt);
  const tables = {
    site_days: siteDays,
    issues,
    site_contacts: siteContacts,
    sites,
  };
  // Rows must match the contract exactly; a stray field is a rule bug.
  for (const [name, table] of Object.entries(tables)) {
    const columns = Object.keys(TABLE_SCHEMAS[name]).join();
    const bad = table.find((r) => Object.keys(r).join() !== columns);
    if (bad) throw new Error(`${name} row does not match its contract`);
  }
  return {
    manifest: {
      contractVersion: CONTRACT_VERSION,
      ruleVersion: RULE_VERSION,
      snapshotId,
      asOf: lake.asOf,
      evaluatedAt,
      timezone: PACIFIC_TIME_ZONE,
      rowCounts: Object.fromEntries(
        Object.entries(tables).map(([name, t]) => [name, t.length]),
      ),
      dataQuality: { ...dropped, undatedChecks },
    },
    tables,
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

/**
 * Empty tables still get a file, so readers see zero rows, not a missing file.
 * @param {any} conn
 * @param {ReturnType<typeof buildProjection>} projection
 * @param {string} final
 * @returns {Promise<string[]>} file names written
 */
export async function writeProjection(conn, projection, final) {
  return swapIn(final, async (dir) => {
    const written = [];
    for (const [name, table] of Object.entries(projection.tables)) {
      const schema = TABLE_SCHEMAS[name];
      const target = join(dir, `${name}.parquet`);
      if (!table.length) {
        const empty = Object.entries(schema)
          .map(([column, type]) => `CAST(NULL AS ${type}) AS ${column}`)
          .join(", ");
        await conn.run(
          `COPY (SELECT ${empty} WHERE false) TO ${sqlString(target)} (FORMAT PARQUET, COMPRESSION ZSTD)`,
        );
      } else {
        const staged = join(dir, `${name}.ndjson`);
        await writeFile(staged, table.map((r) => JSON.stringify(r)).join("\n"));
        try {
          await conn.run(
            `COPY (SELECT * FROM read_json(${sqlString(staged)}, format = 'newline_delimited', columns = ${JSON.stringify(schema)}))
           TO ${sqlString(target)} (FORMAT PARQUET, COMPRESSION ZSTD)`,
          );
        } finally {
          await rm(staged, { force: true });
        }
      }
      written.push(`${name}.parquet`);
    }
    await writeFile(
      join(dir, "manifest.json"),
      JSON.stringify(projection.manifest, null, 2),
    );
    written.push("manifest.json");
    return written;
  });
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

// Copied once, since the rules read some inputs more than once.
/** @type {Record<string, string>} */
const LAKE_SQL_INPUTS = {
  in_tasks: LAKE_INPUT_SQL.tasks,
  in_conditions: `SELECT siteId, assessmentId, conditionId,
    CASE WHEN json_type(taskIds) = 'ARRAY' THEN from_json(taskIds, '["VARCHAR"]') END AS taskIds
    FROM (${LAKE_INPUT_SQL.conditions})`,
  in_updates: LAKE_INPUT_SQL.updates,
  in_links: LAKE_INPUT_SQL.links,
  in_overrides: LAKE_INPUT_SQL.overrides,
  in_checks: LAKE_INPUT_SQL.checks,
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
export async function loadRows(conn, name, schema, list) {
  await conn.run(
    `CREATE OR REPLACE TEMP TABLE ${name} AS
     SELECT unnest(from_json($1::JSON, ${sqlString(`[${JSON.stringify(schema)}]`)}), recursive := true)`,
    [JSON.stringify(list)],
  );
}

/**
 * @typedef {import("./issue-facts.js").IssueInputs & { sites?: Record<string, any>[], asOf?: string | null }} ProjectionInputs
 */

/**
 * Counts in DuckDB, straight to Parquet. Without `inputs` it reads the lake views.
 * @param {any} conn
 * @param {string} dir
 * @param {{ evaluatedAt: string, snapshotId: string, inputs?: Partial<ProjectionInputs> }} opts
 * @returns {Promise<{ manifest: Record<string, any>, written: string[] }>}
 */
export async function buildSqlProjection(
  conn,
  dir,
  { evaluatedAt, snapshotId, inputs },
) {
  // A bad snapshot time would quietly mark every Issue as awaiting.
  if (!Number.isFinite(Date.parse(evaluatedAt)))
    throw new Error("buildProjection needs a valid evaluatedAt");
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
    for (const [name, sql] of Object.entries(LAKE_SQL_INPUTS))
      await conn.run(`CREATE OR REPLACE TEMP TABLE ${name} AS ${sql}`);
    // The view's siteId falls back to the key when the item has none.
    siteRecords = (await rows(conn, LAKE_INPUT_SQL.sites)).map((s) => ({
      ...JSON.parse(String(s.raw)),
      siteId: s.siteId,
    }));
    asOf = isoOrNull((await rows(conn, LAKE_INPUT_SQL.asOf))[0]?.asOf);
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
  await loadRows(
    conn,
    "rule_hours",
    { ruleId: V, hours: D },
    [...RULE_HOURS].map(([ruleId, hours]) => ({ ruleId, hours })),
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
  // Frees the connection's memory for whatever runs next on it.
  for (const name of [
    ...Object.keys(INPUT_SCHEMAS),
    "category_names",
    "rule_hours",
    "p_sites",
    "p_site_contacts",
    ...Array.from(RULES_SQL.matchAll(/TEMP TABLE (\w+)/g), (m) => m[1]),
  ])
    await conn.run(`DROP TABLE IF EXISTS ${name}`);
  return { manifest, written };
}
