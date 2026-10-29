import assert from "node:assert/strict";
import { test } from "node:test";
import { configureRunResources, assertRunResources } from "./run-resources.mjs";

test("independent runs own distinct tables and queues; workers inherit ownership", () => {
  const first = {},
    second = {};
  const a = configureRunResources(first),
    b = configureRunResources(second);
  assert.notEqual(a.tableName, b.tableName);
  assert.notEqual(a.queueUrl, b.queueUrl);
  assert.deepEqual(configureRunResources({ ...first }), a);
  assert.deepEqual(assertRunResources(first), a);
});

test("cleanup refuses absent identity, malformed identity, and foreign resources", () => {
  assert.throws(() => assertRunResources({}), /E2E_RUN_ID/);
  assert.throws(
    () => configureRunResources({ E2E_RUN_ID: "../dev" }),
    /E2E_RUN_ID/,
  );
  const owned = {};
  configureRunResources(owned);
  assert.throws(
    () => assertRunResources({ ...owned, DYNAMO_TABLE: "gnp-local-app" }),
    /outside this run/,
  );
  assert.throws(
    () =>
      assertRunResources({
        ...owned,
        SQS_QUEUE_URL: "https://sqs.us-east-1.amazonaws.com/123/live",
      }),
    /outside this run/,
  );
  const other = {};
  configureRunResources(other);
  assert.throws(
    () => assertRunResources({ ...owned, DYNAMO_TABLE: other.DYNAMO_TABLE }),
    /outside this run/,
  );
});
