// @ts-nocheck -- SQS/Dynamo payloads are runtime-validated at this boundary.
import { GetCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../db.js";
import { getConfig } from "../config.js";
import { getObjectBytes, presignGet } from "../s3.js";
import { downscaleImage } from "../media/downscale.js";
import { createAnalyzerClient } from "../analysis/analyzer-client.js";
import { getAnalyzerApiKey } from "../analysis/api-key.js";
import {
  complaintArtifactPrefix,
  complaintKey,
  sitePk,
} from "../handlers/keys.js";

const OUTPUT_FIELDS = ["label", "detail", "what", "where", "when", "notes"];

const validatedResult = (body) => {
  const value = body?.complaint;
  if (!value || typeof value !== "object")
    throw new Error("invalid complaint response");
  const result = {};
  for (const field of OUTPUT_FIELDS) {
    if (typeof value[field] !== "string")
      throw new Error(`invalid complaint ${field}`);
    result[field] = value[field].trim();
  }
  if (!result.label || result.label.length > 60 || !result.detail)
    throw new Error("invalid complaint summary");
  return result;
};

async function processComplaint(msg) {
  const config = getConfig();
  const headerKey = complaintKey(msg.siteId, msg.complaintId);
  const [header, artifactResult] = await Promise.all([
    ddb.send(new GetCommand({ TableName: config.dynamoTable, Key: headerKey })),
    ddb.send(
      new QueryCommand({
        TableName: config.dynamoTable,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: {
          ":pk": sitePk(msg.siteId),
          ":prefix": complaintArtifactPrefix(msg.complaintId),
        },
      }),
    ),
  ]);
  if (!header.Item || header.Item.status !== "analyzing") return;
  const files = [];
  for (const artifact of artifactResult.Items || []) {
    const isImage = [
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/heic",
      "image/heif",
    ].includes(artifact.contentType);
    if (!isImage) {
      files.push({
        name: artifact.name,
        content_type: artifact.contentType,
        source_url: await presignGet({
          bucket: config.uploadBucket,
          key: artifact.s3Key,
          expiresIn: 300,
        }),
      });
      continue;
    }
    const object = await getObjectBytes({
      bucket: config.uploadBucket,
      key: artifact.s3Key,
    });
    let bytes = object.bytes;
    let contentType = artifact.contentType;
    const normalized = await downscaleImage(bytes, contentType);
    bytes = normalized.bytes;
    contentType = normalized.contentType;
    files.push({
      name: artifact.name,
      content_type: contentType,
      base64: bytes.toString("base64"),
    });
  }
  const client = createAnalyzerClient({
    baseUrl: config.analyzerBaseUrl,
    apiKey: await getAnalyzerApiKey(config),
  });
  const response = await client.extractComplaint({
    description: header.Item.description,
    files,
    requestId: msg.complaintId,
    appId: "good-neighbor-app",
  });
  const complaint = validatedResult(response);
  await ddb.send(
    new UpdateCommand({
      TableName: config.dynamoTable,
      Key: headerKey,
      UpdateExpression:
        "SET #status = :ready, label = :label, detail = :detail, #what = :what, #where = :where, #when = :when, notes = :notes, analyzedAt = :now, updatedAt = :now, analysisVersion = :version",
      ConditionExpression: "#status = :analyzing",
      ExpressionAttributeNames: {
        "#status": "status",
        "#what": "what",
        "#where": "where",
        "#when": "when",
      },
      ExpressionAttributeValues: {
        ":ready": "ready",
        ":analyzing": "analyzing",
        ":label": complaint.label,
        ":detail": complaint.detail,
        ":what": complaint.what,
        ":where": complaint.where,
        ":when": complaint.when,
        ":notes": complaint.notes,
        ":now": new Date().toISOString(),
        ":version": "1",
      },
    }),
  );
}

export async function handler(event) {
  const msg = JSON.parse(event.Records[0].body);
  try {
    await processComplaint(msg);
  } catch (error) {
    const receiveCount = Number(
      event.Records[0].attributes?.ApproximateReceiveCount || 1,
    );
    if (receiveCount >= 5) {
      await ddb.send(
        new UpdateCommand({
          TableName: getConfig().dynamoTable,
          Key: complaintKey(msg.siteId, msg.complaintId),
          UpdateExpression:
            "SET #status = :failed, label = :label, updatedAt = :now",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":failed": "analysis_failed",
            ":label": "Complaint log failed",
            ":now": new Date().toISOString(),
          },
        }),
      );
      return;
    }
    throw error;
  }
}
