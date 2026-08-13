import { PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../db.js";
import { getConfig } from "../config.js";

/**
 * @typedef {object} SubmissionMessage
 * @property {string} requestId
 * @property {string} subject
 * @property {string} body
 */

// Idempotency-receipt item. This is the DynamoDB successor to the old
// `OfflineSubmission` Prisma row: same job (record a submission once, flag
// replays) on the single-table pk/sk shape. `requestId` is the client-supplied
// idempotency-key — the same value the real model will carry as the ULID
// `checkId` — so keying on it here is forward-compatible with the check item
// the analysis-backend Lambdas will grow this into (SITE#/CHECK#, once the
// payload carries a siteId). Until then it lives under its own SUBMISSION#
// partition rather than fabricate a site.
/**
 * @param {string} requestId
 * @returns {{ pk: string, sk: string }}
 */
const receiptKey = (requestId) => ({
  pk: `SUBMISSION#${requestId}`,
  sk: "#RECEIPT",
});

/** @type {import("aws-lambda").SQSHandler} */
export const handler = async (event) => {
  const { dynamoTable } = getConfig();

  for (const record of event.Records) {
    const message = /** @type {SubmissionMessage} */ (JSON.parse(record.body));
    const now = new Date().toISOString();

    try {
      // First delivery: create the receipt. attribute_not_exists(pk) makes the
      // write conditional, so a redelivery/replay can't overwrite it.
      await ddb.send(
        new PutCommand({
          TableName: dynamoTable,
          Item: {
            ...receiptKey(message.requestId),
            requestId: message.requestId,
            cognitoSubject: message.subject,
            payload: JSON.parse(message.body),
            status: "received",
            createdAt: now,
            updatedAt: now,
          },
          ConditionExpression: "attribute_not_exists(pk)",
        }),
      );
    } catch (err) {
      // The receipt already exists: this is a duplicate replay. Record that,
      // mirroring the old upsert's `update` branch.
      if (
        err instanceof Error &&
        err.name === "ConditionalCheckFailedException"
      ) {
        await ddb.send(
          new UpdateCommand({
            TableName: dynamoTable,
            Key: receiptKey(message.requestId),
            UpdateExpression: "SET #status = :status, updatedAt = :now",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: {
              ":status": "duplicate_replay",
              ":now": now,
            },
          }),
        );
      } else {
        throw err;
      }
    }
  }
};
