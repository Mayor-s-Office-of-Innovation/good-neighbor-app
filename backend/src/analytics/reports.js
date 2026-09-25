// Scheduled reports over the Parquet lake (ADR 0013 Phase 4). Opens an
// in-memory DuckDB, builds the shared lake views (lake-views.js), runs every
// catalog query flagged `scheduled` (catalog.js) with its default
// parameters, and writes each result to reports/<query-id>/<date>.csv.
//
// The catalog is the single definition: the same SQL the admin analytics
// page runs on demand is what gets materialized here, so a report never
// drifts from its dashboard.
//
// This engine writes CSVs to /tmp, so it does NOT apply the lake-views
// lockdown (that is for the admin query engine, which runs untrusted SQL).

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { DuckDBInstance } from "@duckdb/node-api";
import { readFileSync } from "node:fs";
import { CATALOG, renderWithDefaults } from "./catalog.js";
import {
  createViews as createLakeViews,
  installHttpfs,
  stripTrailingSemicolon,
} from "./lake-views.js";

export { installHttpfs, stripTrailingSemicolon };

const s3 = new S3Client({});

/**
 * Build the canonical views over the lake with this module's S3 client.
 * @param {any} conn
 * @param {string} bucket
 * @param {{ install?: boolean }} [opts] set install=false when httpfs+secret
 *   are already installed (tests against local paths)
 * @returns {Promise<{ empty: string[] }>}
 */
export function createViews(conn, bucket, opts = {}) {
  return createLakeViews(conn, bucket, { ...opts, s3 });
}

/**
 * The catalog entries materialized on the schedule, rendered with their
 * default parameters.
 * @returns {{ id: string, sql: string }[]}
 */
export function scheduledReports() {
  return CATALOG.filter((q) => q.scheduled).map((q) => ({
    id: q.id,
    sql: renderWithDefaults(q),
  }));
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

  const reports = scheduledReports();
  if (reports.length === 0) throw new Error("no scheduled catalog queries");

  const date = new Date().toISOString().slice(0, 10);
  const db = await DuckDBInstance.create(":memory:");
  const conn = await db.connect();
  /** @type {string[]} */
  const written = [];
  try {
    await createViews(conn, bucket);
    for (const { id, sql } of reports) {
      written.push(await runReport(conn, bucket, id, sql, date));
    }
  } finally {
    conn.closeSync();
  }
  console.log(JSON.stringify({ marker: "AnalyticsReportsDone", written }));
  return { reports: written };
}
