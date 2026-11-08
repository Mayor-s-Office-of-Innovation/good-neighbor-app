// Reads lake projection files only, never DynamoDB, so Insights traffic can't slow the field app.

import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { DuckDBInstance } from "@duckdb/node-api";
import { sqlString } from "../../analytics/convert.js";
import { pacificDateKey } from "../../lib/pacific-dates.js";
import { CONTRACT_VERSION, LATEST_PROJECTION_KEY } from "../contract.js";
import { TABLE_SCHEMAS } from "../projection.js";
import { requestError } from "./requests.js";

// Each download holds its whole file in memory, so only this many tables at once.
const DOWNLOADS_AT_ONCE = 2;

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
 * @property {Map<string, Record<string, any>[]>} owedBySite each Site's checks_owed by day
 * @property {Map<string, Record<string, any>[]>} issuesBySite
 * @property {string | null} coverageStart earliest day with any record
 * @property {string[]} categories each Issue category in the data, sorted
 * @property {string[]} dataDays every day with a site_days row, ascending
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
 * @param {Record<string, any>} site
 * @returns {string}
 */
export function addedDay(site) {
  // A createdAt that doesn't parse can't say when the Site began.
  return site.createdAt ? pacificDateKey(site.createdAt) : "";
}

/**
 * @param {{ prefix: string, manifest: Record<string, any>, tables: Record<string, Record<string, any>[]> }} loaded
 * @returns {Snapshot}
 */
export function indexSnapshot({ prefix, manifest, tables: all }) {
  /** @param {Record<string, any>[]} rows */
  const byDay = (rows) =>
    rows.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  let coverageStart = null;
  for (const name of ["site_days", "checks"])
    for (const row of all[name] ?? [])
      if (coverageStart === null || row.day < coverageStart)
        coverageStart = row.day;
  for (const row of all.issues ?? [])
    if (coverageStart === null || row.createdDay < coverageStart)
      coverageStart = row.createdDay;
  // Dropped once here, so every total, comparison and list counts the same days.
  const added = new Map(all.sites.map((s) => [s.siteId, addedDay(s)]));
  /** @param {Record<string, any>[] | undefined} rows @param {string} field */
  const sinceAdded = (rows, field) =>
    (rows ?? []).filter((r) => !(r[field] < (added.get(r.siteId) ?? "")));
  /** @type {Record<string, Record<string, any>[]>} */
  const tables = {
    ...all,
    site_days: sinceAdded(all.site_days, "day"),
    checks: sinceAdded(all.checks, "day"),
    issues: sinceAdded(all.issues, "createdDay"),
  };
  return {
    prefix,
    snapshotId: String(manifest.snapshotId),
    manifest,
    tables,
    sitesById: new Map(tables.sites.map((s) => [s.siteId, s])),
    contactsBySite: new Map(tables.site_contacts.map((c) => [c.siteId, c])),
    // From every row, so a record linked from elsewhere still opens.
    issuesById: groupBy(all.issues, "issueId"),
    checksById: groupBy(all.checks, "checkId"),
    // Grouped once, so a report reads each Site's rows, not the whole table per Site.
    daysBySite: new Map(
      [...groupBy(tables.site_days, "siteId")].map(([siteId, rows]) => [
        siteId,
        byDay(rows),
      ]),
    ),
    owedBySite: new Map(
      [...groupBy(tables.checks_owed ?? [], "siteId")].map(([siteId, rows]) => [
        siteId,
        byDay(rows),
      ]),
    ),
    issuesBySite: groupBy(tables.issues, "siteId"),
    coverageStart,
    categories: [
      ...new Set((tables.issues ?? []).map((i) => i.category).filter(Boolean)),
    ].sort((a, b) => a.localeCompare(b)),
    dataDays: [...new Set(tables.site_days.map((row) => row.day))].sort(),
  };
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
const isExpired = (err) =>
  Boolean(/** @type {{ expiredKey?: string } | null} */ (err)?.expiredKey);

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
  // Expiry can delete a snapshot's files a day before latest.json; that's "no data", not a fault.
  /** @param {string} key */
  const readSnapshotFile = (key) =>
    read(key).catch((err) => {
      if (err?.name === "NoSuchKey")
        throw Object.assign(requestError("snapshot_unavailable", 503), {
          message: `snapshot_unavailable: ${key} has expired`,
          expiredKey: key,
        });
      throw err;
    });
  return {
    async latest() {
      try {
        const pointer = JSON.parse(
          (await read(LATEST_PROJECTION_KEY)).toString("utf8"),
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
        (await readSnapshotFile(`${prefix}/manifest.json`)).toString("utf8"),
      );
      checkContract(manifest);
      // DuckDB reads local files without the httpfs extension or a secret.
      const dir = await mkdtemp(join(tmpdir(), "insights-snapshot-"));
      const queue = Object.keys(TABLE_SCHEMAS);
      const download = async () => {
        try {
          for (let name = queue.shift(); name; name = queue.shift())
            await writeFile(
              join(dir, `${name}.parquet`),
              await readSnapshotFile(`${prefix}/${name}.parquet`),
            );
        } catch (err) {
          // The load has failed, so the other download stops after its current file.
          queue.length = 0;
          throw err;
        }
      };
      try {
        // Settle every write before cleanup, so rm can't race a late one.
        const writes = await Promise.allSettled(
          Array.from({ length: DOWNLOADS_AT_ONCE }, download),
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

// A stale request gets the held snapshot while a newer one loads. Lambda freezes
// once it replies, which would stall that load, so set refreshWaitMs there.
/** @param {{ source: SnapshotSource, now?: () => number, refreshMs?: number, refreshWaitMs?: number, firstLoadWaitMs?: number, wait?: (ms: number, signal: AbortSignal) => Promise<unknown>, onError?: (err: unknown) => void }} opts */
export function createSnapshotStore({
  source,
  now = Date.now,
  refreshMs = 5 * 60_000,
  refreshWaitMs = 0,
  firstLoadWaitMs = 0,
  wait = (ms, signal) => sleep(ms, undefined, { signal }),
  onError = () => {},
}) {
  /** @type {Snapshot | null} */
  let held = null;
  // When the refresh that confirmed `held` read latest.json.
  let checkedAt = -Infinity;
  // One refresh at a time. A refresh is never abandoned: S3 timeouts end a hung read.
  /** @type {{ run: Promise<Snapshot>, startedAt: number } | null} */
  let inflight = null;
  /** @type {Promise<Snapshot> | null} */
  let queued = null;
  /** @type {Map<string, Promise<Snapshot>>} */
  const loading = new Map();
  // Jobs queued before a swap read the snapshot they were asked against.
  /** @type {Promise<Snapshot> | null} */
  let older = null;
  let olderKey = "";
  // The snapshot latest.json named when a load found its files expired.
  /** @type {{ key: string, err: unknown } | null} */
  let expired = null;

  // Shared, since two copies of one snapshot would double the Lambda's memory. The ID is in
  // the key because a rebuilt local folder keeps its path.
  /**
   * @param {string} prefix
   * @param {string} snapshotId
   */
  const load = (prefix, snapshotId) => {
    const key = JSON.stringify([prefix, snapshotId]);
    let run = loading.get(key);
    if (!run) {
      run = (async () => {
        const loaded = await source.load(prefix);
        // The built-in sources check first; this covers any other source.
        checkContract(loaded.manifest);
        // A rebuilt local folder keeps its path, so a job could read another snapshot's numbers.
        if (String(loaded.manifest.snapshotId) !== snapshotId)
          throw requestError("snapshot_changed", 503);
        return indexSnapshot(loaded);
      })();
      const clear = () => loading.delete(key);
      run.then(clear, clear);
      loading.set(key, run);
    }
    return run;
  };

  /** @param {number} startedAt */
  const refresh = async (startedAt) => {
    try {
      const latest = await source.latest();
      if (!latest) {
        const gone = requestError("snapshot_unavailable", 503);
        // Dropped so a warm Lambda answers like a cold one, not with old numbers.
        if (held) onError(gone);
        held = null;
        throw gone;
      }
      // Followed even back to an older snapshot, so a rollback lands and every
      // Lambda serves the same one. Refreshes run one at a time, so none lands late.
      if (
        !held ||
        held.prefix !== latest.prefix ||
        held.snapshotId !== latest.snapshotId
      ) {
        const key = JSON.stringify([latest.prefix, latest.snapshotId]);
        // Expired files stay gone, so answer at once rather than download the rest again.
        if (expired?.key === key) throw expired.err;
        try {
          // The old one isn't kept: two indexed snapshots would double the Lambda's
          // memory. A job on it reloads it once.
          held = await load(latest.prefix, latest.snapshotId);
        } catch (err) {
          // Logged once per snapshot, since parallel downloads can fail on a different file each time.
          if (isExpired(err)) {
            expired = { key, err };
            onError(err);
          }
          throw err;
        }
      }
      checkedAt = startedAt;
      return held;
    } catch (err) {
      // Stale data still serves, but someone needs to hear about it.
      if (held && !isExpired(err)) onError(err);
      if (held) {
        checkedAt = startedAt;
        return held;
      }
      throw err;
    }
  };

  const start = () => {
    const startedAt = now();
    const run = refresh(startedAt).finally(() => {
      inflight = null;
    });
    inflight = { run, startedAt };
    return run;
  };

  // A refresh that read latest.json too long before this request runs again after it.
  /** @param {number} asked */
  const refreshFor = (asked) => {
    if (!inflight) return start();
    if (asked - inflight.startedAt < refreshMs) return inflight.run;
    queued ??= inflight.run
      .catch(() => {})
      .then(() => {
        queued = null;
        return inflight ? inflight.run : start();
      });
    return queued;
  };

  /**
   * @template T
   * @param {Promise<Snapshot>} run
   * @param {number} ms
   * @param {() => T} late what the request gets if `run` takes longer
   * @returns {Promise<Snapshot | T>}
   */
  const waitFor = (run, ms, late) => {
    // Stops the timer once the refresh settles, so it doesn't outlive the request.
    const timer = new AbortController();
    const stop = () => timer.abort();
    run.then(stop, stop);
    return Promise.race([run, wait(ms, timer.signal).then(late)]);
  };

  return {
    /** @returns {Promise<Snapshot>} */
    current() {
      const asked = now();
      if (held && asked - checkedAt < refreshMs) return Promise.resolve(held);
      const run = refreshFor(asked);
      if (!held) {
        if (!firstLoadWaitMs) return run;
        // The load carries on, so a retry joins it rather than starting over.
        return waitFor(run, firstLoadWaitMs, () => {
          throw requestError("snapshot_unavailable", 503);
        });
      }
      const stale = held;
      // Rejects only when latest.json is gone; a caller answering stale can't see that.
      run.catch(() => {});
      if (!refreshWaitMs) return Promise.resolve(stale);
      return waitFor(run, refreshWaitMs, () => stale);
    },
    /**
     * @param {string} prefix
     * @param {string} snapshotId
     * @returns {Promise<Snapshot>}
     */
    async byPrefix(prefix, snapshotId) {
      if (held?.prefix === prefix && held.snapshotId === snapshotId)
        return held;
      const key = JSON.stringify([prefix, snapshotId]);
      if (olderKey !== key) {
        olderKey = key;
        older = load(prefix, snapshotId);
        older.catch(() => {
          if (olderKey === key) olderKey = "";
        });
      }
      return /** @type {Promise<Snapshot>} */ (older);
    },
  };
}
