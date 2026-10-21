// Card thumbnails: a small WebP variant stored next to each check photo so the
// home / history / reports cards load tens of kilobytes instead of the
// multi-megabyte camera original. The original stays the lightbox source.
//
// Produced by the analyze worker from the bytes it has already decoded for the
// analyzer (`downscaleImage` output: upright, flattened, ≤1568 px JPEG), so the
// thumbnail costs one small resize and never a second S3 read. The worker
// starts the write before its analyzer call and drains it before any exit, so
// a slow or failed thumbnail never delays or fails an analysis — the card
// simply falls back to the original until a backfill fills the gap.
//
// Keyed as `<original key>.thumb.webp` under the same checks/<site>/<check>/
// prefix, so the uploads bucket's 30-day prefix expiry and presignMedia's
// tenant-prefix check both cover it without new rules. Tagged `state=active`
// like other server-generated derivatives (care-work JPEGs).
//
// Why the key is recorded on the ART# row rather than derived by convention
// at read time: presignMedia also serves task-update photos (never analyzed,
// so never thumbnailed) and photos whose write failed, and signing a key that
// may not exist would push a 403-then-fallback onto every card <img> consumer
// or a HEAD round trip onto the per-card media route. One attribute, set as
// soon as the object lands (idempotent), keeps the read path a plain lookup.

import sharp from "sharp";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../db.js";
import { putObject } from "../s3.js";

/**
 * Long-edge cap (px). The largest card slot is the to-do card's 120 px square
 * (history cards 75 px, 56 px on phones) with object-fit cover, so a 3:2
 * photo's 320 px short edge covers that slot at 2.7×; the lightbox never uses
 * this variant.
 */
export const THUMBNAIL_EDGE_PX = 480;
/** WebP quality: visually clean at card size, ~20–40 KB per photo. */
const WEBP_QUALITY = 75;
export const THUMBNAIL_CONTENT_TYPE = "image/webp";
const THUMBNAIL_SUFFIX = ".thumb.webp";
/** Lifecycle tag, as PutObject's URL-encoded `Tagging` header expects it. */
const THUMBNAIL_TAGGING = "state=active";

/**
 * S3 key of the thumbnail stored beside an original.
 * @param {string} s3Key
 */
export function thumbnailKeyFor(s3Key) {
  return `${s3Key}${THUMBNAIL_SUFFIX}`;
}

/**
 * Encode the card thumbnail from already-normalized image bytes (the
 * `downscaleImage` result: a flat, single-page JPEG, so no decode policy is
 * needed here — same as the duplicate detector's second-stage resize). Small
 * inputs are not enlarged.
 * @param {Buffer} bytes
 * @returns {Promise<{ bytes: Buffer, contentType: string }>}
 */
export async function makeThumbnail(bytes) {
  const out = await sharp(bytes)
    .resize({
      width: THUMBNAIL_EDGE_PX,
      height: THUMBNAIL_EDGE_PX,
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({ quality: WEBP_QUALITY })
    .toBuffer();
  return { bytes: out, contentType: THUMBNAIL_CONTENT_TYPE };
}

/**
 * Encode and store the thumbnail for one original (one PUT, tags included);
 * returns its key. Idempotent: a re-run overwrites the same bytes.
 * @param {{ bucket: string, s3Key: string, bytes: Buffer }} input
 * @returns {Promise<string>}
 */
export async function storeThumbnail({ bucket, s3Key, bytes }) {
  const key = thumbnailKeyFor(s3Key);
  const thumb = await makeThumbnail(bytes);
  await putObject({
    bucket,
    key,
    body: thumb.bytes,
    contentType: thumb.contentType,
    tagging: THUMBNAIL_TAGGING,
  });
  return key;
}

/**
 * Point an ARTIFACT row at its stored thumbnail (idempotent SET). Conditional
 * on the row existing so a stray update can never create a bare row. Callers
 * treat a failed condition as "not recorded": the row was deleted, or it is a
 * pre-Phase-2 row whose sort key carries a retired place segment that
 * `artifactKey` does not rebuild (their media is long expired anyway; the
 * backfill script addresses rows by their actual sort key).
 * @param {{ tableName: string, key: { pk: string, sk: string }, thumbS3Key: string }} input
 */
export function recordThumbnail({ tableName, key, thumbS3Key }) {
  return ddb.send(
    new UpdateCommand({
      TableName: tableName,
      Key: key,
      UpdateExpression: "SET thumbS3Key = :k",
      ConditionExpression: "attribute_exists(sk)",
      ExpressionAttributeValues: { ":k": thumbS3Key },
    }),
  );
}
