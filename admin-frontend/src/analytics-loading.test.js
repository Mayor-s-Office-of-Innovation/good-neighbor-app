import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
const source = readFileSync(new URL("./analytics.js", import.meta.url), "utf8");
function fixture(api) {
  const methods = ["run", "runAdvanced", "select"]
    .map((name) => {
      const start = source.indexOf(`  async ${name}(`);
      return source.slice(start, source.indexOf("\n  }", start) + 4);
    })
    .join("\n");
  const Subject = vm.runInNewContext(`(class { ${methods} })`, {
    adminApi: api,
    AbortController,
    errorMessage: (e) => e.message,
    defaultParams: () => ({}),
  });
  const app = new Subject();
  app.render = () => {};
  app.state = {
    catalog: [
      { id: "a", title: "A", sql: "select a", params: [] },
      { id: "b", title: "B", sql: "select b", params: [] },
    ],
    selectedId: "a",
    params: {},
  };
  return app;
}
test("obsolete Analytics results cannot replace the newest query, even if cancellation is ignored", async () => {
  const pending = [];
  const app = fixture({
    analyticsRun: (id, params, signal) =>
      new Promise((resolve) => pending.push({ id, signal, resolve })),
  });
  const first = app.run();
  app.state.selectedId = "b";
  const second = app.run();
  assert.equal(pending[0].signal.aborted, true);
  pending[1].resolve({ rows: ["new"] });
  await second;
  pending[0].resolve({ rows: ["old"] });
  await first;
  assert.deepEqual(app.state.result.rows, ["new"]);
  assert.equal(app.state.resultTitle, "B");
  assert.equal(app.state.busy, false);
});
test("recent identical Analytics selections reuse a result but explicit Run refreshes it", async () => {
  let reads = 0;
  const app = fixture({
    analyticsRun: async () => {
      reads++;
      return { rows: [reads] };
    },
  });
  await app.run();
  await app.run(true);
  assert.equal(reads, 1);
  await app.run();
  assert.equal(reads, 2);
  assert.deepEqual(app.state.result.rows, [2]);
});
test("an advanced query supersedes a pending catalog query", async () => {
  let complete;
  const app = fixture({
    analyticsRun: () =>
      new Promise((r) => {
        complete = r;
      }),
    analyticsQuery: async () => ({ rows: ["custom"] }),
  });
  const pending = app.run();
  await app.runAdvanced("select 1");
  complete({ rows: ["old"] });
  await pending;
  assert.deepEqual(app.state.result.rows, ["custom"]);
});
