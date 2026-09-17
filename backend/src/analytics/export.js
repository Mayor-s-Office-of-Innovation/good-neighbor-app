// Scheduled incremental DynamoDB PITR export (ADR 0013 Phase 2). Every 6 hours:
// start an INCREMENTAL_EXPORT from the persisted watermark to a fixed endpoint,
// then advance the watermark to that endpoint. The watermark lives in the app's
// single table (pk = ANALYTICS#EXPORT, sk = #WATERMARK) — never clock-derived,
// because "now minus 24h" drifts and creates gaps or overlaps.
//
// The watermark advances ONLY when DynamoDB confirms the export job COMPLETED
// (DescribeExport polled by the next runs); a started-but-failed export leaves
// the cursor where it was, so the window is retried and data is never skipped.
// Pending state (the in-flight window) is recorded separately so the next run
// can poll it without re-starting the same window.
//
// The export service itself writes to s3://<lake>/raw/AWSDynamoDB/<export-id>/
// (bucket policy in analytics.tf); completion is signalled by
// manifest-summary.json landing, which triggers the convert Lambda.
//
// ExportToTime must trail current time by at least 15 minutes (DynamoDB
// incremental-export constraint) — we use a 30-minute lag for margin.

import {
  DynamoDBClient,
  DescribeExportCommand,
  ExportTableToPointInTimeCommand,
} from "@aws-sdk/client-dynamodb";
import { ddb } from "../db.js";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { logServerError } from "../lib/log-server-error.js";

// Raw client only for the export-control APIs (no document-client equivalent).
const raw = new DynamoDBClient({});

const WATERMARK_PK = "ANALYTICS#EXPORT";
const WATERMARK_SK = "#WATERMARK";
// DynamoDB requires ExportToTime at least ~15 min in the past; 30 min adds margin.
const EXPORT_LAG_MS = 30 * 60 * 1000;
// One retry round-trip if the watermark read races with the prior run's write.
const MAX_RETRIES = 3;

/**
 * @typedef {object} WatermarkItem
 * @property {number} [exportToTime] completed cursor (epoch seconds)
 * @property {{ from: number | null, to: number, exportArn: string }} [pending] in-flight export, if any
 * @property {string} [lastExportId]
 * @property {string} [updatedAt]
 */

/**
 * @param {string} table
 * @returns {Promise<WatermarkItem>}
 */
async function readWatermark(table) {
  const res = await ddb.send(
    new GetCommand({
      TableName: table,
      Key: { pk: WATERMARK_PK, sk: WATERMARK_SK },
    }),
  );
  const item = /** @type {WatermarkItem | undefined} */ (res.Item);
  return /** @type {WatermarkItem} */ (item ?? {});
}

/**
 * @param {string} table
 * @param {Partial<WatermarkItem>} patch
 * @returns {Promise<void>}
 */
async function writeWatermark(table, patch) {
  await ddb.send(
    new PutCommand({
      TableName: table,
      Item: {
        pk: WATERMARK_PK,
        sk: WATERMARK_SK,
        ...patch,
        updatedAt: new Date().toISOString(),
      },
    }),
  );
}

/**
 * @param {string} tableArn
 * @param {number | null} from epoch seconds, or null for the first run (full export)
 * @param {number} to epoch seconds
 * @returns {Promise<string>} export ARN
 */
async function startExport(tableArn, from, to) {
  const res = await raw.send(
    new ExportTableToPointInTimeCommand({
      TableArn: tableArn,
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
 * Check the pending export's status. The watermark advances only on COMPLETED;
 * FAILED leaves the cursor untouched (the window retries) and surfaces the
 * failure; IN_PROGRESS keeps waiting.
 * @param {string} exportArn
 * @returns {Promise<"completed" | "in_progress" | "failed">}
 */
async function exportStatus(exportArn) {
  const res = await raw.send(
    new DescribeExportCommand({ ExportArn: exportArn }),
  );
  const desc = res.ExportDescription;
  if (!desc)
    throw new Error(`DescribeExport returned nothing for ${exportArn}`);
  if (desc.ExportStatus === "COMPLETED") return "completed";
  if (desc.ExportStatus === "FAILED") {
    const reason = desc.FailureMessage ?? desc.FailureCode ?? "unknown";
    throw new Error(`Analytics export ${exportArn} FAILED: ${reason}`);
  }
  return "in_progress";
}

/**
 * @returns {Promise<void>}
 */
export const handler = async () => {
  const table = process.env.DYNAMO_TABLE;
  if (!table) throw new Error("Missing DYNAMO_TABLE");
  const tableArn = process.env.DYNAMO_TABLE_ARN;
  if (!tableArn) throw new Error("Missing DYNAMO_TABLE_ARN");

  const now = Math.floor(Date.now() / 1000);
  const to = now - Math.floor(EXPORT_LAG_MS / 1000);

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const wm = await readWatermark(table);
    const from = wm.exportToTime ?? null;

    // 1. A pending export from a previous run gates everything: advance only
    // on completion; on failure surface the error WITHOUT advancing (same
    // window retries next run), on in-progress exit and wait.
    if (wm.pending) {
      const status = await exportStatus(wm.pending.exportArn);
      if (status === "in_progress") {
        console.log(
          JSON.stringify({
            marker: "AnalyticsExportPending",
            exportArn: wm.pending.exportArn,
            to: wm.pending.to,
          }),
        );
        return;
      }
      // completed: advance the cursor to the pending window's endpoint.
      await writeWatermark(table, {
        exportToTime: wm.pending.to,
        lastExportId: wm.pending.exportArn,
        pending: undefined,
      });
      console.log(
        JSON.stringify({
          marker: "AnalyticsExportCommitted",
          exportArn: wm.pending.exportArn,
          to: wm.pending.to,
        }),
      );
      // Fall through: with the cursor advanced, a fresh window may be due.
    }

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
      const exportArn = await startExport(tableArn, from, to);
      // Record the in-flight window WITHOUT advancing the cursor; a failed
      // export never skips data and the stall alarm keeps firing.
      /** @type {import("./export.js").WatermarkItem} */
      const startedPatch = { pending: { from, to, exportArn } };
      if (from !== null) startedPatch.exportToTime = from;
      await writeWatermark(table, startedPatch);
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
