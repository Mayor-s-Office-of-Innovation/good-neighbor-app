// Re-converts raw exports after a format change, so older rows gain new record types.
// Raw exports expire after 30 days (analytics.tf); older history keeps its first conversion.
// A failed export leaves the version unchanged, and re-converting overwrites, so retries are safe.

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
 * @property {{ formatVersion: number, done: string[] }} [backfill] in-progress run
 * @property {string} [updatedAt]
 */

/**
 * @typedef {object} BackfillDeps
 * @property {(command: any) => Promise<any>} send S3 client send
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
 * @param {BackfillDeps} deps
 * @returns {Promise<{ backfilled: number, failed: number, finished: boolean }>}
 */
export async function backfillIfFormatChanged(deps) {
  const state = await readState(deps);
  if (state?.formatVersion === deps.formatVersion)
    return { backfilled: 0, failed: 0, finished: true };
  const done = new Set(
    state?.backfill?.formatVersion === deps.formatVersion
      ? state.backfill.done
      : [],
  );
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
    // Progress after each export, so a timeout doesn't redo the lot.
    await writeState(deps, {
      formatVersion: state?.formatVersion ?? null,
      backfill: { formatVersion: deps.formatVersion, done: [...done] },
    });
  }
  if (failed) return { backfilled, failed, finished: false };
  await writeState(deps, { formatVersion: deps.formatVersion });
  return { backfilled, failed, finished: true };
}
