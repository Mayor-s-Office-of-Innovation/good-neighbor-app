import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { createHash } from "node:crypto";

/**
 * Abortable waits share the comparison's deadline, including pacing and backoff.
 * @param {number} ms
 * @param {globalThis.AbortSignal} signal
 * @returns {Promise<void>}
 */
export function comparisonWait(ms, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const aborted = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(
      () => {
        signal.removeEventListener("abort", aborted);
        resolve();
      },
      Math.min(ms, 2_147_483_647),
    );
    signal.addEventListener("abort", aborted, { once: true });
  });
}

/**
 * All clients for one endpoint/table contend on one conditional permit. Failed
 * writes do not reserve future slots; a crashed worker wastes at most one slot.
 * Database failures fail closed, rather than bypassing the shared rate limit.
 * @param {{ddb:import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient,table:string,baseUrl:string,requestsPerSecond:number}} options
 * @returns {(signal:globalThis.AbortSignal)=>Promise<void>}
 */
export function createComparisonPacer({
  ddb,
  table,
  baseUrl,
  requestsPerSecond,
}) {
  if (
    !table ||
    !Number.isFinite(requestsPerSecond) ||
    requestsPerSecond <= 0 ||
    requestsPerSecond > 32
  )
    throw new Error("Invalid comparison pacing configuration");
  const endpoint = new URL(
    "v1/image-comparisons",
    baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`,
  ).href;
  const key = {
    pk: "DUP_COMPARISON_PACER",
    sk: createHash("sha256").update(endpoint).digest("hex"),
  };
  const interval = Math.ceil(1000 / requestsPerSecond);
  return async (signal) => {
    while (true) {
      signal.throwIfAborted();
      const now = Date.now();
      try {
        await ddb.send(
          new UpdateCommand({
            TableName: table,
            Key: key,
            UpdateExpression: "SET nextAllowedAt = :next, expiresAt = :ttl",
            ConditionExpression:
              "attribute_not_exists(nextAllowedAt) OR nextAllowedAt <= :now",
            ExpressionAttributeValues: {
              ":now": now,
              ":next": now + interval,
              ":ttl": Math.floor(now / 1000) + 86400,
            },
          }),
          { abortSignal: signal },
        );
        signal.throwIfAborted();
        return;
      } catch (error) {
        if (
          !(error instanceof Error) ||
          error.name !== "ConditionalCheckFailedException"
        )
          throw error;
      }
      const { Item } = await ddb.send(
        new GetCommand({ TableName: table, Key: key, ConsistentRead: true }),
        { abortSignal: signal },
      );
      const next = Number(Item?.nextAllowedAt);
      if (!Number.isFinite(next))
        throw new Error("Invalid comparison pacing state");
      // Small jitter prevents every contending worker waking at the same instant.
      await comparisonWait(
        Math.max(1, next - Date.now()) + 5 + Math.random() * 25,
        signal,
      );
    }
  };
}
