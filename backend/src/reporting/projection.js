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
import { publicContactState, siteContactState } from "./indicators.js";
import { buildIssueFacts } from "./issue-facts.js";

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
 * Empty tables still get a file, so readers see zero rows, not a missing file.
 * Built in a side folder and swapped in, so a failed run can't mix old and new.
 * @param {any} conn
 * @param {ReturnType<typeof buildProjection>} projection
 * @param {string} dir
 * @returns {Promise<string[]>} file names written
 */
export async function writeProjection(conn, projection, dir) {
  const final = dir;
  dir = `${final}.partial`;
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
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
  await rm(final, { recursive: true, force: true });
  await rename(dir, final);
  return written;
}
