import assert from "node:assert/strict";
import test from "node:test";
import { debounce } from "./debounce.js";

test("search waits for a 300 ms pause after the latest input", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const search = debounce(() => calls++, 300);
  search.schedule();
  t.mock.timers.tick(200);
  search.schedule();
  t.mock.timers.tick(299);
  assert.equal(calls, 0);
  t.mock.timers.tick(1);
  assert.equal(calls, 1);
  t.mock.timers.tick(1000);
  assert.equal(calls, 1);
});

test("navigation or immediate submission cancels a pending search", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const search = debounce(() => calls++, 300);
  search.schedule();
  search.cancel();
  t.mock.timers.tick(300);
  assert.equal(calls, 0);
  search.schedule();
  t.mock.timers.tick(300);
  assert.equal(calls, 1);
});
