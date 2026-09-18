// DuckDB over the Parquet lake (ADR 0013 Phase 4). Opens an in-memory DuckDB,
// registers an S3 secret from the Lambda runtime's credential chain, defines
// the latest-wins deduped views (QUALIFY ... exported_at DESC — mutations are
// real: AP8 header synthesis, task transitions, condition answers), runs each
// report .sql from the bundled reports/ directory, and writes results to
// reports/<report-name>/<date>.csv.
//
// The same views + .sql files run from a laptop (DuckDB CLI or this module with
// local AWS credentials) — that's the ad-hoc analysis path and how new reports
// are developed before being scheduled.

import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { DuckDBInstance } from "@duckdb/node-api";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const s3 = new S3Client({});

// The column set each entity's view must expose, matching the converter's
// ENTITY_COLUMNS plus the derived pk/sk. Used to build schema-compatible empty
// views for entities that have no Parquet files yet (first deployment, or an
// export with no rows of that kind) — read_parquet throws on an empty glob,
// which would fail every scheduled report.
/** @type {Record<string, string[]>} */
const VIEW_COLUMNS = {
  checks: [
    "siteId",
    "checkId",
    "status",
    "startedAt",
    "completedAt",
    "grade",
    "gradeScore",
    "issueCount",
    "maxSeverity",
    "synthesizedAt",
    "exportedAt",
    "raw",
  ],
  tasks: [
    "siteId",
    "taskId",
    "shortId",
    "type",
    "kind",
    "category",
    "severity",
    "taskStatus",
    "createdAt",
    "resolvedAt",
    "exportedAt",
    "raw",
  ],
  conditions: [
    "siteId",
    "assessmentId",
    "conditionId",
    "canonicalCategory",
    "analyzerCategory",
    "severity",
    "outcome",
    "conditionStatus",
    "reportedAt",
    "exportedAt",
    "raw",
  ],
  assessments: [
    "siteId",
    "assessmentId",
    "policyVersion",
    "grade",
    "gradeScore",
    "reportedAt",
    "exportedAt",
    "raw",
  ],
  artifacts: [
    "siteId",
    "checkId",
    "artifactId",
    "placeId",
    "placeName",
    "capturedAt",
    "exportedAt",
    "raw",
  ],
  analyses: [
    "siteId",
    "checkId",
    "artifactId",
    "analysisStatus",
    "gradeScore",
    "analyzedAt",
    "exportedAt",
    "raw",
  ],
};

/**
 * Does this entity prefix have any Parquet files? S3 ListObjectsV2 with a
 * 1-object page cap is cheap and runs once per entity per report run.
 * @param {string} bucket
 * @param {string} entity
 * @returns {Promise<boolean>}
 */
async function hasParquetFiles(bucket, entity) {
  const res = await s3.send(
    new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: `readings/${entity}/`,
      MaxKeys: 1,
    }),
  );
  return (res.KeyCount ?? 0) > 0;
}

/**
 * Install httpfs + the S3 credential-chain secret. Separated from createViews
 * so tests can build views against local paths without AWS credentials (the
 * secret validates the chain at CREATE time).
 * @param {any} conn
 */
export async function installHttpfs(conn) {
  await conn.run(`INSTALL httpfs; LOAD httpfs;`);
  await conn.run(`CREATE SECRET (TYPE S3, PROVIDER CREDENTIAL_CHAIN);`);
}

/**
 * Build the canonical views over the lake. Exported for local reuse and tests.
 * Entities with no Parquet files yet get empty typed views with the exact
 * expected columns, so reports still run (returning empty results) instead of
 * failing the whole run on a missing glob.
 * @param {any} conn
 * @param {string} bucket
 * @param {{ install?: boolean }} [opts] set install=false when httpfs+secret
 *   are already installed (tests against local paths)
 */
export async function createViews(conn, bucket, opts = {}) {
  if (opts.install !== false) {
    await installHttpfs(conn);
  }
  const base = `s3://${bucket}/readings`;

  for (const entity of Object.keys(VIEW_COLUMNS)) {
    if (await hasParquetFiles(bucket, entity)) {
      // Latest-wins per primary key: partition by (pk, sk) — carried in the
      // raw JSON column, extracted with `raw->>'$.pk'` (string, not
      // JSON-typed) — ordered by the export stamp. union_by_name tolerates
      // schema drift between exports; the converter pins column types so real
      // drift shouldn't happen.
      await conn.run(`
        CREATE OR REPLACE VIEW ${entity} AS
        SELECT * EXCLUDE (pk, sk) FROM (
          SELECT *,
                 raw->>'$.pk' AS pk,
                 raw->>'$.sk' AS sk
          FROM read_parquet('${base}/${entity}/*/*.parquet', hive_partitioning = true, union_by_name = true)
        )
        QUALIFY row_number() OVER (PARTITION BY pk, sk ORDER BY exportedAt DESC) = 1;
      `);
    } else {
      // No files for this entity yet: an empty view with the exact expected
      // schema keeps report SQL bindable (aggregates return zero rows). The
      // hive `date` partition column is included since report SQL references
      // it like any other column.
      const cols = Object.entries(emptyViewSchema(VIEW_COLUMNS[entity]))
        .map(([name, type]) => `CAST(NULL AS ${type}) AS ${name}`)
        .concat(["CAST(NULL AS DATE) AS date"])
        .join(", ");
      await conn.run(`CREATE OR REPLACE VIEW ${entity} AS SELECT ${cols};`);
    }
  }
}

/**
 * DuckDB types for the empty views — mirroring the converter's pinned schema
 * (columnSchema): the exportedAt stamp is TIMESTAMP, numerics BIGINT, and
 * everything else VARCHAR.
 * @param {string[]} columns
 * @returns {Record<string, string>}
 */
function emptyViewSchema(columns) {
  const ts = new Set(["exportedAt"]);
  const numeric = new Set([
    "gradeScore",
    "issueCount",
    "maxSeverity",
    "severity",
  ]);
  return Object.fromEntries(
    columns.map((c) => [
      c,
      ts.has(c) ? "TIMESTAMP" : numeric.has(c) ? "BIGINT" : "VARCHAR",
    ]),
  );
}

/**
 * List the report .sql files bundled alongside the lambda (reports/*.sql next
 * to index.mjs in dist).
 * @param {string} reportsDir
 * @returns {string[]}
 */
export function listReportFiles(reportsDir) {
  return readdirSync(reportsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

/**
 * Strip one trailing statement terminator (and trailing whitespace) so the
 * report can be embedded in COPY (...): a semicolon closes the statement
 * before the wrapper's closing parenthesis and TO clause, which is a parser
 * error. Reports are authored as standalone runnable SQL, so this is done at
 * wrap time, not in the .sql files.
 * @param {string} sql
 * @returns {string}
 */
export function stripTrailingSemicolon(sql) {
  return sql.replace(/[;\s]+$/, "").trimEnd();
}

/**
 * Run one report and upload its CSV.
 * @param {any} conn
 * @param {string} bucket
 * @param {string} reportName
 * @param {string} sql
 * @param {string} date YYYY-MM-DD
 * @returns {Promise<string>} s3 key written
 */
export async function runReport(conn, bucket, reportName, sql, date) {
  const csvPath = `/tmp/${reportName}-${date}.csv`;
  await conn.run(
    `COPY (${stripTrailingSemicolon(sql)}) TO '${csvPath}' (FORMAT CSV, HEADER)`,
  );
  const body = readFileSync(csvPath);
  const key = `reports/${reportName}/${date}.csv`;
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ServerSideEncryption: "aws:kms",
      ContentType: "text/csv",
    }),
  );
  return key;
}

/**
 * Lambda entrypoint body. Exported for unit tests; the lambda entrypoint wraps
 * error logging.
 * @returns {Promise<{ reports: string[] }>}
 */
export async function runScheduledReports() {
  const bucket = process.env.LAKE_BUCKET;
  if (!bucket) throw new Error("Missing LAKE_BUCKET");

  const distDir = dirname(fileURLToPath(import.meta.url));
  const reportsDir = join(distDir, "reports");
  const sqlFiles = listReportFiles(reportsDir);
  if (sqlFiles.length === 0) throw new Error("no report .sql files bundled");

  const date = new Date().toISOString().slice(0, 10);
  const db = await DuckDBInstance.create(":memory:");
  const conn = await db.connect();
  /** @type {string[]} */
  const written = [];
  try {
    await createViews(conn, bucket);
    for (const file of sqlFiles) {
      const reportName = file.replace(/\.sql$/, "");
      const sql = readFileSync(join(reportsDir, file), "utf8");
      const key = await runReport(conn, bucket, reportName, sql, date);
      written.push(key);
    }
  } finally {
    conn.closeSync();
  }
  console.log(JSON.stringify({ marker: "AnalyticsReportsDone", written }));
  return { reports: written };
}
