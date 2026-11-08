// Local only: puts the synthetic year's photos and notes where Insights'
// record panels read them, so the panels show what the field app records.

import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import {
  BatchWriteCommand,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import sharp from "sharp";
import { ddb } from "../../src/db.js";
import { copyObject, headObject, putObject } from "../../src/s3.js";
import { assertLocalSeedTarget } from "./site-admin-seed.mjs";

const MARKER = { pk: "LOCAL_SEED#INSIGHTS_RECORDS", sk: "#META" };

// A few labelled images stand in for every photo, so the seed makes only these
// and copies them to each photo's own key.
export const PHOTO_POOL = 6;

/**
 * Where a pooled image sits in the uploads bucket.
 * @param {"check" | "update"} kind
 * @param {number} n 0-based; wraps around the pool
 * @param {boolean} [thumb]
 * @returns {string}
 */
export function syntheticPhotoKey(kind, n, thumb = false) {
  return `synthetic/photos/${kind}-${(n % PHOTO_POOL) + 1}${thumb ? ".thumb.webp" : ".jpg"}`;
}

/**
 * The pooled image a photo copies; the same key always gets the same image.
 * @param {string} s3Key
 * @returns {number}
 */
export function poolIndex(s3Key) {
  return createHash("sha256").update(s3Key).digest().readUInt32BE(0);
}

/**
 * Only the fields the photo route reads, so the dev table's worklists and
 * GSIs never pick these rows up.
 * @param {Record<string, any>[]} items the generator's full year
 * @returns {Record<string, any>[]}
 */
export function recordRows(items) {
  /** @param {Record<string, any>} item @param {string[]} fields */
  const keep = (item, fields) => ({
    pk: item.pk,
    sk: item.sk,
    ...Object.fromEntries(
      fields.filter((f) => item[f] !== undefined).map((f) => [f, item[f]]),
    ),
  });
  return items.flatMap((item) => {
    if (/^CHECK#[^#]+#ART#/.test(item.sk))
      return [
        keep(item, [
          "checkId",
          "artifactId",
          "s3Key",
          "thumbS3Key",
          "text",
          "capturedAt",
        ]),
      ];
    if (/^TASK#[^#]+$/.test(item.sk))
      return [keep(item, ["taskId", "checkId", "sourceArtifactIds"])];
    if (/^TASK#[^#]+#UPDATE#/.test(item.sk) && (item.notes || item.photoKeys))
      return [keep(item, ["notes", "photoKeys", "occurredAt"])];
    if (/^TASK#[^#]+#MEDIA#/.test(item.sk))
      return [keep(item, ["artifactId", "s3Key", "thumbS3Key", "capturedAt"])];
    return [];
  });
}

const COLORS = [
  "#2f6f4f",
  "#5b4a8a",
  "#8a5a2b",
  "#2b5d8a",
  "#7a2f45",
  "#4f6b2f",
];

/**
 * A plain image that says "Synthetic" on its face, so no one mistakes it
 * for a real photo. Thumbnails are WebP, like the thumbnail worker's.
 * @param {"check" | "update"} kind
 * @param {number} n
 * @param {boolean} thumb
 * @returns {Promise<Buffer>}
 */
export async function syntheticPhoto(kind, n, thumb) {
  const [w, h] = thumb ? [320, 240] : [1280, 960];
  const label = `${kind === "check" ? "Check" : "Issue update"} photo ${n + 1}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="960">
    <rect width="1280" height="960" fill="${COLORS[n % COLORS.length]}"/>
    <rect x="40" y="40" width="1200" height="880" fill="none" stroke="#fff" stroke-width="12" stroke-dasharray="40 24"/>
    <text x="640" y="470" font-family="Helvetica, Arial, sans-serif" font-size="180" font-weight="700" fill="#fff" text-anchor="middle">SYNTHETIC</text>
    <text x="640" y="600" font-family="Helvetica, Arial, sans-serif" font-size="72" fill="#fff" text-anchor="middle">${label}</text>
  </svg>`;
  const image = sharp(Buffer.from(svg)).resize(w, h);
  return (
    thumb ? image.webp({ quality: 70 }) : image.jpeg({ quality: 80 })
  ).toBuffer();
}

/**
 * @param {string} bucket
 * @param {string} key
 */
async function present(bucket, key) {
  try {
    await headObject({ bucket, key });
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} file
 * @returns {AsyncGenerator<Record<string, any>>}
 */
async function* readRows(file) {
  for await (const line of createInterface({ input: createReadStream(file) }))
    if (line) yield JSON.parse(line);
}

/**
 * Run `work` on every entry, a few at a time.
 * @template T
 * @param {T[]} list
 * @param {number} lanes
 * @param {(entry: T) => Promise<void>} work
 */
async function inLanes(list, lanes, work) {
  let next = 0;
  const lane = async () => {
    while (next < list.length) await work(list[next++]);
  };
  await Promise.all(Array.from({ length: lanes }, lane));
}

/**
 * @param {string} file records.jsonl from `npm run insights:data`
 */
export async function seedInsightsRecords(file) {
  if (!existsSync(file)) return;
  assertLocalSeedTarget();
  const bucket = String(process.env.S3_UPLOAD_BUCKET);
  const pool = [];
  for (const kind of /** @type {const} */ (["check", "update"]))
    for (let n = 0; n < PHOTO_POOL; n += 1)
      for (const thumb of [false, true]) pool.push({ kind, n, thumb });
  let uploaded = 0;
  await inLanes(pool, 4, async ({ kind, n, thumb }) => {
    const key = syntheticPhotoKey(kind, n, thumb);
    if (await present(bucket, key)) return;
    await putObject({
      bucket,
      key,
      body: await syntheticPhoto(kind, n, thumb),
      contentType: thumb ? "image/webp" : "image/jpeg",
    });
    uploaded += 1;
  });
  const hash = createHash("sha256");
  for await (const line of createInterface({ input: createReadStream(file) }))
    hash.update(line);
  const digest = hash.digest("hex");
  const TableName = process.env.DYNAMO_TABLE;
  const seen = await ddb.send(
    new GetCommand({ TableName, Key: MARKER, ConsistentRead: true }),
  );
  if (seen.Item?.digest === digest) {
    console.log(
      `[api] Insights photos and notes already loaded; ${uploaded} images uploaded`,
    );
    return;
  }
  /** @type {Record<string, any>[]} */
  const rows = [];
  for await (const row of readRows(file)) rows.push(row);
  // The photo routes sign only keys under the photo's own Site and Check.
  // Named from/to because gitleaks flags a `key` field holding a thumbnail key.
  const copies = rows.flatMap((row) => {
    if (typeof row.s3Key !== "string") return [];
    const kind = /#MEDIA#/.test(row.sk) ? "update" : "check";
    const n = poolIndex(row.s3Key);
    return [
      { from: syntheticPhotoKey(kind, n), to: row.s3Key },
      ...(row.thumbS3Key
        ? [{ from: syntheticPhotoKey(kind, n, true), to: row.thumbS3Key }]
        : []),
    ];
  });
  await inLanes(copies, 16, ({ from, to }) =>
    copyObject({ bucket, sourceKey: from, key: to }).then(() => undefined),
  );
  const batches = [];
  for (let i = 0; i < rows.length; i += 25) batches.push(rows.slice(i, i + 25));
  await inLanes(batches, 8, async (batch) => {
    let requests = batch.map((Item) => ({ PutRequest: { Item } }));
    // DynamoDB Local throttles a busy table; back off rather than spin.
    for (let tries = 0; requests.length; tries += 1) {
      if (tries) await sleep(Math.min(2000, 50 * 2 ** tries));
      const res = await ddb.send(
        new BatchWriteCommand({
          RequestItems: { [String(TableName)]: requests },
        }),
      );
      requests = /** @type {any[]} */ (
        res.UnprocessedItems?.[String(TableName)] ?? []
      );
    }
  });
  await ddb.send(
    new PutCommand({
      TableName,
      Item: { ...MARKER, digest, rows: rows.length },
    }),
  );
  console.log(
    `[api] loaded ${rows.length} Insights photo and note rows and ${copies.length} photos; ${uploaded} images uploaded`,
  );
}
