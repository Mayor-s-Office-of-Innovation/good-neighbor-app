// Entirely separate from the normal analysis queue/pump, as in deployment.
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from "@aws-sdk/client-sqs";
import { ddb } from "../src/db.js";
import { handler as dispatch } from "../src/lambda/duplicate-dispatch.js";
import { handler as work } from "../src/lambda/duplicate-worker.js";
import { ensureLocalInfra } from "./lib/ensure-infra.mjs";
import { createLocalDuplicateStream } from "./lib/local-duplicate-stream.mjs";

// Fail closed rather than accidentally scanning an AWS table or consuming a
// deployed queue with this development-only bridge.
for (const name of ["AWS_ENDPOINT_URL_DYNAMODB", "AWS_ENDPOINT_URL_SQS"]) {
  const url = new URL(process.env[name] ?? "http://invalid");
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    throw new Error(`${name} must point to a loopback emulator`);
}
if (process.env.DUPLICATE_DETECTION_ENABLED !== "true") {
  console.log(
    "[duplicates] disabled; set DUPLICATE_DETECTION_ENABLED=true to start",
  );
  const idle = setInterval(() => {}, 60_000);
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => clearInterval(idle));
} else {
  if (!process.env.DUPLICATE_ANALYZER_BASE_URL)
    throw new Error("DUPLICATE_ANALYZER_BASE_URL is required");
  if (
    !process.env.DUPLICATE_QUEUE_URL ||
    process.env.DUPLICATE_QUEUE_URL === process.env.SQS_QUEUE_URL
  )
    throw new Error("A separate DUPLICATE_QUEUE_URL is required");
  const { tableName } = await ensureLocalInfra();
  const sqs = new SQSClient({});
  let running = true;
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => {
      running = false;
    });
  const bridge = createLocalDuplicateStream(dispatch);
  async function scanLoop() {
    while (running) {
      try {
        const items = [];
        let cursor;
        do {
          const page = await ddb.send(
            new ScanCommand({
              TableName: tableName,
              ConsistentRead: true,
              ExclusiveStartKey: cursor,
            }),
          );
          items.push(...(page.Items ?? []));
          cursor = page.LastEvaluatedKey;
        } while (cursor);
        await bridge(items);
      } catch (error) {
        console.error("[duplicates] stream bridge failed:", error.name);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  async function queueLoop() {
    while (running) {
      try {
        const page = await sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: process.env.DUPLICATE_QUEUE_URL,
            MaxNumberOfMessages: 1,
            WaitTimeSeconds: 1,
            VisibilityTimeout: 900,
            MessageSystemAttributeNames: ["SentTimestamp"],
          }),
        );
        for (const message of page.Messages ?? []) {
          try {
            const result = await work({
              Records: [
                {
                  messageId: message.MessageId,
                  body: message.Body ?? "",
                  attributes: message.Attributes ?? {},
                },
              ],
            });
            if (!result?.batchItemFailures?.length)
              await sqs.send(
                new DeleteMessageCommand({
                  QueueUrl: process.env.DUPLICATE_QUEUE_URL,
                  ReceiptHandle: message.ReceiptHandle,
                }),
              );
            else
              console.error(
                "[duplicates] job failed; retained for redelivery",
                message.MessageId,
              );
          } catch (error) {
            console.error("[duplicates] job failed:", error.name);
          }
        }
      } catch (error) {
        console.error("[duplicates] receive failed:", error.name);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }
  console.log("[duplicates] local stream bridge and isolated queue ready");
  await Promise.all([scanLoop(), queueLoop()]);
}
