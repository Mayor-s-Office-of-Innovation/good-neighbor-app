import sharp from "sharp";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../db.js";
import { getObjectBytes, putObjectBytes } from "../s3.js";

/** @param {string} originalKey
 * @returns {string}
 */
export const thumbnailKey = (originalKey) => `${originalKey}/thumbnails/v1.jpg`;

/** @param {Buffer} bytes
 * @returns {Promise<{bytes: Buffer, width: number, height: number, contentType: string}>}
 */
export async function createThumbnail(bytes) {
  const { data, info } = await sharp(bytes)
    .rotate()
    .flatten({ background: "white" })
    .resize({
      width: 400,
      height: 400,
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: 75 })
    .toBuffer({ resolveWithObject: true });
  return {
    bytes: data,
    width: info.width,
    height: info.height,
    contentType: "image/jpeg",
  };
}

/**
 * Publish metadata only after the object exists. A deleted/replaced artifact
 * cannot be recreated by a delayed worker. Shared by processing and backfill.
 * @param {{ dynamoTable: string, uploadBucket: string, key: {pk: string, sk: string}, s3Key: string, bytes?: Buffer }} options
 */
export async function ensureThumbnail({
  dynamoTable,
  uploadBucket,
  key,
  s3Key,
  bytes,
}) {
  const { Item: artifact } = await ddb.send(
    new GetCommand({ TableName: dynamoTable, Key: key, ConsistentRead: true }),
  );
  if (!artifact || artifact.s3Key !== s3Key) return;
  const targetKey = thumbnailKey(s3Key);
  if (artifact.thumbnail?.s3Key === targetKey) return;
  const source =
    bytes ?? (await getObjectBytes({ bucket: uploadBucket, key: s3Key })).bytes;
  const thumbnail = await createThumbnail(source);
  await putObjectBytes({
    bucket: uploadBucket,
    key: targetKey,
    bytes: thumbnail.bytes,
    contentType: thumbnail.contentType,
  });
  await ddb.send(
    new UpdateCommand({
      TableName: dynamoTable,
      Key: key,
      UpdateExpression: "SET thumbnail = :thumbnail",
      ConditionExpression: "attribute_exists(sk) AND s3Key = :source",
      ExpressionAttributeValues: {
        ":source": s3Key,
        ":thumbnail": {
          s3Key: targetKey,
          width: thumbnail.width,
          height: thumbnail.height,
          contentType: thumbnail.contentType,
        },
      },
    }),
  );
}
