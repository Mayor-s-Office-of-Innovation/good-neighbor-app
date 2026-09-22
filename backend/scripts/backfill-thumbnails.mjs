// Read-only unless --apply is supplied. Scope to a single site and cap writes.
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../src/db.js";
import { ensureThumbnail, thumbnailKey } from "../src/media/thumbnail.js";

const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
const site = args.includes("--site") ? value("--site") : "";
const limit = args.includes("--limit") ? Number(value("--limit")) : 100;
if (!site || site.startsWith("--") || !Number.isInteger(limit) || limit < 1) {
  throw new Error(
    "Usage: node scripts/backfill-thumbnails.mjs --site SITE_ID [--limit 100] [--apply]",
  );
}
const dynamoTable = process.env.DYNAMO_TABLE;
const uploadBucket = process.env.S3_UPLOAD_BUCKET;
if (!dynamoTable || !uploadBucket)
  throw new Error("DYNAMO_TABLE and S3_UPLOAD_BUCKET are required");
let cursor;
let candidates = 0;
let failures = 0;
do {
  const result = await ddb.send(
    new QueryCommand({
      TableName: dynamoTable,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": `SITE#${site}`, ":prefix": "CHECK#" },
      ExclusiveStartKey: cursor,
      Limit: 100,
    }),
  );
  for (const artifact of result.Items ?? []) {
    if (
      !artifact.sk.includes("#ART#") ||
      !artifact.s3Key ||
      !artifact.contentType?.startsWith("image/") ||
      artifact.thumbnail?.s3Key === thumbnailKey(artifact.s3Key)
    )
      continue;
    candidates++;
    console.info(
      args.includes("--apply") ? "Generating" : "Would generate",
      artifact.artifactId,
    );
    if (args.includes("--apply")) {
      try {
        await ensureThumbnail({
          dynamoTable,
          uploadBucket,
          key: { pk: artifact.pk, sk: artifact.sk },
          s3Key: artifact.s3Key,
        });
      } catch (error) {
        failures++;
        console.error("Thumbnail failed", artifact.artifactId, error);
      }
    }
    if (candidates >= limit) break;
  }
  cursor = result.LastEvaluatedKey;
} while (cursor && candidates < limit);
console.info({ candidates, failures, applied: args.includes("--apply") });
if (failures) process.exitCode = 1;
