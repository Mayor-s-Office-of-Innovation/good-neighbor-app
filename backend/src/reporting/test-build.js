// Builds a projection from rows in memory and reads its files back, so rule
// tests check the rows a reader gets.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { sqlString } from "../analytics/convert.js";
import { TABLE_SCHEMAS, buildProjection } from "./projection.js";

/**
 * @param {any} conn
 * @param {string} dir
 * @returns {Promise<Record<string, Record<string, any>[]>>}
 */
export async function readProjection(conn, dir) {
  /** @type {Record<string, Record<string, any>[]>} */
  const tables = {};
  for (const [name, schema] of Object.entries(TABLE_SCHEMAS)) {
    // Days read back as their YYYY-MM-DD text, as a page shows them.
    const columns = Object.entries(schema)
      .map(([column, type]) =>
        type === "DATE"
          ? `CAST("${column}" AS VARCHAR) AS "${column}"`
          : `"${column}"`,
      )
      .join(", ");
    const reader = await conn.runAndReadAll(
      `SELECT ${columns} FROM ${sqlString(join(dir, `${name}.parquet`))}`,
    );
    tables[name] = reader.getRowObjectsJS();
  }
  return tables;
}

/**
 * @param {import("./projection.js").ProjectionInputs} inputs
 * @param {string} evaluatedAt
 * @returns {Promise<{ tables: Record<string, Record<string, any>[]>, manifest: Record<string, any> }>}
 */
export async function buildFromRows(inputs, evaluatedAt) {
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  const dir = await mkdtemp(join(tmpdir(), "insights-rules-"));
  try {
    await conn.run("SET memory_limit = '1GB'");
    const out = join(dir, "projection");
    await buildProjection(conn, out, {
      evaluatedAt,
      snapshotId: "test",
      inputs,
    });
    return {
      tables: await readProjection(conn, out),
      manifest: JSON.parse(await readFile(join(out, "manifest.json"), "utf8")),
    };
  } finally {
    conn.closeSync();
    instance.closeSync();
    await rm(dir, { recursive: true, force: true });
  }
}
