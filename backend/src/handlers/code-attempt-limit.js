import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../db.js";
import { getDynamoTableName } from "../config.js";
import { jsonResponse } from "../http.js";

// One budget across lookup, enrollment and device registration, including direct-origin
// requests. Never trust forwarded IP headers or key this by a guessed code.
const WINDOWS = [
  { seconds: 300, limit: 1000 },
  { seconds: 86400, limit: 10000 },
];

/**
 * @param {number} [now]
 * @param {"lookup" | "redeem" | "register" | "unspecified"} [source]
 * @param {import("aws-lambda").APIGatewayProxyEventV2} [event]
 * @returns {Promise<import("aws-lambda").APIGatewayProxyResult | null>} Budget rejection, or admission.
 */
export async function checkCodeAttemptLimit(
  now = Date.now(),
  source = "unspecified",
  event,
) {
  const seconds = Math.floor(now / 1000);
  const sourceIp = codeAttemptSource(event);
  const sourceKey = createHash("sha256").update(sourceIp).digest("hex");
  const windows = [
    ...WINDOWS.map((window) => ({ ...window, pk: "SHORT_CODE_ATTEMPTS" })),
    ...WINDOWS.map((window) => ({
      ...window,
      limit: window.limit / 10,
      pk: `SHORT_CODE_SOURCE#${sourceKey}`,
    })),
  ].map((window) => ({
    ...window,
    start: Math.floor(seconds / window.seconds) * window.seconds,
  }));
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: windows.map((window) => ({
          Update: {
            TableName: getDynamoTableName(),
            Key: {
              pk: window.pk,
              sk: `${window.seconds}#${window.start}`,
            },
            UpdateExpression: "SET expiresAt = :ttl ADD requestCount :one",
            ConditionExpression:
              "attribute_not_exists(requestCount) OR requestCount < :limit",
            ExpressionAttributeValues: {
              ":one": 1,
              ":limit": window.limit,
              ":ttl": window.start + window.seconds * 2,
            },
          },
        })),
      }),
    );
    // Admission counts requests, not successful authentication. Only fixed
    // route labels and budget outcomes are logged, never submitted credentials.
    console.info(
      JSON.stringify({
        marker: "ShortCodeAttempt",
        source,
        outcome: "admitted",
      }),
    );
    return null;
  } catch (error) {
    const reasons = /** @type {{CancellationReasons?: {Code?: string}[]}} */ (
      error
    )?.CancellationReasons;
    if (
      !(error instanceof Error) ||
      error.name !== "TransactionCanceledException" ||
      !reasons?.some((reason) => reason.Code === "ConditionalCheckFailed")
    ) {
      console.warn(
        JSON.stringify({
          marker: "ShortCodeAttempt",
          source,
          outcome: "store_error",
        }),
      );
      throw error;
    }
    const retryAfter = Math.max(
      ...windows.map((window, index) =>
        reasons[index]?.Code === "ConditionalCheckFailed"
          ? window.start + window.seconds - seconds
          : 0,
      ),
    );
    console.info(
      JSON.stringify({ marker: "ShortCodeThrottled", source, retryAfter }),
    );
    const response = jsonResponse(429, { error: "code_attempts_limited" });
    response.headers = {
      ...response.headers,
      "retry-after": String(retryAfter),
    };
    return response;
  }
}

/**
 * Only the authenticated CloudFront origin may supply the viewer identity.
 * Direct-origin callers use Gateway's transport source; forwarded headers are ignored.
 * @param {import("aws-lambda").APIGatewayProxyEventV2} [event]
 * @returns {string} Canonical source address, or a shared fail-closed fallback.
 */
export function codeAttemptSource(event) {
  const configured = process.env.SHORT_CODE_ORIGIN_TOKEN;
  const supplied = event?.headers?.["x-support-origin"];
  const viewer = event?.headers?.["x-code-viewer-ip"];
  const trusted =
    configured &&
    supplied &&
    Buffer.byteLength(configured) === Buffer.byteLength(supplied) &&
    timingSafeEqual(Buffer.from(configured), Buffer.from(supplied));
  const address = trusted ? viewer : event?.requestContext?.http?.sourceIp;
  if (!address || !isIP(address)) return "unknown";
  // URL canonicalization collapses equivalent IPv6 spellings.
  return isIP(address) === 6
    ? new URL(`http://[${address}]/`).hostname
    : address;
}
