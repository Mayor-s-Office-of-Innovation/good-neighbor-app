// Reads lake projection files only, never DynamoDB, so Insights traffic can't slow the field app.

import { existsSync } from "node:fs";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate, setTimeout as sleep } from "node:timers/promises";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import {
  DuckDBInstance,
  JSDuckDBValueConverter,
  LIST,
  VARCHAR,
  listValue,
} from "@duckdb/node-api";
import { CONTRACT_VERSION, LATEST_PROJECTION_KEY } from "../contract.js";
import { TABLE_SCHEMAS } from "../projection.js";
import { CONCERN_RULES, siteNameRanks } from "./read-model.js";
import { OPEN_FACTS_SQL, SITE_RANK_INSERT, openSql } from "./read-sql.js";
import { requestError } from "./requests.js";

// Each download holds its whole file in memory, so only this many tables at once.
const DOWNLOADS_AT_ONCE = 2;

/**
 * @typedef {((sql: string, params?: Record<string, unknown>) => Promise<Record<string, any>[]>) & {
 *   each?: (sql: string, params: Record<string, unknown>, onRows: (rows: Record<string, any>[]) => void) => Promise<void>,
 * }} Query
 */

/**
 * @typedef {object} Snapshot
 * @property {string} prefix where its files live; jobs reload it by this
 * @property {string} snapshotId
 * @property {Record<string, any>} manifest
 * @property {Record<string, any>[]} sites in file order
 * @property {Map<string, Record<string, any>>} sitesById
 * @property {Map<string, Record<string, any>>} contactsBySite
 * @property {string | null} coverageStart earliest day with any record
 * @property {string[]} categories each Issue category in the data, sorted
 * @property {string[]} dataDays every day with a site_days row, ascending
 * @property {<T>(read: (query: Query) => Promise<T>) => Promise<T>} hold runs `read` with queries over the snapshot's files, which stay until it ends
 */

/** @typedef {{ prefix: string, manifest: Record<string, any>, dir: string, cleanup: () => Promise<void> }} LoadedSnapshot */

/**
 * @typedef {object} SnapshotSource
 * @property {() => Promise<{ prefix: string, snapshotId: string } | null>} latest
 * @property {(prefix: string) => Promise<LoadedSnapshot>} load copies the files to a folder of the snapshot's own
 */

/** @type {Promise<DuckDBInstance> | null} */
let instance = null;

// One per process. One thread and 1 GiB keep a query's buffers well inside the Lambda's 2,048 MiB.
const reader = () =>
  (instance ??= DuckDBInstance.create(":memory:", {
    threads: "1",
    memory_limit: "1GiB",
    parquet_metadata_cache: "true",
    // A query past the limit spills here; the default sits under Lambda's read-only /var/task.
    // Per process, since two test workers sharing one folder could clash on its files.
    temp_directory: join(tmpdir(), `insights-spill-${process.pid}`),
  }).catch((err) => {
    // Forgotten, so the next request tries again rather than fail for the sandbox's life.
    instance = null;
    throw err;
  }));

let opened = 0;

/**
 * @param {Record<string, unknown> | undefined} params
 * @returns {[Record<string, any> | undefined, Record<string, any> | undefined]}
 */
function bind(params) {
  if (!params) return [undefined, undefined];
  /** @type {Record<string, unknown>} */
  const values = {};
  /** @type {Record<string, any>} */
  const types = {};
  for (const [name, value] of Object.entries(params)) {
    // Lists go as text, typed, since an empty list has no type to infer; the SQL casts them.
    if (Array.isArray(value)) {
      values[name] = listValue(
        value.map((v) => (v === null ? null : String(v))),
      );
      types[name] = LIST(VARCHAR);
    } else values[name] = value === undefined ? null : value;
  }
  return [values, types];
}

/**
 * @param {any} conn
 * @returns {Query}
 */
function queryOn(conn) {
  /** @type {Query} */
  const query = async (sql, params) =>
    (await conn.runAndReadAll(sql, ...bind(params))).getRowObjectsJS();
  // A chunk at a time, so a large export never holds all its rows twice.
  query.each = async (sql, params, onRows) => {
    const result = await conn.stream(sql, ...bind(params));
    /** @type {string[]} */
    const names = result.columnNames();
    for (
      let chunk = await result.fetchChunk();
      chunk?.rowCount;
      chunk = await result.fetchChunk()
    )
      onRows(
        chunk
          .convertRows(JSDuckDBValueConverter)
          .map((/** @type {unknown[]} */ row) =>
            Object.fromEntries(names.map((n, i) => [n, row[i]])),
          ),
      );
  };
  return query;
}

/**
 * Opens a loaded snapshot's files as views, and reads what every reply needs
 * into memory: the Sites, their contacts and the snapshot's day range.
 * @param {LoadedSnapshot} loaded
 * @param {{ onError?: (err: unknown) => void }} [opts]
 * @returns {Promise<Snapshot & { release: () => void, adopt: () => void, closing: boolean, disposed: Promise<void> }>}
 */
export async function openSnapshot(
  { prefix, manifest, dir, cleanup },
  { onError = () => {} } = {},
) {
  const db = await reader();
  const schema = `insights_${(opened += 1)}`;
  const conn = await db.connect();
  try {
    for (const sql of openSql({
      schema,
      pathOf: (table) => join(dir, `${table}.parquet`),
      evaluatedAt: manifest.evaluatedAt,
      unresolvedDays: CONCERN_RULES.unresolvedDays,
    }))
      await conn.run(sql);
    const query = queryOn(conn);
    const sites = await query(OPEN_FACTS_SQL.sites);
    const contacts = await query(OPEN_FACTS_SQL.contacts);
    const ranks = siteNameRanks(sites);
    if (sites.length)
      await query(SITE_RANK_INSERT, {
        ids: sites.map((s) => s.siteId),
        ranks: sites.map((s) => ranks.get(s.siteId) ?? null),
      });
    const [{ coverageStart }] = await query(OPEN_FACTS_SQL.coverageStart);
    const categories = (await query(OPEN_FACTS_SQL.categories))
      .map((r) => String(r.category))
      .sort((a, b) => a.localeCompare(b));
    const dataDays = (await query(OPEN_FACTS_SQL.dataDays)).map((r) =>
      String(r.day),
    );

    let holds = 0;
    let released = false;
    /** @type {() => void} */
    let done = () => {};
    /** @type {Promise<void>} */
    const disposed = new Promise((resolve) => {
      done = resolve;
    });
    let disposing = false;
    // Deferred a turn, so a caller handed this snapshot can start its read first.
    const disposeIfIdle = async () => {
      await setImmediate();
      if (disposing || !released || holds > 0) return;
      disposing = true;
      // Caught, since nothing awaits this and a rejection would end the process.
      try {
        const drop = await db.connect();
        try {
          await drop.run(`DROP SCHEMA ${schema} CASCADE`);
        } finally {
          drop.closeSync();
        }
      } catch (err) {
        onError(err);
      } finally {
        await cleanup().catch(onError);
        done();
      }
    };
    return {
      prefix,
      snapshotId: String(manifest.snapshotId),
      manifest,
      sites,
      sitesById: new Map(sites.map((s) => [s.siteId, s])),
      contactsBySite: new Map(contacts.map((c) => [c.siteId, c])),
      coverageStart: coverageStart ?? null,
      categories,
      dataDays,
      // A read holds its snapshot, so a refresh landing mid-read can't delete its files.
      async hold(read) {
        holds += 1;
        try {
          const own = await db.connect();
          try {
            await own.run(`USE ${schema}`);
            return await read(queryOn(own));
          } finally {
            own.closeSync();
          }
        } finally {
          holds -= 1;
          if (released && !holds) disposeIfIdle();
        }
      },
      release() {
        released = true;
        disposeIfIdle();
      },
      adopt() {
        released = false;
      },
      get closing() {
        return disposing;
      },
      disposed,
    };
  } catch (err) {
    await conn.run(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    throw err;
  } finally {
    conn.closeSync();
  }
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

/** @param {string} dir */
const removeDir = (dir) => () => rm(dir, { recursive: true, force: true });

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
      // Copied, since a rebuild swaps the folder in place under any open views.
      const copy = await mkdtemp(join(tmpdir(), "insights-snapshot-"));
      try {
        for (const name of [...Object.keys(TABLE_SCHEMAS), "manifest"]) {
          const file =
            name === "manifest" ? "manifest.json" : `${name}.parquet`;
          await copyFile(join(prefix, file), join(copy, file));
        }
        const copied = JSON.parse(
          await readFile(join(copy, "manifest.json"), "utf8"),
        );
        // A rebuild mid-copy would mix two snapshots' files.
        if (String(copied.snapshotId) !== String(manifest.snapshotId))
          throw requestError("snapshot_changed", 503);
        return {
          prefix,
          manifest: copied,
          dir: copy,
          cleanup: removeDir(copy),
        };
      } catch (err) {
        await rm(copy, { recursive: true, force: true });
        throw err;
      }
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
      // Settle every write before cleanup, so rm can't race a late one.
      const writes = await Promise.allSettled(
        Array.from({ length: DOWNLOADS_AT_ONCE }, download),
      );
      const failed = writes.find((w) => w.status === "rejected");
      if (failed) {
        await rm(dir, { recursive: true, force: true });
        throw /** @type {PromiseRejectedResult} */ (failed).reason;
      }
      return { prefix, manifest, dir, cleanup: removeDir(dir) };
    },
  };
}

// A stale request gets the held snapshot while a newer one loads. Lambda freezes
// once it replies, which would stall that load, so set refreshWaitMs there.
/** @param {{ source: SnapshotSource, now?: () => number, refreshMs?: number, refreshWaitMs?: number, firstLoadWaitMs?: number, wait?: (ms: number, signal: AbortSignal) => Promise<unknown>, onError?: (err: unknown) => void, onLoad?: (load: { snapshotId: string, ms: number }) => void }} opts */
export function createSnapshotStore({
  source,
  now = Date.now,
  refreshMs = 5 * 60_000,
  refreshWaitMs = 0,
  firstLoadWaitMs = 0,
  wait = (ms, signal) => sleep(ms, undefined, { signal }),
  onError = () => {},
  onLoad = () => {},
}) {
  /** @typedef {Awaited<ReturnType<typeof openSnapshot>>} Opened */
  /** @type {Opened | null} */
  let held = null;
  // When the refresh that confirmed `held` read latest.json.
  let checkedAt = -Infinity;
  // One refresh at a time. A refresh is never abandoned: S3 timeouts end a hung read.
  /** @type {{ run: Promise<Snapshot>, startedAt: number } | null} */
  let inflight = null;
  /** @type {Promise<Snapshot> | null} */
  let queued = null;
  /** @type {Map<string, Promise<Opened>>} */
  const loading = new Map();
  // Every snapshot open now, so a second ask for one reuses it rather than load a copy.
  /** @type {Map<string, Opened>} */
  const open = new Map();
  // Jobs queued before a swap read the snapshot they were asked against.
  /** @type {Promise<Opened> | null} */
  let older = null;
  let olderKey = "";
  /** @type {Opened | null} */
  let olderSnap = null;
  // The snapshot latest.json named when a load found its files expired.
  /** @type {{ key: string, err: unknown } | null} */
  let expired = null;
  let closed = false;

  // Let a snapshot go once neither the held nor the older slot keeps it; it
  // waits for its last read to end.
  /** @param {Opened | null} snap */
  const letGo = (snap) => {
    if (snap && snap !== held && snap !== olderSnap) snap.release();
  };

  // Shared, since two copies of one snapshot would double the Lambda's memory. The ID is in
  // the key because a rebuilt local folder keeps its path.
  /**
   * @param {string} prefix
   * @param {string} snapshotId
   * @returns {Promise<Opened>}
   */
  const load = (prefix, snapshotId) => {
    const key = JSON.stringify([prefix, snapshotId]);
    const reuse = open.get(key);
    if (reuse && !reuse.closing) {
      reuse.adopt();
      return Promise.resolve(reuse);
    }
    let run = loading.get(key);
    if (!run) {
      run = (async () => {
        const loaded = await source.load(prefix);
        try {
          // The built-in sources check first; this covers any other source.
          checkContract(loaded.manifest);
          // A rebuilt local folder keeps its path, so a job could read another snapshot's numbers.
          if (String(loaded.manifest.snapshotId) !== snapshotId)
            throw requestError("snapshot_changed", 503);
          const snap = await openSnapshot(loaded, { onError });
          open.set(key, snap);
          snap.disposed.then(() => {
            if (open.get(key) === snap) open.delete(key);
          });
          // One that lands after close() lets its copy go once its reads end.
          if (closed) snap.release();
          return snap;
        } catch (err) {
          await loaded.cleanup();
          throw err;
        }
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
        // Marked, since before the first build every request would log it.
        const gone = Object.assign(requestError("snapshot_unavailable", 503), {
          missing: true,
        });
        // Dropped so a warm Lambda answers like a cold one, not with old numbers.
        if (held) onError(gone);
        const dropped = held;
        held = null;
        letGo(dropped);
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
          // The old one isn't kept once its reads end. A job on it reloads it once.
          const loadStart = now();
          const next = await load(latest.prefix, latest.snapshotId);
          onLoad({ snapshotId: next.snapshotId, ms: now() - loadStart });
          const dropped = held;
          held = next;
          letGo(dropped);
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

  /** @type {WeakSet<Promise<Snapshot>>} */
  const watched = new WeakSet();
  // A waiter that gave up can't log how the load ends, and held is still null.
  /** @param {Promise<Snapshot>} run */
  const logLateFailure = (run) => {
    if (watched.has(run)) return;
    watched.add(run);
    run.catch((err) => {
      if (!(/** @type {any} */ (err)?.missing) && !isExpired(err)) onError(err);
    });
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
          logLateFailure(run);
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
        const run = load(prefix, snapshotId);
        older = run;
        run.then(
          (snap) => {
            if (older !== run) return letGo(snap);
            const dropped = olderSnap;
            olderSnap = snap;
            letGo(dropped);
          },
          () => {
            if (olderKey === key) olderKey = "";
          },
        );
      }
      return /** @type {Promise<Snapshot>} */ (older);
    },
    // For tests and scripts: a Lambda never closes, but a process that ends leaves the copies behind.
    async close() {
      closed = true;
      held = null;
      olderSnap = null;
      older = null;
      olderKey = "";
      const snaps = [...open.values()];
      for (const snap of snaps) snap.release();
      await Promise.all(snaps.map((snap) => snap.disposed));
    },
  };
}
