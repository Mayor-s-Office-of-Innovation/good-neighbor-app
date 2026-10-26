import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { createHash, randomUUID } from "node:crypto";

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
 * All clients for one endpoint/table serialize HTTP starts under an owned lease.
 * The cooldown is written AFTER start(), so write latency cannot shorten it.
 * Responses remain concurrent. Crashed owners expire; stale owners cannot start
 * or release another owner's lease.
 * Database failures fail closed, rather than bypassing the shared rate limit.
 * @param {{ddb:import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient,table:string,baseUrl:string,requestsPerSecond:number}} options
 * @returns {(signal:globalThis.AbortSignal,start:()=>Promise<Response>)=>Promise<{pending:Promise<Response>}>}
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
  return async (signal, start) => {
    while (true) {
      signal.throwIfAborted();
      const now = Date.now();
      const owner = randomUUID();
      // Enough time to record cooldown, while ensuring expiry after a crash
      // cannot grant a new start less than one interval after this start.
      const leaseUntil = now + interval + 5000;
      try {
        await ddb.send(
          new UpdateCommand({
            TableName: table,
            Key: key,
            UpdateExpression:
              "SET #owner = :owner, leaseUntil = :lease, expiresAt = :ttl",
            ConditionExpression:
              "(attribute_not_exists(leaseUntil) OR leaseUntil <= :now) AND (attribute_not_exists(nextAllowedAt) OR nextAllowedAt <= :now)",
            ExpressionAttributeNames: { "#owner": "owner" },
            ExpressionAttributeValues: {
              ":now": now,
              ":owner": owner,
              ":lease": leaseUntil,
              ":ttl": Math.floor(now / 1000) + 86400,
            },
          }),
          { abortSignal: signal },
        );
      } catch (error) {
        if (
          !(error instanceof Error) ||
          error.name !== "ConditionalCheckFailedException"
        )
          throw error;
        const { Item } = await ddb.send(
          new GetCommand({ TableName: table, Key: key, ConsistentRead: true }),
          { abortSignal: signal },
        );
        const next = Number(Item?.nextAllowedAt ?? 0);
        const lease = Number(Item?.leaseUntil ?? 0);
        if (!Number.isFinite(next) || !Number.isFinite(lease))
          throw new Error("Invalid comparison pacing state");
        // Poll held leases briefly: the owner usually releases after one write,
        // not after its lease timeout. Cooldowns need no polling.
        const wait = Math.max(
          next - Date.now(),
          Math.min(100, lease - Date.now()),
          1,
        );
        await comparisonWait(wait + 5 + Math.random() * 25, signal);
        continue;
      }
      signal.throwIfAborted();
      // A delayed acknowledgement is not permission to send on an expired or
      // nearly expired lease. Leave it to expire and reacquire instead.
      if (Date.now() + interval >= leaseUntil) continue;
      // No await between the lease check and the synchronous HTTP start.
      const pending = start();
      // The HTTP response may settle before the cooldown write finishes.
      // Preserve rejection for the caller without an unhandled rejection.
      void pending.catch(() => {});
      await ddb.send(
        new UpdateCommand({
          TableName: table,
          Key: key,
          UpdateExpression:
            "SET nextAllowedAt = :next REMOVE #owner, leaseUntil",
          ConditionExpression: "#owner = :owner",
          ExpressionAttributeNames: { "#owner": "owner" },
          ExpressionAttributeValues: {
            ":owner": owner,
            ":next": Date.now() + interval,
          },
        }),
        { abortSignal: signal },
      );
      signal.throwIfAborted();
      return { pending };
    }
  };
}
