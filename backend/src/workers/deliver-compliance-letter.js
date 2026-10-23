import {
  GetCommand,
  UpdateCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ddb } from "../db.js";
import { getConfig, getComplianceLetterBucket } from "../config.js";
import { getObjectBytes } from "../s3.js";
import { sendEmail } from "../integrations/email-transport.js";

/** Deliver once per durable job. An ambiguous send is not retried automatically.
 * @param {Record<string, any>} job
 * @param {Record<string, any>} email
 * @param {Record<string, any>} letter
 */
export async function deliverComplianceLetter(job, email, letter) {
  const TableName = getConfig().dynamoTable;
  const Key = { pk: job.pk, sk: job.sk };
  let receipt = job.receipt;
  if (!receipt) {
    // Fetch and validate before claiming: these failures are safe to retry.
    const { bytes: pdf } = job.noticeOnly
      ? { bytes: undefined }
      : await getObjectBytes({
          bucket: getComplianceLetterBucket(),
          key: letter.s3Key,
        });
    const local =
      !process.env.AWS_LAMBDA_FUNCTION_NAME &&
      Boolean(process.env.LOCAL_API_PORT);
    if (!local && !process.env.SETUP_CODE_EMAIL_FROM)
      throw new Error("Missing email sender");
    try {
      await ddb.send(
        new UpdateCommand({
          TableName,
          Key,
          UpdateExpression: "SET deliveryState = :sending",
          ConditionExpression: "attribute_not_exists(deliveryState)",
          ExpressionAttributeValues: { ":sending": "sending" },
        }),
      );
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.name !== "ConditionalCheckFailedException"
      )
        throw error;
      const latest = await ddb.send(
        new GetCommand({ TableName, Key, ConsistentRead: true }),
      );
      if (latest.Item?.status === "completed") return;
      if (latest.Item?.receipt)
        return finalizeDelivery(
          latest.Item,
          latest.Item.receipt,
          letter,
          email,
        );
      // Retain for investigation/DLQ: the transport may have accepted the email.
      throw new Error(
        "Letter email delivery is already in progress or needs reconciliation",
      );
    }
    try {
      if (local) {
        const directory =
          process.env.LOCAL_COMPLIANCE_EMAIL_DIR ||
          "/tmp/good-neighbor-letter-emails";
        await mkdir(directory, { recursive: true });
        await writeFile(
          join(directory, `${job.letterJobId}.json`),
          JSON.stringify({ ...email, attachment: letter.fileName }, null, 2),
        );
        if (pdf)
          await writeFile(join(directory, `${job.letterJobId}.pdf`), pdf);
        receipt = { provider: "local-preview", messageId: job.letterJobId };
      } else {
        receipt = await sendEmail({
          to: email.to,
          cc: email.cc,
          subject: email.subject,
          text: email.text,
          from: String(process.env.SETUP_CODE_EMAIL_FROM),
          replyTo: process.env.SETUP_CODE_EMAIL_REPLY_TO,
          html: `<div style="white-space:pre-wrap">${escapeHtml(email.text)}</div>`,
          attachments: !pdf
            ? []
            : [
                {
                  filename: letter.fileName,
                  content: pdf,
                  contentType: "application/pdf",
                },
              ],
        });
      }
      receipt.sentAt = new Date().toISOString();
      await ddb.send(
        new UpdateCommand({
          TableName,
          Key,
          UpdateExpression: "SET receipt = :receipt, deliveryState = :accepted",
          ExpressionAttributeValues: {
            ":receipt": receipt,
            ":accepted": "accepted",
          },
        }),
      );
    } catch (error) {
      // Only explicit proof of non-submission permits another attempt.
      if (
        !receipt &&
        error &&
        typeof error === "object" &&
        "emailNotSubmitted" in error &&
        error.emailNotSubmitted === true
      ) {
        await ddb.send(
          new UpdateCommand({
            TableName,
            Key,
            UpdateExpression: "REMOVE deliveryState",
            ConditionExpression:
              "deliveryState = :sending AND attribute_not_exists(receipt)",
            ExpressionAttributeValues: { ":sending": "sending" },
          }),
        );
        throw error;
      }
      // Do not repeat an external side effect after a timeout or persistence failure.
      await ddb
        .send(
          new UpdateCommand({
            TableName,
            Key,
            UpdateExpression: "SET deliveryState = :uncertain",
            ConditionExpression: "attribute_not_exists(receipt)",
            ExpressionAttributeValues: { ":uncertain": "uncertain" },
          }),
        )
        .catch(() => {});
      throw error;
    }
  }
  await finalizeDelivery(job, receipt, letter, email);
}

/** @param {Record<string, any>} job @param {Record<string, any>} receipt @param {Record<string, any>} letter @param {Record<string, any>} email */
async function finalizeDelivery(job, receipt, letter, email) {
  const TableName = getConfig().dynamoTable;
  if (job.noticeOnly) {
    await ddb.send(
      new UpdateCommand({
        TableName,
        Key: { pk: job.pk, sk: job.sk },
        UpdateExpression: "SET #status = :completed, completedAt = :now",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":completed": "completed",
          ":now": receipt.sentAt,
        },
      }),
    );
    return;
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    const result = await ddb.send(
      new GetCommand({
        TableName,
        Key: { pk: job.pk, sk: "#META" },
        ConsistentRead: true,
      }),
    );
    const count = result.Item?.letterEmailCount;
    const number = Number(count || 0) + 1;
    try {
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName,
                Key: { pk: job.pk, sk: "#META" },
                UpdateExpression: "SET letterEmailCount = :next",
                ConditionExpression:
                  "attribute_exists(pk) AND " +
                  (count === undefined
                    ? "attribute_not_exists(letterEmailCount)"
                    : "letterEmailCount = :count"),
                ExpressionAttributeValues: {
                  ":next": number,
                  ...(count === undefined ? {} : { ":count": count }),
                },
              },
            },
            {
              Put: {
                TableName,
                Item: {
                  pk: job.pk,
                  sk: `LETTER_EMAIL#${job.letterJobId}`,
                  type: "complianceLetterEmail",
                  number,
                  ...receipt,
                  recipients: [
                    ...new Set([email.to, ...(email.cc || [])].filter(Boolean)),
                  ],
                  letter,
                },
                ConditionExpression: "attribute_not_exists(pk)",
              },
            },
            {
              Update: {
                TableName,
                Key: { pk: job.pk, sk: job.sk },
                UpdateExpression: "SET #status = :completed",
                ConditionExpression: "#status <> :completed",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: { ":completed": "completed" },
              },
            },
          ],
        }),
      );
      return;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.name !== "TransactionCanceledException"
      )
        throw error;
      const latest = await ddb.send(
        new GetCommand({
          TableName,
          Key: { pk: job.pk, sk: job.sk },
          ConsistentRead: true,
        }),
      );
      if (latest.Item?.status === "completed") return;
    }
  }
  throw new Error("Letter email history changed repeatedly");
}
/** @param {string} text */
function escapeHtml(text) {
  return text.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ] || c,
  );
}
