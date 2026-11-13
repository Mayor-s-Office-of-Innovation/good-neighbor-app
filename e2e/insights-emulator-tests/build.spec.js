import { buildFromLakeFiles, expect, test } from "./lake.js";

test("the real build reads a lake in S3 and publishes a snapshot readers can load", async () => {
  // A cold cache first downloads DuckDB's httpfs and aws extensions.
  test.setTimeout(180_000);
  const { manifest, tables } = await buildFromLakeFiles();
  expect(manifest.rowCounts).toMatchObject({ sites: 1, checks: 1 });
  expect(tables.sites.map((/** @type {any} */ s) => s.siteId)).toEqual(["s1"]);
  expect(tables.checks.map((/** @type {any} */ c) => c.checkId)).toEqual([
    "c1",
  ]);
});
