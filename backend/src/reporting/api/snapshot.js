// Reads lake projection files only, never DynamoDB, so Insights traffic can't slow the field app.

import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { DuckDBInstance } from "@duckdb/node-api";
import { sqlString } from "../../analytics/convert.js";
import { CONTRACT_VERSION } from "../contract.js";
import { TABLE_SCHEMAS } from "../projection.js";
import { requestError } from "./requests.js";

/**
 * @typedef {object} Snapshot
 * @property {string} prefix where its files live; jobs reload it by this
 * @property {string} snapshotId
 * @property {Record<string, any>} manifest
 * @property {Record<string, Record<string, any>[]>} tables
 * @property {Map<string, Record<string, any>>} sitesById
 * @property {Map<string, Record<string, any>>} contactsBySite
 * @property {Map<string, Record<string, any>[]>} issuesById
 * @property {Map<string, Record<string, any>[]>} checksById
 * @property {Map<string, Record<string, any>[]>} daysBySite each Site's site_days by day, for range reads
 * @property {Map<string, Record<string, any>[]>} issuesBySite
 * @property {string | null} coverageStart earliest day with any record
 * @property {string[]} categories each Issue category in the data, sorted
 */

/**
 * @typedef {object} SnapshotSource
 * @property {() => Promise<{ prefix: string, snapshotId: string } | null>} latest
 * @property {(prefix: string) => Promise<{ prefix: string, manifest: Record<string, any>, tables: Record<string, Record<string, any>[]> }>} load
 */

/**
 * @param {Record<string, any>[]} rows
 * @param {string} field
 * @returns {Map<string, Record<string, any>[]>}
 */
function groupBy(rows, field) {
  /** @type {Map<string, Record<string, any>[]>} */
  const map = new Map();
  for (const row of rows) {
    const list = map.get(row[field]);
    if (list) list.push(row);
    else map.set(row[field], [row]);
  }
  return map;
}

/**
 * @param {{ prefix: string, manifest: Record<string, any>, tables: Record<string, Record<string, any>[]> }} loaded
 * @returns {Snapshot}
 */
export function indexSnapshot({ prefix, manifest, tables }) {
  let coverageStart = null;
  for (const name of ["site_days", "checks"])
    for (const row of tables[name] ?? [])
      if (coverageStart === null || row.day < coverageStart)
        coverageStart = row.day;
  for (const row of tables.issues ?? [])
    if (coverageStart === null || row.createdDay < coverageStart)
      coverageStart = row.createdDay;
  return {
    prefix,
    snapshotId: String(manifest.snapshotId),
    manifest,
    tables,
    sitesById: new Map(tables.sites.map((s) => [s.siteId, s])),
    contactsBySite: new Map(tables.site_contacts.map((c) => [c.siteId, c])),
    issuesById: groupBy(tables.issues, "issueId"),
    checksById: groupBy(tables.checks, "checkId"),
    // Grouped once, so a report reads each Site's rows, not the whole table per Site.
    daysBySite: new Map(
      [...groupBy(tables.site_days, "siteId")].map(([siteId, rows]) => [
        siteId,
        rows.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0)),
      ]),
    ),
    issuesBySite: groupBy(tables.issues, "siteId"),
    coverageStart,
    categories: [
      ...new Set((tables.issues ?? []).map((i) => i.category).filter(Boolean)),
    ].sort((a, b) => a.localeCompare(b)),
  };
}

// Checked first: another contract's columns would fail in DuckDB unexplained, not as this 503.
/** @param {Record<string, any>} manifest */
function checkContract(manifest) {
  if (manifest.contractVersion !== CONTRACT_VERSION)
    throw requestError("snapshot_contract_mismatch", 503);
}

/**
 * @param {(name: string) => string} pathOf local path of each table file
 * @returns {Promise<Record<string, Record<string, any>[]>>}
 */
async function readTables(pathOf) {
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  try {
    /** @type {Record<string, Record<string, any>[]>} */
    const tables = {};
    for (const [name, schema] of Object.entries(TABLE_SCHEMAS)) {
      const columns = Object.entries(schema)
        .map(([column, type]) =>
          type === "DATE" ? `CAST(${column} AS VARCHAR) AS ${column}` : column,
        )
        .join(", ");
      const reader = await conn.runAndReadAll(
        `SELECT ${columns} FROM read_parquet(${sqlString(pathOf(name))})`,
      );
      tables[name] = reader.getRowObjectsJS();
    }
    return tables;
  } finally {
    conn.closeSync();
    instance.closeSync();
  }
}

/**
 * @param {string} dir
 * @returns {SnapshotSource}
 */
export function dirSource(dir) {
  return {
    async latest() {
      if (!existsSync(join(dir, "manifest.json"))) return null;
      const manifest = JSON.parse(
        await readFile(join(dir, "manifest.json"), "utf8"),
      );
      return { prefix: dir, snapshotId: String(manifest.snapshotId) };
    },
    async load(prefix) {
      const manifest = JSON.parse(
        await readFile(join(prefix, "manifest.json"), "utf8"),
      );
      checkContract(manifest);
      const tables = await readTables((name) =>
        join(prefix, `${name}.parquet`),
      );
      return { prefix, manifest, tables };
    },
  };
}

// Found through `projections/latest.json`, which the build writes last.
/**
 * @param {{ s3: { send: (cmd: any) => Promise<any> }, bucket: string }} opts
 * @returns {SnapshotSource}
 */
export function s3Source({ s3, bucket }) {
  /** @param {string} key */
  const read = async (key) => {
    const res = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );
    return Buffer.from(await res.Body.transformToByteArray());
  };
  return {
    async latest() {
      try {
        const pointer = JSON.parse(
          (await read("projections/latest.json")).toString("utf8"),
        );
        return {
          prefix: String(pointer.prefix),
          snapshotId: String(pointer.snapshotId),
        };
      } catch (err) {
        if (/** @type {any} */ (err)?.name === "NoSuchKey") return null;
        throw err;
      }
    },
    async load(prefix) {
      const manifest = JSON.parse(
        (await read(`${prefix}/manifest.json`)).toString("utf8"),
      );
      checkContract(manifest);
      // DuckDB reads local files without the httpfs extension or a secret.
      const dir = await mkdtemp(join(tmpdir(), "insights-snapshot-"));
      try {
        // Settle every write before cleanup, so rm can't race a late one.
        const writes = await Promise.allSettled(
          Object.keys(TABLE_SCHEMAS).map(async (name) =>
            writeFile(
              join(dir, `${name}.parquet`),
              await read(`${prefix}/${name}.parquet`),
            ),
          ),
        );
        const failed = writes.find((w) => w.status === "rejected");
        if (failed) throw /** @type {PromiseRejectedResult} */ (failed).reason;
        const tables = await readTables((name) => join(dir, `${name}.parquet`));
        return { prefix, manifest, tables };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}

// Requests keep the held snapshot while a newer one loads, so only the first load waits.
/** @param {{ source: SnapshotSource, now?: () => number, refreshMs?: number, onError?: (err: unknown) => void }} opts */
export function createSnapshotStore({
  source,
  now = Date.now,
  refreshMs = 5 * 60_000,
  onError = () => {},
}) {
  /** @type {Snapshot | null} */
  let held = null;
  let checkedAt = -Infinity;
  /** @type {Promise<Snapshot> | null} */
  let pending = null;
  // Jobs queued before a swap read the snapshot they were asked against.
  /** @type {Promise<Snapshot> | null} */
  let older = null;
  let olderPrefix = "";

  /** @param {string} prefix */
  const load = async (prefix) => {
    const loaded = await source.load(prefix);
    // The built-in sources check first; this covers any other source.
    checkContract(loaded.manifest);
    return indexSnapshot(loaded);
  };

  const refresh = async () => {
    try {
      const latest = await source.latest();
      if (!latest) throw requestError("snapshot_unavailable", 503);
      // A local folder keeps its path when rebuilt, so compare IDs too.
      if (
        !held ||
        held.prefix !== latest.prefix ||
        held.snapshotId !== latest.snapshotId
      ) {
        // Dropped: two indexed snapshots would double the Lambda's memory. A job
        // on it reloads it once.
        held = await load(latest.prefix);
      }
      checkedAt = now();
      return held;
    } catch (err) {
      if (held) {
        // Stale data still serves, but someone needs to hear about it.
        onError(err);
        checkedAt = now();
        return held;
      }
      throw err;
    }
  };

  return {
    /** @returns {Promise<Snapshot>} */
    current() {
      if (held && now() - checkedAt <= refreshMs) return Promise.resolve(held);
      pending ??= refresh().finally(() => {
        pending = null;
      });
      // With a snapshot held, refresh never rejects, so nothing goes unhandled.
      return held ? Promise.resolve(held) : pending;
    },
    /**
     * @param {string} prefix
     * @returns {Promise<Snapshot>}
     */
    async byPrefix(prefix) {
      if (held?.prefix === prefix) return held;
      if (olderPrefix !== prefix) {
        olderPrefix = prefix;
        older = load(prefix);
        older.catch(() => {
          if (olderPrefix === prefix) olderPrefix = "";
        });
      }
      return /** @type {Promise<Snapshot>} */ (older);
    },
  };
}
