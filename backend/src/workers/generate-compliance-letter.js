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
    const pdf = await generateComplianceLetterPdf(term);
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
    const saved = await saveCurrentLetter(message.siteId, term, letter);
    if (!saved) {
      await markJobSuperseded(message.jobPk, message.jobSk);
      continue;
    }
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

/**
 * Merge against the latest letter history and use an optimistic condition so
 * concurrent uploads cannot be overwritten by a stale worker snapshot.
 * @param {string} siteId
 * @param {Record<string, any>} term
 * @param {Record<string, any>} letter
 */
async function saveCurrentLetter(siteId, term, letter) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await ddb.send(
      new GetCommand({
        TableName: getConfig().dynamoTable,
        Key: { pk: `SITE#${siteId}`, sk: "#META" },
        ConsistentRead: true,
      }),
    );
    const site = result.Item;
    if (!site || site.latestComplianceTermsVersionId !== term.termsVersionId) {
      return false;
    }
    const observedLetters = site.complianceLetters;
    const past = uniqueLetters([
      ...(observedLetters?.current ? [observedLetters.current] : []),
      ...(observedLetters?.past ?? []),
    ]).filter((item) => item.termsVersionId !== term.termsVersionId);
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: getConfig().dynamoTable,
          Key: { pk: `SITE#${siteId}`, sk: "#META" },
          UpdateExpression:
            "SET complianceLetters = :letters, letterState = :ready, updatedAt = :now",
          ConditionExpression: observedLetters
            ? "latestComplianceTermsVersionId = :version AND complianceLetters = :observedLetters"
            : "latestComplianceTermsVersionId = :version AND attribute_not_exists(complianceLetters)",
          ExpressionAttributeValues: {
            ":letters": { current: letter, past },
            ":ready": "generated",
            ":now": letter.createdAt,
            ":version": term.termsVersionId,
            ...(observedLetters ? { ":observedLetters": observedLetters } : {}),
          },
        }),
      );
      return true;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.name !== "ConditionalCheckFailedException"
      ) {
        throw error;
      }
    }
  }
  throw new Error("Compliance letter history changed repeatedly");
}

/** @param {Record<string, any>[]} letters */
function uniqueLetters(letters) {
  const seen = new Set();
  return letters.filter((letter) => {
    const key = String(letter.termsVersionId || letter.s3Key || "");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** @param {string} jobPk @param {string} jobSk */
async function markJobSuperseded(jobPk, jobSk) {
  await ddb.send(
    new UpdateCommand({
      TableName: getConfig().dynamoTable,
      Key: { pk: jobPk, sk: jobSk },
      UpdateExpression: "SET #status = :superseded, completedAt = :now",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":superseded": "superseded",
        ":now": new Date().toISOString(),
      },
    }),
  );
}
