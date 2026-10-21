import { createHash, randomBytes } from "node:crypto";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../db.js";
import { getConfig } from "../config.js";
import { jsonResponse } from "../http.js";
import { logServerError } from "../lib/log-server-error.js";
import { copyObject, presignGet } from "../s3.js";

// Also protect direct-origin and local responses; the media CloudFront policy
// enforces equivalent headers on edge-generated responses.
const MEDIA_HEADERS = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "strict-transport-security": "max-age=31536000; includeSubDomains; preload",
  "content-security-policy":
    "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
};

/**
 * @param {number} statusCode
 * @param {string} error
 * @returns {import("aws-lambda").APIGatewayProxyResult}
 */
function mediaError(statusCode, error) {
  const response = jsonResponse(statusCode, { error });
  return { ...response, headers: { ...response.headers, ...MEDIA_HEADERS } };
}

export const SF311_MEDIA_LEASE_SECONDS = 48 * 60 * 60;

/** @param {string} token */
function leaseKey(token) {
  return {
    pk: `SF311_MEDIA#${createHash("sha256").update(token).digest("hex")}`,
    sk: "LEASE",
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
  // Use a separate random id: no object key or stored row contains the bearer.
  const mediaKey = `sf311-media/${randomBytes(32).toString("hex")}`;
  await copyObject({
    bucket: config.uploadBucket,
    sourceKey: key,
    key: mediaKey,
  });
  await ddb.send(
    new PutCommand({
      TableName: config.dynamoTable,
      Item: {
        ...leaseKey(token),
        entityType: "SF311_MEDIA_LEASE",
        s3Key: mediaKey,
        sourceS3Key: key,
        expiresAt: Math.floor(Date.now() / 1000) + SF311_MEDIA_LEASE_SECONDS,
      },
      ConditionExpression: "attribute_not_exists(pk)",
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
  try {
    return await resolve311Media(event);
  } catch {
    // Do not log the original error: SDK/client messages may contain a URL.
    logServerError(
      "api GET /v1/311-media",
      new Error("311 media access failed"),
      {
        reqId: event.requestContext?.requestId,
      },
    );
    return mediaError(500, "internal_error");
  }
}

/** @param {import("aws-lambda").APIGatewayProxyEventV2} event */
async function resolve311Media(event) {
  const token = event.queryStringParameters?.token;
  if (!token || !/^[a-f0-9]{64}$/.test(token)) {
    return mediaError(404, "not_found");
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
    return mediaError(404, "not_found");
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
      ...MEDIA_HEADERS,
    },
    body: "",
  };
}
