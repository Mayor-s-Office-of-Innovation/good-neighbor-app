import { createHash } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { E2E_PORTS, E2E_URLS } from "./ports.js";

/**
 * Give each browser binding its own test budget. The local adapter reports all
 * browsers as 127.0.0.1; shared counters otherwise throttle unrelated scenarios.
 * Production enforcement and counters within each scenario remain unchanged.
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {number} [options.now]
 * @param {(command: TransactWriteCommand) => Promise<unknown>} [options.send]
 * @returns {Promise<void>}
 */
export async function resetCodeAttemptBudget({
  env = process.env,
  now = Date.now(),
  send,
} = {}) {
  const tableName = "gnp-local-e2e";
  if (
    env.DYNAMO_TABLE !== tableName ||
    env.SQS_QUEUE_URL !== `${E2E_URLS.mq}/local/${tableName}-submissions`
  )
    throw new Error(
      "[e2e] refusing to reset code attempts outside the suite stack",
    );
  const endpoint = new URL(env.AWS_ENDPOINT_URL_DYNAMODB || "");
  if (
    endpoint.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(endpoint.hostname) ||
    endpoint.port !== String(E2E_PORTS.ddb) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== "/" ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error(
      "[e2e] refusing to reset code attempts outside DynamoDB Local",
    );

  const source = createHash("sha256").update("127.0.0.1").digest("hex");
  const seconds = Math.floor(now / 1000);
  const command = new TransactWriteCommand({
    TransactItems: [
      "SHORT_CODE_ATTEMPTS",
      `SHORT_CODE_SOURCE#${source}`,
    ].flatMap((pk) =>
      [300, 86400].map((window) => ({
        Delete: {
          TableName: tableName,
          Key: { pk, sk: `${window}#${Math.floor(seconds / window) * window}` },
        },
      })),
    ),
  });
  if (send) {
    await send(command);
    return;
  }
  const client = DynamoDBDocumentClient.from(
    new DynamoDBClient({
      endpoint: E2E_URLS.ddb,
      region: "us-east-1",
      credentials: { accessKeyId: "local", secretAccessKey: "local" },
    }),
  );
  try {
    await client.send(command);
  } finally {
    client.destroy();
  }
}
