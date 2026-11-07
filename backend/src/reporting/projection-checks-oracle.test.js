import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { buildCheckFacts } from "./activity.js";
import { createLocalViews, writeLocalLake } from "./local-lake.js";
import { buildProjection } from "./projection.js";
import { PROFILES, generateYear } from "./synthetic/generate.js";
import { readProjection } from "./test-build.js";

// The JavaScript Checks rule is the oracle until it's removed, so the SQL
// build must write the same Check rows from the same lake.
const DATASETS = [
  {
    name: "the small synthetic year",
    year: { seed: 7, sites: PROFILES.length, startDay: "2026-09-01" },
  },
  {
    name: "seed 14 with 30 Sites",
    year: { seed: 14, sites: 30, startDay: "2026-09-01" },
  },
];

describe.each(DATASETS)("SQL and JavaScript Checks on $name", ({ year }) => {
  /** @type {any} */
  let conn;
  /** @type {string} */
  let dir;
  /** @type {Record<string, Record<string, any>[]>} */
  let tables;
  /** @type {Record<string, any>[]} */
  let lakeChecks;
  /** @type {string} */
  let evaluatedAt;

  beforeAll(async () => {
    const generated = generateYear(year);
    evaluatedAt = generated.evaluatedAt;
    conn = await (await DuckDBInstance.create(":memory:")).connect();
    await conn.run("SET memory_limit = '1GB'");
    dir = mkdtempSync(join(tmpdir(), "insights-checks-oracle-"));
    await writeLocalLake(conn, join(dir, "lake"), generated.items, {
      exportedAt: evaluatedAt,
      exportId: "gen",
    });
    await createLocalViews(conn, join(dir, "lake"));
    await buildProjection(conn, join(dir, "sql"), {
      evaluatedAt,
      snapshotId: "gen",
    });
    tables = await readProjection(conn, join(dir, "sql"));
    lakeChecks = (
      await conn.runAndReadAll(
        `SELECT siteId, checkId, status, raw->>'$.flowType' AS flowType,
          startedAt, completedAt, synthesizedAt FROM checks`,
      )
    ).getRowObjectsJS();
  });

  afterAll(() => {
    conn.closeSync();
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes identical checks rows, in order", () => {
    const js = buildCheckFacts(
      {
        checks: /** @type {any[]} */ (lakeChecks),
        issues: /** @type {any[]} */ (tables.issues),
      },
      evaluatedAt,
    ).checks;
    expect(js.length).toBeGreaterThan(0);
    expect(tables.checks).toEqual(js);
  });
});
