import assert from "node:assert/strict";
import test from "node:test";

import { mapWithConcurrency } from "./concurrency.js";

test("maps in input order without exceeding the concurrency limit", async () => {
  let active = 0;
  let maximumActive = 0;

  const results = await mapWithConcurrency(
    [1, 2, 3, 4, 5],
    2,
    async (value) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 2 * (6 - value)));
      active -= 1;
      return value * 10;
    },
  );

  assert.deepEqual(results, [10, 20, 30, 40, 50]);
  assert.equal(maximumActive, 2);
});

test("rejects a non-positive concurrency limit", async () => {
  await assert.rejects(
    mapWithConcurrency([1], 0, async (value) => value),
    /concurrency_limit_must_be_positive/,
  );
});
