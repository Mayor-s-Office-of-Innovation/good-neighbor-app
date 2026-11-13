import { test } from "vitest";
import assert from "node:assert/strict";
import { LatestLoad, superseded } from "./latest-load.js";

test("a new load aborts the one before and marks it no longer current", () => {
  const loads = new LatestLoad();
  const first = loads.start();
  const second = loads.start();
  assert.equal(first.signal.aborted, true);
  assert.equal(first.current(), false);
  assert.equal(second.signal.aborted, false);
  assert.equal(second.current(), true);
  assert.equal(loads.signal, second.signal);
});

test("leaving the page aborts the load in flight", () => {
  const loads = new LatestLoad();
  const { signal } = loads.start();
  loads.abort();
  assert.equal(signal.aborted, true);
});

test("only the latest load's real failure is shown", () => {
  const loads = new LatestLoad();
  const old = loads.start();
  const latest = loads.start();
  const failed = new Error("snapshot_unavailable");
  const aborted = Object.assign(new Error("aborted"), { name: "AbortError" });
  assert.deepEqual(
    [
      superseded(failed, old.current),
      superseded(aborted, latest.current),
      superseded(failed, latest.current),
    ],
    [true, true, false],
  );
});
