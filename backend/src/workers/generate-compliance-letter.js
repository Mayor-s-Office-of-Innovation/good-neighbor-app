import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { getConfig } from "../config.js";
import {
  generateComplianceLetterPdf,
  generateComplianceLetterPreviewSvg,
} from "../domain/compliance-letter-pdf.js";
import { ddb } from "../db.js";
import { putObject } from "../s3.js";

/** @type {import("aws-lambda").SQSHandler} */
export const handler = async (event) => {
  for (const record of event.Records) {
    const message = JSON.parse(record.body);
    const job = await ddb.send(
      new GetCommand({
        TableName: getConfig().dynamoTable,
        Key: { pk: message.jobPk, sk: message.jobSk },
        ConsistentRead: true,
      }),
    );
    if (!job.Item || job.Item.status === "completed") continue;
    const termResult = await ddb.send(
      new GetCommand({
        TableName: getConfig().dynamoTable,
        Key: { pk: `SITE#${message.siteId}`, sk: job.Item.termsSk },
        ConsistentRead: true,
      }),
    );
    const term = termResult.Item;
    if (!term) throw new Error("Compliance period not found for letter job");
    const siteResult = await ddb.send(
      new GetCommand({
        TableName: getConfig().dynamoTable,
        Key: { pk: `SITE#${message.siteId}`, sk: "#META" },
        ConsistentRead: true,
      }),
    );
    if (
      siteResult.Item?.latestComplianceTermsVersionId !== term.termsVersionId
    ) {
      await ddb.send(
        new UpdateCommand({
          TableName: getConfig().dynamoTable,
          Key: { pk: message.jobPk, sk: message.jobSk },
          UpdateExpression: "SET #status = :superseded, completedAt = :now",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":superseded": "superseded",
            ":now": new Date().toISOString(),
          },
        }),
      );
      continue;
    }
    const pdf = generateComplianceLetterPdf(term);
    const key = `compliance-letters/${message.siteId}/${term.termsVersionId}.pdf`;
    const previewKey = `compliance-letters/${message.siteId}/${term.termsVersionId}-preview.svg`;
    await Promise.all([
      putObject({
        bucket: getConfig().uploadBucket,
        key,
        body: pdf,
        contentType: "application/pdf",
        metadata: { "terms-version-id": String(term.termsVersionId) },
      }),
      putObject({
        bucket: getConfig().uploadBucket,
        key: previewKey,
        body: generateComplianceLetterPreviewSvg(term),
        contentType: "image/svg+xml",
        metadata: { "terms-version-id": String(term.termsVersionId) },
      }),
    ]);
    const createdAt = new Date().toISOString();
    const letter = {
      s3Key: key,
      previewS3Key: previewKey,
      fileName: `perimeter-check-requirement-${term.effectiveStart}.pdf`,
      effectiveStart: term.effectiveStart,
      termsVersionId: term.termsVersionId,
      createdAt,
      status: "generated",
    };
    await ddb.send(
      new UpdateCommand({
        TableName: getConfig().dynamoTable,
        Key: { pk: `SITE#${message.siteId}`, sk: "#META" },
        UpdateExpression:
          "SET complianceLetters = :letters, letterState = :ready, updatedAt = :now",
        ConditionExpression: "latestComplianceTermsVersionId = :version",
        ExpressionAttributeValues: {
          ":letters": { current: letter, past: message.previousLetters || [] },
          ":ready": "generated",
          ":now": createdAt,
          ":version": term.termsVersionId,
        },
      }),
    );
    await ddb.send(
      new UpdateCommand({
        TableName: getConfig().dynamoTable,
        Key: { pk: message.jobPk, sk: message.jobSk },
        UpdateExpression:
          "SET #status = :completed, completedAt = :now, s3Key = :key",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":completed": "completed",
          ":now": createdAt,
          ":key": key,
        },
      }),
    );
  }
};
