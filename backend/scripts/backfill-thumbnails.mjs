// Backfill card thumbnails for photos stored before a thumbnail was written
// for them (backend/src/media/thumbnail.js): check photos from before the
// analyze worker wrote them, and task-update photos from before registration
// did.
//
//   DYNAMO_TABLE=... S3_UPLOAD_BUCKET=... node scripts/backfill-thumbnails.mjs [--apply] [--site <siteId>]
//
// Default is a dry run that only counts. Finds check-photo rows
// (CHECK#…#ART#…) and task-update photo rows (TASK#…#MEDIA#…) with an S3 key,
// an image content type and no `thumbS3Key`; with `--site` that is one Query
// of the site's partition, without it a table Scan. The sort-key match runs
// here rather than in the filter: a Query's FilterExpression may not name a
// key attribute. For each row it reads the original, runs the same
// normalize + thumbnail path as the worker, stores
// `<key>.thumb.webp` (tagged active), and records it on the row by its actual
// sort key, so pre-Phase-2 rows with a place segment are covered too.
//
// Originals that lifecycle has already expired are skipped (S3 reports a
// missing key as NoSuchKey only when the caller also holds s3:ListBucket on
// the bucket; without it the error is AccessDenied and counts as `failed`).
// A backfilled thumbnail starts its own 30-day lifecycle clock, so rows whose
// photo is already older than MAX_AGE_DAYS are skipped rather than given a
// thumbnail that would outlive its original. Safe to re-run: rows that gained
// a key fall out of the filter, and a repeated PUT is idempotent.
import { QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../src/db.js";
import { getObjectBytes } from "../src/s3.js";
import { downscaleImage, DownscaleError } from "../src/media/downscale.js";
import { recordThumbnail, storeThumbnail } from "../src/media/thumbnail.js";

const MAX_AGE_DAYS = 25;

const tableName = process.env.DYNAMO_TABLE;
const bucket = process.env.S3_UPLOAD_BUCKET;
if (!tableName || !bucket) {
  console.error("DYNAMO_TABLE and S3_UPLOAD_BUCKET are required");
  process.exit(1);
}

let apply = false;
/** @type {string | undefined} */
let onlySite;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--apply") apply = true;
  else if (arg === "--site" && args[i + 1] && !args[i + 1].startsWith("--"))
    onlySite = args[(i += 1)];
  else {
    console.error(
      "Usage: backfill-thumbnails.mjs [--apply] [--site <siteId>] (default: dry run)",
    );
    process.exit(1);
  }
}

/** Photo rows that carry a thumbnail: check photos and task-update photos. */
const PHOTO_ROW = /^CHECK#.*#ART#|^TASK#[^#]+#MEDIA#/;

const filter = {
  FilterExpression:
    "attribute_exists(s3Key) AND attribute_not_exists(thumbS3Key)" +
    " AND begins_with(contentType, :image)",
  ProjectionExpression: "pk, #sk, s3Key, contentType, capturedAt",
  ExpressionAttributeNames: { "#sk": "sk" },
};

/** @param {Record<string, any> | undefined} startKey */
function pageCommand(startKey) {
  return onlySite
    ? new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "pk = :pk",
        ...filter,
        ExpressionAttributeValues: {
          ":pk": `SITE#${onlySite}`,
          ":image": "image/",
        },
        ExclusiveStartKey: startKey,
      })
    : new ScanCommand({
        TableName: tableName,
        ...filter,
        ExpressionAttributeValues: { ":image": "image/" },
        ExclusiveStartKey: startKey,
      });
}

const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
const counts = {
  candidates: 0,
  written: 0,
  tooOld: 0,
  expired: 0,
  undecodable: 0,
  failed: 0,
};

/** @param {Record<string, any>} row */
async function processRow(row) {
  const capturedAt = Date.parse(String(row.capturedAt ?? ""));
  if (Number.isFinite(capturedAt) && capturedAt < cutoff) return "tooOld";
  if (!apply) return null;
  const s3Key = String(row.s3Key);
  try {
    const object = await getObjectBytes({ bucket, key: s3Key });
    const normalized = await downscaleImage(
      object.bytes,
      object.contentType ?? String(row.contentType),
    );
    const thumbS3Key = await storeThumbnail({
      bucket,
      s3Key,
      bytes: normalized.bytes,
    });
    await recordThumbnail({
      tableName,
      key: { pk: row.pk, sk: row.sk },
      thumbS3Key,
    });
    return "written";
  } catch (error) {
    const name = error instanceof Error ? error.name : "UnknownError";
    if (["NotFound", "NoSuchKey"].includes(name)) return "expired";
    if (error instanceof DownscaleError) return "undecodable";
    console.error(`thumbnail failed for ${row.sk}: ${name}`);
    return "failed";
  }
}

/** @type {Record<string, any> | undefined} */
let startKey;
do {
  const page = await ddb.send(pageCommand(startKey));
  for (const row of page.Items ?? []) {
    if (!PHOTO_ROW.test(String(row.sk))) continue;
    counts.candidates += 1;
    const outcome = await processRow(row);
    if (outcome) counts[outcome] += 1;
  }
  startKey = page.LastEvaluatedKey;
} while (startKey);

console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", ...counts }));
process.exitCode = counts.failed ? 1 : 0;
