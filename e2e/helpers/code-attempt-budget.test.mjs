import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { resetCodeAttemptBudget } from "./code-attempt-budget.mjs";
import { E2E_URLS } from "./ports.js";

function ownedEnv() {
  return {
    AWS_ENDPOINT_URL_DYNAMODB: E2E_URLS.ddb,
    DYNAMO_TABLE: "gnp-local-e2e",
    SQS_QUEUE_URL: `${E2E_URLS.mq}/local/gnp-local-e2e-submissions`,
  };
}

test("clears only the four current login counters in this run's local table", async () => {
  const env = ownedEnv();
  const now = Date.UTC(2026, 9, 29, 12, 1);
  const seconds = Math.floor(now / 1000);
  let input;
  await resetCodeAttemptBudget({
    env,
    now,
    send: async (command) => {
      input = command.input;
    },
  });
  const source = createHash("sha256").update("127.0.0.1").digest("hex");
  assert.deepEqual(
    input.TransactItems,
    ["SHORT_CODE_ATTEMPTS", `SHORT_CODE_SOURCE#${source}`].flatMap((pk) =>
      [300, 86400].map((window) => ({
        Delete: {
          TableName: env.DYNAMO_TABLE,
          Key: { pk, sk: `${window}#${Math.floor(seconds / window) * window}` },
        },
      })),
    ),
  );
});

test("refuses foreign tables, queues, and nonlocal endpoints before any mutation", async () => {
  const owned = ownedEnv();
  for (const overrides of [
    { DYNAMO_TABLE: "gnp-local-app" },
    { SQS_QUEUE_URL: "https://example.test/queue" },
    { DYNAMO_TABLE: "" },
    ...[
      "",
      "https://dynamodb.us-east-1.amazonaws.com",
      "http://example.test:8000",
      "http://127.0.0.1:9000",
      "http://127.0.0.1:8000",
      "http://user:pass@127.0.0.1:8010",
      "http://127.0.0.1:8010/?foreign=true",
      "http://127.0.0.1:8010/#foreign",
      "http://localhost:8000/foreign",
    ].map((AWS_ENDPOINT_URL_DYNAMODB) => ({ AWS_ENDPOINT_URL_DYNAMODB })),
  ]) {
    let calls = 0;
    await assert.rejects(
      resetCodeAttemptBudget({
        env: { ...owned, ...overrides },
        send: async () => {
          calls++;
        },
      }),
    );
    assert.equal(calls, 0);
  }
});

test("propagates cleanup failures rather than continuing with a contaminated budget", async () => {
  const error = new Error("synthetic database failure");
  await assert.rejects(
    resetCodeAttemptBudget({
      env: ownedEnv(),
      send: async () => {
        throw error;
      },
    }),
    error,
  );
});
