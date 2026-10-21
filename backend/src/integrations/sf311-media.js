import { createHash, randomBytes } from "node:crypto";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../db.js";
import { getConfig } from "../config.js";
import { jsonResponse } from "../http.js";
import { presignGet } from "../s3.js";

export const SF311_MEDIA_LEASE_SECONDS = 48 * 60 * 60;

/** @param {string} token */
function leaseKey(token) {
  return {
    PK: `SF311_MEDIA#${createHash("sha256").update(token).digest("hex")}`,
    SK: "LEASE",
  };
}

/**
 * Persist a bearer lease independent of Lambda's temporary signing credentials.
 * Only the token hash is stored; the link grants access to this one image.
 * @param {{config: import("../config.js").AppConfig, key: string}} options
 * @returns {Promise<string>}
 */
export async function create311MediaLink({ config, key }) {
  if (!config.sf311MediaBaseUrl) {
    throw new Error(
      "SF311_MEDIA_BASE_URL is required for 311 image attachments",
    );
  }
  const url = new URL("/v1/311-media", config.sf311MediaBaseUrl);
  const token = randomBytes(32).toString("hex");
  await ddb.send(
    new PutCommand({
      TableName: config.dynamoTable,
      Item: {
        ...leaseKey(token),
        entityType: "SF311_MEDIA_LEASE",
        s3Key: key,
        expiresAt: Math.floor(Date.now() / 1000) + SF311_MEDIA_LEASE_SECONDS,
      },
      ConditionExpression: "attribute_not_exists(PK)",
    }),
  );
  url.searchParams.set("token", token);
  return url.toString();
}

/**
 * Anonymous bearer access for SF311. Check expiry explicitly: DynamoDB TTL
 * deletion is asynchronous. Each read uses current AWS credentials, with the
 * redirect's lifetime capped to the remaining lease.
 * @param {import("aws-lambda").APIGatewayProxyEventV2} event
 */
export async function get311Media(event) {
  const token = event.queryStringParameters?.token;
  if (!token || !/^[a-f0-9]{64}$/.test(token)) {
    return jsonResponse(404, { error: "not_found" });
  }
  const config = getConfig();
  const { Item } = await ddb.send(
    new GetCommand({
      TableName: config.dynamoTable,
      Key: leaseKey(token),
      ConsistentRead: true,
    }),
  );
  const remaining = Math.floor(Number(Item?.expiresAt) - Date.now() / 1000);
  if (!Item || !Number.isFinite(remaining) || remaining <= 0 || !Item.s3Key) {
    return jsonResponse(404, { error: "not_found" });
  }
  const location = await presignGet({
    bucket: config.uploadBucket,
    key: String(Item.s3Key),
    expiresIn: Math.min(300, remaining),
  });
  return {
    statusCode: 302,
    headers: {
      location,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
    body: "",
  };
}
