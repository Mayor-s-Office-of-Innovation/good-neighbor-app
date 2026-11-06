// Local only: puts the synthetic year's photos and notes where Insights'
// record panels read them, so the panels show what the field app records.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import {
  BatchWriteCommand,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import sharp from "sharp";
import { ddb } from "../../src/db.js";
import { headObject, putObject } from "../../src/s3.js";
import {
  PHOTO_POOL,
  syntheticPhotoKey,
} from "../../src/reporting/synthetic/generate.js";
import { assertLocalSeedTarget } from "./site-admin-seed.mjs";

const MARKER = { pk: "LOCAL_SEED#INSIGHTS_RECORDS", sk: "#META" };

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
 * for a real photo.
 * @param {"check" | "update"} kind
 * @param {number} n
 * @param {boolean} thumb
 * @returns {Promise<Buffer>}
 */
export function syntheticPhoto(kind, n, thumb) {
  const [w, h] = thumb ? [320, 240] : [1280, 960];
  const label = `${kind === "check" ? "Check" : "Issue update"} photo ${n + 1}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="960">
    <rect width="1280" height="960" fill="${COLORS[n % COLORS.length]}"/>
    <rect x="40" y="40" width="1200" height="880" fill="none" stroke="#fff" stroke-width="12" stroke-dasharray="40 24"/>
    <text x="640" y="470" font-family="Helvetica, Arial, sans-serif" font-size="180" font-weight="700" fill="#fff" text-anchor="middle">SYNTHETIC</text>
    <text x="640" y="600" font-family="Helvetica, Arial, sans-serif" font-size="72" fill="#fff" text-anchor="middle">${label}</text>
  </svg>`;
  return sharp(Buffer.from(svg)).resize(w, h).jpeg({ quality: 80 }).toBuffer();
}

/** @param {string} key */
async function present(bucket, key) {
  try {
    await headObject({ bucket, key });
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} file records.json from `npm run insights:data`
 */
export async function seedInsightsRecords(file) {
  if (!existsSync(file)) return;
  assertLocalSeedTarget();
  const bucket = String(process.env.S3_UPLOAD_BUCKET);
  let uploaded = 0;
  for (const kind of /** @type {const} */ (["check", "update"]))
    for (let n = 0; n < PHOTO_POOL; n += 1)
      for (const thumb of [false, true]) {
        const key = syntheticPhotoKey(kind, n, thumb);
        if (await present(bucket, key)) continue;
        await putObject({
          bucket,
          key,
          body: await syntheticPhoto(kind, n, thumb),
          contentType: "image/jpeg",
        });
        uploaded += 1;
      }
  const text = await readFile(file, "utf8");
  const digest = createHash("sha256").update(text).digest("hex");
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
  const rows = JSON.parse(text);
  const batches = [];
  for (let i = 0; i < rows.length; i += 25) batches.push(rows.slice(i, i + 25));
  let next = 0;
  const worker = async () => {
    while (next < batches.length) {
      let requests = batches[next++].map((Item) => ({ PutRequest: { Item } }));
      while (requests.length) {
        const res = await ddb.send(
          new BatchWriteCommand({
            RequestItems: { [String(TableName)]: requests },
          }),
        );
        requests = /** @type {any[]} */ (
          res.UnprocessedItems?.[String(TableName)] ?? []
        );
      }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  await ddb.send(
    new PutCommand({
      TableName,
      Item: { ...MARKER, digest, rows: rows.length },
    }),
  );
  console.log(
    `[api] loaded ${rows.length} Insights photo and note rows; ${uploaded} images uploaded`,
  );
}
