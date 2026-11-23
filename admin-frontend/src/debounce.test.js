// @vitest-environment node
import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { debounce } from "./debounce.js";

test("search waits for a 300 ms pause after the latest input", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let calls = 0;
  const search = debounce(() => calls++, 300);
  search.schedule();
  vi.advanceTimersByTime(200);
  search.schedule();
  vi.advanceTimersByTime(299);
  assert.equal(calls, 0);
  vi.advanceTimersByTime(1);
  assert.equal(calls, 1);
  vi.advanceTimersByTime(1000);
  assert.equal(calls, 1);
});

test("navigation or immediate submission cancels a pending search", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let calls = 0;
  const search = debounce(() => calls++, 300);
  search.schedule();
  search.cancel();
  vi.advanceTimersByTime(300);
  assert.equal(calls, 0);
  search.schedule();
  vi.advanceTimersByTime(300);
  assert.equal(calls, 1);
});
