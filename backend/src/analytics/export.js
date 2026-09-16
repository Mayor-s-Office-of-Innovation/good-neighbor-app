// Scheduled incremental DynamoDB PITR export (ADR 0013 Phase 2). Every 6 hours:
// start an INCREMENTAL_EXPORT from the persisted watermark to a fixed endpoint,
// then advance the watermark to that endpoint. The watermark lives in the app's
// single table (pk = ANALYTICS#EXPORT, sk = #WATERMARK) — never clock-derived,
// because "now minus 24h" drifts and creates gaps or overlaps.
//
// The export service itself writes to s3://<lake>/raw/AWSDynamoDB/<export-id>/
// (bucket policy in analytics.tf); completion is signalled by
// manifest-summary.json landing, which triggers the convert Lambda.
//
// ExportToTime must trail current time by at least 15 minutes (DynamoDB
// incremental-export constraint) — we use a 30-minute lag for margin.

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { ExportTableToPointInTimeCommand } from "@aws-sdk/client-dynamodb";
import { logServerError } from "../lib/log-server-error.js";

const ddbClient = new DynamoDBClient({});

const WATERMARK_PK = "ANALYTICS#EXPORT";
const WATERMARK_SK = "#WATERMARK";
// DynamoDB requires ExportToTime at least ~15 min in the past; 30 min adds margin.
const EXPORT_LAG_MS = 30 * 60 * 1000;
// One retry round-trip if the watermark read races with the prior run's write.
const MAX_RETRIES = 3;

/**
 * @param {string} table
 * @returns {Promise<{ from: number | null }>}
 */
async function readWatermark(table) {
  const res = await ddbClient.send(
    new GetCommand({
      TableName: table,
      Key: { pk: WATERMARK_PK, sk: WATERMARK_SK },
    }),
  );
  const item = res.Item;
  if (!item || typeof item.exportToTime !== "number") return { from: null };
  return { from: item.exportToTime };
}

/**
 * @param {string} table
 * @param {number} exportToTime
 * @param {string} exportId
 * @returns {Promise<void>}
 */
async function writeWatermark(table, exportToTime, exportId) {
  await ddbClient.send(
    new PutCommand({
      TableName: table,
      Item: {
        pk: WATERMARK_PK,
        sk: WATERMARK_SK,
        exportToTime,
        lastExportId: exportId,
        updatedAt: new Date().toISOString(),
      },
    }),
  );
}

/**
 * @param {string} table
 * @param {number} from epoch seconds, or null for the first run (full export fallback)
 * @param {number} to epoch seconds
 * @returns {Promise<string>} export ARN/Id
 */
async function startExport(table, from, to) {
  const res = await ddbClient.send(
    new ExportTableToPointInTimeCommand({
      TableArn: table,
      S3Bucket: process.env.LAKE_BUCKET,
      S3Prefix: process.env.EXPORT_PREFIX || "raw",
      ExportFormat: "DYNAMODB_JSON",
      ...(from === null
        ? { ExportType: "FULL_EXPORT" }
        : {
            ExportType: "INCREMENTAL_EXPORT",
            IncrementalExportSpecification: {
              ExportFromTime: new Date(from * 1000),
              ExportToTime: new Date(to * 1000),
              // API enum value is NEW_IMAGE ("NEW_IMAGE_ONLY" in some docs;
              // the SDK enum is authoritative).
              ExportViewType: "NEW_IMAGE",
            },
          }),
    }),
  );
  const desc = res.ExportDescription;
  if (!desc?.ExportArn)
    throw new Error("ExportTableToPointInTime returned no ExportDescription");
  return desc.ExportArn;
}

/**
 * @returns {Promise<void>}
 */
export const handler = async () => {
  const table = process.env.DYNAMO_TABLE;
  if (!table) throw new Error("Missing DYNAMO_TABLE");

  const now = Math.floor(Date.now() / 1000);
  const to = now - Math.floor(EXPORT_LAG_MS / 1000);

  // Retry loop: the only contended state is the watermark read-advance. If two
  // runs ever overlap, the second sees the first's fresh watermark and exports
  // a shorter window (exports are idempotent downstream — the convert step is
  // idempotent by export ID).
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const { from } = await readWatermark(table);
    if (from !== null && to <= from) {
      // Nothing new to export (shouldn't happen at 6h cadence; log and exit).
      console.log(
        JSON.stringify({
          marker: "AnalyticsExportSkipped",
          reason: "no new window",
          from,
          to,
        }),
      );
      return;
    }
    try {
      /** @type {number} */
      const fromValue = from ?? 0;
      const exportArn = await startExport(table, fromValue, to);
      await writeWatermark(table, to, exportArn);
      console.log(
        JSON.stringify({
          marker: "AnalyticsExportStarted",
          exportArn,
          from,
          to,
        }),
      );
      return;
    } catch (err) {
      if (attempt === MAX_RETRIES) {
        logServerError("analytics-export", err, { extra: { from, to } });
        throw err;
      }
      // Brief backoff; the schedule retries in 6h anyway.
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
};
