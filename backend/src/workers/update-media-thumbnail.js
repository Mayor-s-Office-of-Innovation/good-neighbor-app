import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../db.js";
import { getConfig } from "../config.js";
import { getObjectBytes } from "../s3.js";
import { downscaleImage, DownscaleError } from "../media/downscale.js";
import { recordThumbnail, storeThumbnail } from "../media/thumbnail.js";

/** Durable, idempotent thumbnail generation. Transient failures retry via SQS.
 * @type {import("aws-lambda").SQSHandler}
 */
export const handler = async (event) => {
  const { dynamoTable, uploadBucket } = getConfig();
  for (const record of event.Records) {
    const { pk, sk } = JSON.parse(record.body);
    if (
      typeof pk !== "string" ||
      !pk.startsWith("SITE#") ||
      typeof sk !== "string" ||
      !/^TASK#[^#]+#MEDIA#/.test(sk)
    )
      throw new Error("Invalid thumbnail job");
    const { Item: media } = await ddb.send(
      new GetCommand({
        TableName: dynamoTable,
        Key: { pk, sk },
        ConsistentRead: true,
      }),
    );
    if (!media || media.thumbS3Key || media.entityType !== "task_update_media")
      continue;
    // Derive all object metadata from the authoritative row, never queue input.
    if (
      !media.s3Key?.startsWith(`checks/${pk.slice(5)}/`) ||
      !media.contentType?.startsWith("image/")
    )
      continue;
    try {
      const object = await getObjectBytes({
        bucket: uploadBucket,
        key: media.s3Key,
      });
      const normalized = await downscaleImage(
        object.bytes,
        object.contentType ?? media.contentType,
      );
      const thumbS3Key = await storeThumbnail({
        bucket: uploadBucket,
        s3Key: media.s3Key,
        bytes: normalized.bytes,
      });
      await recordThumbnail({
        tableName: dynamoTable,
        key: { pk, sk },
        thumbS3Key,
      });
    } catch (error) {
      // Expired/deleted media and invalid images cannot improve on redelivery.
      if (
        error instanceof DownscaleError ||
        (error instanceof Error &&
          ["NoSuchKey", "NotFound", "ConditionalCheckFailedException"].includes(
            error.name,
          ))
      )
        continue;
      throw error;
    }
  }
};
