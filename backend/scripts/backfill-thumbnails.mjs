// Backfill card thumbnails for check photos registered before the analyze
// worker started writing them (backend/src/media/thumbnail.js).
//
//   DYNAMO_TABLE=... S3_UPLOAD_BUCKET=... node scripts/backfill-thumbnails.mjs [--apply] [--site <siteId>]
//
// Default is a dry run that only counts. Scans ART# rows with an S3 key and no
// `thumbS3Key`, reads each original, runs the same normalize + thumbnail path
// as the worker, stores `<key>.thumb.webp`, and records it on the row by its
// actual sort key (so pre-Phase-2 rows with a place segment are covered too).
// Originals that lifecycle has already expired are skipped. Safe to re-run:
// rows that gained a key are filtered out by the scan, and a re-put of the same
// thumbnail is idempotent.
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../src/db.js";
import { getObjectBytes } from "../src/s3.js";
import { downscaleImage, DownscaleError } from "../src/media/downscale.js";
import { recordThumbnail, storeThumbnail } from "../src/media/thumbnail.js";

const tableName = process.env.DYNAMO_TABLE;
const bucket = process.env.S3_UPLOAD_BUCKET;
if (!tableName || !bucket) {
  console.error("DYNAMO_TABLE and S3_UPLOAD_BUCKET are required");
  process.exit(1);
}
const args = process.argv.slice(2);
const apply = args.includes("--apply");
const siteIndex = args.indexOf("--site");
const onlySite = siteIndex >= 0 ? args[siteIndex + 1] : undefined;
const known = new Set(["--apply", "--site", onlySite]);
if (args.some((arg) => !known.has(arg)) || (siteIndex >= 0 && !onlySite)) {
  console.error(
    "Usage: backfill-thumbnails.mjs [--apply] [--site <siteId>] (default: dry run)",
  );
  process.exit(1);
}

const counts = {
  candidates: 0,
  written: 0,
  expired: 0,
  undecodable: 0,
  failed: 0,
};
let startKey;
do {
  const page = await ddb.send(
    new ScanCommand({
      TableName: tableName,
      FilterExpression:
        "begins_with(#pk, :site) AND begins_with(#sk, :check) AND contains(#sk, :art)" +
        " AND attribute_exists(s3Key) AND attribute_not_exists(thumbS3Key)" +
        " AND begins_with(contentType, :image)",
      ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
      ExpressionAttributeValues: {
        ":site": onlySite ? `SITE#${onlySite}` : "SITE#",
        ":check": "CHECK#",
        ":art": "#ART#",
        ":image": "image/",
      },
      ExclusiveStartKey: startKey,
    }),
  );
  for (const row of page.Items ?? []) {
    counts.candidates += 1;
    if (!apply) continue;
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
      counts.written += 1;
    } catch (error) {
      const name = error instanceof Error ? error.name : "UnknownError";
      if (["NotFound", "NoSuchKey"].includes(name)) counts.expired += 1;
      else if (error instanceof DownscaleError) counts.undecodable += 1;
      else {
        counts.failed += 1;
        console.error(`thumbnail failed for ${row.sk}: ${name}`);
      }
    }
  }
  startKey = page.LastEvaluatedKey;
} while (startKey);

console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", ...counts }));
process.exitCode = counts.failed ? 1 : 0;
