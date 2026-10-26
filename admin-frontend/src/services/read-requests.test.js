import test from "node:test";
import assert from "node:assert/strict";
import { createReadRequests } from "./read-requests.js";
test("simultaneous identical reads share work, but reads after a write do not", async () => {
  const reads = createReadRequests();
  let calls = 0;
  let finish;
  const run = () => {
    calls++;
    return new Promise((r) => {
      finish = r;
    });
  };
  const first = reads.run("site", run);
  const joined = reads.run("site", run);
  assert.equal(first, joined);
  await Promise.resolve();
  const finishFirst = finish;
  reads.invalidate();
  const fresh = reads.run("site", run);
  await Promise.resolve();
  assert.notEqual(fresh, first);
  assert.equal(calls, 2);
  finishFirst("old");
  finish("new");
  assert.equal(await fresh, "new");
  assert.equal(await first, "old");
});
test("failed reads can be retried and different identities are never joined", async () => {
  const reads = createReadRequests();
  await assert.rejects(reads.run("a", () => Promise.reject(Error("offline"))));
  assert.deepEqual(
    await Promise.all([reads.run("a", () => 1), reads.run("b", () => 2)]),
    [1, 2],
  );
});
