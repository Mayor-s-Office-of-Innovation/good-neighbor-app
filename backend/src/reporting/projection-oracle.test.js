import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { sqlString } from "../analytics/convert.js";
import { createLocalViews, writeLocalLake } from "./local-lake.js";
import {
  buildProjection,
  buildSqlProjection,
  readLakeInputs,
  writeProjection,
} from "./projection.js";
import { PROFILES, generateYear } from "./synthetic/generate.js";

// The JavaScript build is the oracle until it's removed, so both builds must
// write the same files from the same lake.
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
const TABLES = ["site_days", "issues", "site_contacts", "sites"];

describe.each(DATASETS)("SQL and JavaScript builds on $name", ({ year }) => {
  /** @type {any} */
  let conn;
  /** @type {string} */
  let dir;

  beforeAll(async () => {
    const generated = generateYear(year);
    conn = await (await DuckDBInstance.create(":memory:")).connect();
    await conn.run("SET memory_limit = '1GB'");
    dir = mkdtempSync(join(tmpdir(), "insights-oracle-"));
    await writeLocalLake(conn, join(dir, "lake"), generated.items, {
      exportedAt: generated.evaluatedAt,
      exportId: "gen",
    });
    await createLocalViews(conn, join(dir, "lake"));
    const build = { evaluatedAt: generated.evaluatedAt, snapshotId: "gen" };
    await writeProjection(
      conn,
      buildProjection(await readLakeInputs(conn), build),
      join(dir, "js"),
    );
    await buildSqlProjection(conn, join(dir, "sql"), build);
  });

  afterAll(() => {
    conn.closeSync();
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * @param {string} build
   * @param {string} table
   */
  const read = async (build, table) => {
    const file = sqlString(join(dir, build, `${table}.parquet`));
    const types = await conn.runAndReadAll(`DESCRIBE SELECT * FROM ${file}`);
    const data = await conn.runAndReadAll(`SELECT * FROM ${file}`);
    return { types: types.getRowObjectsJS(), rows: data.getRowObjectsJS() };
  };

  it.each(TABLES)("writes identical %s rows, in order", async (table) => {
    const js = await read("js", table);
    const sql = await read("sql", table);
    expect(js.rows.length).toBeGreaterThan(0);
    expect(sql.types).toEqual(js.types);
    expect(sql.rows).toEqual(js.rows);
  });

  it("writes the same manifest", () => {
    const manifest = (/** @type {string} */ build) =>
      JSON.parse(readFileSync(join(dir, build, "manifest.json"), "utf8"));
    expect(manifest("sql")).toEqual(manifest("js"));
  });
});
