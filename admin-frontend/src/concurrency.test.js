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

for (const siblingFails of [false, true]) {
  test(`stops scheduling and drains active workers when a sibling ${siblingFails ? "fails" : "succeeds"}`, async () => {
    const firstError = new Error("first failure");
    const started = [];
    const gates = Array.from({ length: 3 }, () => Promise.withResolvers());
    let settled = false;
    const result = mapWithConcurrency([0, 1, 2, 3, 4], 3, (value) => {
      started.push(value);
      return gates[value].promise;
    });
    const observed = result.then(
      () => {
        settled = true;
        assert.fail("Expected the mapper failure");
      },
      (error) => {
        settled = true;
        assert.equal(error, firstError);
      },
    );

    assert.deepEqual(started, [0, 1, 2]);
    // Fail a later input first: preserve failure order, not input order.
    gates[1].reject(firstError);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    if (siblingFails) gates[0].reject(new Error("later failure"));
    else gates[0].resolve(0);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(started, [0, 1, 2]);
    assert.equal(settled, false);

    gates[2].resolve(2);
    await observed;
    assert.deepEqual(started, [0, 1, 2]);
  });
}

test("a synchronous mapper failure stops scheduling and preserves a falsy reason", async () => {
  const started = [];
  const result = mapWithConcurrency([0, 1, 2], 3, (value) => {
    started.push(value);
    throw undefined;
  });
  await result.then(
    () => assert.fail("Expected rejection"),
    (error) => assert.equal(error, undefined),
  );
  assert.deepEqual(started, [0]);
});
