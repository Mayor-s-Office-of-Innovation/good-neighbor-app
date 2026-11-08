// Re-converts raw exports after a format change, so older rows gain new record types.
// Raw exports expire after 30 days (analytics.tf), so it also starts one full table export,
// which brings every item older than that into the lake in the new format.
// A failed export leaves the version unchanged, and re-converting overwrites, so retries are safe.

import {
  DescribeExportCommand,
  ExportTableToPointInTimeCommand,
} from "@aws-sdk/client-dynamodb";
import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { logServerError } from "../lib/log-server-error.js";

// Outside readings/<entity>/, so no lake view reads it.
export const STATE_KEY = "readings/_converter/state.json";

/**
 * @typedef {object} ConverterState
 * @property {number | null} formatVersion
 * @property {{ formatVersion: number, done: string[], fullExport?: FullExport }} [backfill] in-progress run
 * @property {string} [updatedAt]
 */

/**
 * @typedef {object} FullExport
 * @property {string} exportArn
 * @property {number} attempt counts failed exports, so a retry gets a fresh ClientToken
 */

/**
 * @typedef {object} BackfillDeps
 * @property {(command: any) => Promise<any>} send S3 client send
 * @property {(command: any) => Promise<any>} ddbSend DynamoDB client send
 * @property {string | undefined} tableArn the app table, exported in full once per version
 * @property {(bucket: string, key: string, exportedAt: string) => Promise<unknown>} convert convertExport
 * @property {string} bucket
 * @property {number} formatVersion the converter's current version
 * @property {Set<string>} [skip] manifest keys this run already converted
 * @property {string} [prefix] the export prefix (EXPORT_PREFIX)
 * @property {() => number} [timeLeftMs] Lambda getRemainingTimeInMillis
 * @property {() => Date} [now]
 */

// Room to convert one more export before the converter's 600 s timeout; a
// timeout would fail the trigger export and send it to the DLQ.
const STOP_WITH_MS_LEFT = 120_000;
// A cautious guess at gzipped export bytes converted per ms, so a large export waits for a fresh run.
const GZIP_BYTES_PER_MS = 1_000;
// An export estimated longer than a whole run would stop every run, so it is logged and passed.
const LONGEST_EXPORT_MS = 450_000;

/**
 * @param {BackfillDeps} deps
 * @returns {Promise<ConverterState | null>}
 */
async function readState({ send, bucket }) {
  try {
    const res = await send(
      new GetObjectCommand({ Bucket: bucket, Key: STATE_KEY }),
    );
    return JSON.parse(await res.Body.transformToString("utf8"));
  } catch (err) {
    // No file yet: the lake has never recorded a version.
    if (/** @type {any} */ (err)?.name === "NoSuchKey") return null;
    throw err;
  }
}

/**
 * @param {BackfillDeps} deps
 * @param {ConverterState} state
 * @returns {Promise<void>}
 */
async function writeState({ send, bucket, now = () => new Date() }, state) {
  await send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: STATE_KEY,
      Body: JSON.stringify({ ...state, updatedAt: now().toISOString() }),
      ServerSideEncryption: "aws:kms",
      ContentType: "application/json",
    }),
  );
}

/**
 * @param {BackfillDeps} deps
 * @returns {Promise<{ key: string, exportedAt: string, bytes: number }[]>} oldest first
 */
async function listExports({ send, bucket, prefix = "raw" }) {
  /** @type {{ key: string, exportedAt: string }[]} */
  const found = [];
  /** @type {Map<string, number>} export folder → its data files' bytes */
  const bytes = new Map();
  /** @type {string | undefined} */
  let token;
  do {
    const page = await send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: `${prefix}/`,
        ContinuationToken: token,
      }),
    );
    for (const o of page.Contents ?? []) {
      if (o.Key?.endsWith("manifest-summary.json"))
        found.push({
          key: o.Key,
          // Only a fallback: convertExport stamps rows with the summary's own export time.
          exportedAt: new Date(o.LastModified).toISOString(),
        });
      const data = o.Key?.match(/^(.*)\/data\/[^/]+$/);
      if (data) bytes.set(data[1], (bytes.get(data[1]) ?? 0) + (o.Size ?? 0));
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return found
    .map((e) => ({
      ...e,
      bytes: bytes.get(e.key.slice(0, e.key.lastIndexOf("/"))) ?? 0,
    }))
    .sort(
      (a, b) =>
        a.exportedAt.localeCompare(b.exportedAt) || a.key.localeCompare(b.key),
    );
}

/**
 * Starts the full export, or a new one after a failure. Same bucket, prefix and format as
 * the scheduled export in export.js, so its manifest triggers this converter like any other.
 * @param {BackfillDeps} deps
 * @param {number} attempt
 * @returns {Promise<FullExport>}
 */
async function startFullExport(
  { ddbSend, tableArn, bucket, prefix = "raw", formatVersion },
  attempt,
) {
  if (!tableArn) throw new Error("Missing DYNAMO_TABLE_ARN");
  const res = await ddbSend(
    new ExportTableToPointInTimeCommand({
      TableArn: tableArn,
      S3Bucket: bucket,
      S3Prefix: prefix,
      ExportFormat: "DYNAMODB_JSON",
      ExportType: "FULL_EXPORT",
      // Two converters running at once get the same export back, not two (DynamoDB keeps the token 8 h).
      ClientToken: `format-${formatVersion}-${attempt}`,
    }),
  );
  const exportArn = res.ExportDescription?.ExportArn;
  if (!exportArn)
    throw new Error("ExportTableToPointInTime returned no ExportArn");
  return { exportArn, attempt };
}

/**
 * @param {BackfillDeps} deps
 * @param {string} exportArn
 * @returns {Promise<boolean>}
 */
async function exportFailed({ ddbSend }, exportArn) {
  const res = await ddbSend(
    new DescribeExportCommand({ ExportArn: exportArn }),
  );
  return res.ExportDescription?.ExportStatus === "FAILED";
}

/**
 * @param {BackfillDeps} deps
 * @returns {Promise<{ backfilled: number, failed: number, finished: boolean }>}
 */
export async function backfillIfFormatChanged(deps) {
  const state = await readState(deps);
  if (state?.formatVersion === deps.formatVersion)
    return { backfilled: 0, failed: 0, finished: true };
  const prior =
    state?.backfill?.formatVersion === deps.formatVersion
      ? state.backfill
      : undefined;
  const done = new Set(prior?.done ?? []);
  let fullExport = prior?.fullExport;
  const save = () =>
    writeState(deps, {
      formatVersion: state?.formatVersion ?? null,
      backfill: {
        formatVersion: deps.formatVersion,
        done: [...done],
        fullExport,
      },
    });
  // DynamoDB writes an export's files under <prefix>/AWSDynamoDB/<the ARN's last segment>/.
  const fullKey = (/** @type {FullExport} */ f) =>
    `${deps.prefix ?? "raw"}/AWSDynamoDB/${f.exportArn.split("/").pop()}/manifest-summary.json`;
  // This run's trigger was the full export, so later runs needn't wait for it.
  if (
    fullExport &&
    deps.skip?.has(fullKey(fullExport)) &&
    !done.has(fullKey(fullExport))
  ) {
    done.add(fullKey(fullExport));
    await save();
  }

  let exportPending = false;
  try {
    if (!fullExport) {
      fullExport = await startFullExport(deps, 1);
      await save();
    } else if (!done.has(fullKey(fullExport))) {
      if (await exportFailed(deps, fullExport.exportArn)) {
        logServerError(
          "analytics-convert backfill",
          new Error("full export failed; starting another"),
          { extra: { exportArn: fullExport.exportArn } },
        );
        fullExport = await startFullExport(deps, fullExport.attempt + 1);
        await save();
      }
    }
  } catch (err) {
    // The re-conversion below still helps; the next run starts or checks the export again.
    logServerError("analytics-convert backfill", err);
    exportPending = true;
  }
  if (fullExport && !done.has(fullKey(fullExport))) exportPending = true;

  let backfilled = 0;
  let failed = 0;
  for (const { key, exportedAt, bytes } of await listExports(deps)) {
    if (done.has(key) || deps.skip?.has(key)) continue;
    const needMs = bytes / GZIP_BYTES_PER_MS;
    if (needMs > LONGEST_EXPORT_MS) {
      logServerError(
        "analytics-convert backfill",
        new Error("export too large to re-convert in one run"),
        { extra: { key, bytes } },
      );
      failed += 1;
      continue;
    }
    if (deps.timeLeftMs && deps.timeLeftMs() < STOP_WITH_MS_LEFT + needMs)
      return { backfilled, failed, finished: false };
    try {
      await deps.convert(deps.bucket, key, exportedAt);
    } catch (err) {
      // One broken or expired export would otherwise block every later one; the next run retries it.
      logServerError("analytics-convert backfill", err, { extra: { key } });
      failed += 1;
      continue;
    }
    done.add(key);
    backfilled += 1;
    if (fullExport && key === fullKey(fullExport)) exportPending = false;
    // Progress after each export, so a timeout doesn't redo the lot.
    await save();
  }
  if (failed || exportPending) return { backfilled, failed, finished: false };
  await writeState(deps, { formatVersion: deps.formatVersion });
  return { backfilled, failed, finished: true };
}
