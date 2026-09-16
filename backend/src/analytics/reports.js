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

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { DuckDBInstance } from "@duckdb/node-api";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const s3 = new S3Client({});

/**
 * Build the canonical views over the lake. Exported for local reuse and tests.
 * @param {any} conn
 * @param {string} bucket
 */
export async function createViews(conn, bucket) {
  await conn.run(`INSTALL httpfs; LOAD httpfs;`);
  await conn.run(`CREATE SECRET (TYPE S3, PROVIDER CREDENTIAL_CHAIN);`);
  const base = `s3://${bucket}/readings`;

  // Latest-wins per primary key: partition by (pk, sk) — carried in the raw
  // JSON column, extracted with `raw->>'$.pk'` (string, not JSON-typed) —
  // ordered by the export stamp. union_by_name tolerates schema drift between
  // exports; the converter pins column types so real drift shouldn't happen.
  for (const entity of [
    "checks",
    "tasks",
    "conditions",
    "assessments",
    "artifacts",
    "analyses",
  ]) {
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
  }
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
  await conn.run(`COPY (${sql}) TO '${csvPath}' (FORMAT CSV, HEADER)`);
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
