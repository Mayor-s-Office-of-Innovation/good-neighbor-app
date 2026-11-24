// Same layout, rows and views as the S3 lake, so local reads match the Lambdas'.

import { existsSync, readdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { classifyItem } from "../analytics/entity-keys.js";
import { toRow, writeEntityParquet } from "../analytics/convert.js";
import {
  ENTITIES,
  emptyViewSql,
  lakeViewSql,
} from "../analytics/lake-views.js";

/**
 * @param {any} conn DuckDB connection
 * @param {string} dir the local stand-in for s3://<lake>/readings
 * @param {Record<string, any>[]} items unmarshalled table items
 * @param {{ exportedAt: string, exportId: string }} opts
 * @returns {Promise<number>} rows written
 */
export async function writeLocalLake(
  conn,
  dir,
  items,
  { exportedAt, exportId },
) {
  /** @type {Map<string, Record<string, unknown>[]>} */
  const byPartition = new Map();
  for (const item of items) {
    const entity = classifyItem(item);
    if (!entity) continue;
    const row = toRow(entity, item, exportedAt);
    const k = `${entity}|${row.date ?? "unknown"}`;
    const rows = byPartition.get(k);
    if (rows) rows.push(row);
    else byPartition.set(k, [row]);
  }
  let count = 0;
  for (const [k, rows] of byPartition) {
    const [entity, date] = k.split("|");
    const partition = join(dir, entity, `date=${date}`);
    await mkdir(partition, { recursive: true });
    await writeEntityParquet(
      conn,
      entity,
      rows,
      join(partition, `part-${exportId}.parquet`),
    );
    count += rows.length;
  }
  return count;
}

/**
 * @param {any} conn
 * @param {string} dir
 * @returns {Promise<void>}
 */
export async function createLocalViews(conn, dir) {
  for (const entity of ENTITIES) {
    // read_parquet fails on a glob that matches nothing, so check first.
    const entityDir = join(dir, entity);
    const hasFiles =
      existsSync(entityDir) &&
      readdirSync(entityDir, { withFileTypes: true }).some(
        (d) =>
          d.isDirectory() &&
          readdirSync(join(entityDir, d.name)).some((f) =>
            f.endsWith(".parquet"),
          ),
      );
    await conn.run(hasFiles ? lakeViewSql(dir, entity) : emptyViewSql(entity));
  }
}
