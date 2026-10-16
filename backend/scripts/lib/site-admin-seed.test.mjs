import { test } from "node:test";
import assert from "node:assert/strict";
import { assertLocalSeedTarget } from "./site-admin-seed.mjs";

test("local seeding refuses cloud endpoints and non-local tables", () => {
  const names = [
    "AWS_ENDPOINT_URL_DYNAMODB",
    "AWS_ENDPOINT_URL_SQS",
    "AWS_ENDPOINT_URL_S3",
    "DYNAMO_TABLE",
  ];
  const previous = Object.fromEntries(
    names.map((name) => [name, process.env[name]]),
  );
  try {
    for (const name of names.slice(0, 3))
      process.env[name] = "http://localhost:8000";
    process.env.DYNAMO_TABLE = "gnp-local-app";
    assert.doesNotThrow(assertLocalSeedTarget);
    for (const name of names.slice(0, 3)) {
      process.env[name] = "https://dynamodb.us-west-2.amazonaws.com";
      assert.throws(assertLocalSeedTarget, /localhost emulator/);
      process.env[name] = "http://localhost:8000";
    }
    process.env.DYNAMO_TABLE = "good-neighbor-app-dev-app";
    assert.throws(assertLocalSeedTarget, /gnp-local/);
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});
