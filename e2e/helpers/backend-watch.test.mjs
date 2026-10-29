import { clearInterval, setInterval } from "node:timers";
import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { watchBackend } from "./backend-watch.mjs";

test("cleanup aborts the second in-flight probe and prevents a late failure signal", async (t) => {
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  let started,
    rejectProbe,
    signal,
    calls = 0,
    failures = 0;
  const secondStarted = new Promise((resolve) => {
    started = resolve;
  });
  const stop = watchBackend("http://test/health", {
    intervalMs: 1,
    fetchImpl: async (_url, options) => {
      if (++calls === 1) throw new Error("first miss");
      signal = options.signal;
      started();
      return new Promise((_resolve, reject) => {
        rejectProbe = reject;
      });
    },
    onFailure: () => failures++,
  });
  t.after(stop);
  await secondStarted;
  stop();
  assert.equal(signal.aborted, true);
  rejectProbe(new Error("late second miss"));
  await setImmediate();
  assert.equal(failures, 0);
  assert.equal(calls, 2);
});

test("two failed health responses stop the watcher and signal only once", async (t) => {
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  let failures = 0,
    done;
  const failed = new Promise((resolve) => {
    done = resolve;
  });
  const stop = watchBackend("http://test/health", {
    intervalMs: 1,
    fetchImpl: async () => new globalThis.Response(null, { status: 503 }),
    onFailure: () => {
      failures++;
      done();
    },
  });
  t.after(stop);
  await failed;
  await setImmediate();
  assert.equal(failures, 1);
});
