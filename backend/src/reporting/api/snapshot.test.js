import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { setImmediate } from "node:timers/promises";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { CONTRACT_VERSION } from "../contract.js";
import {
  createSnapshotStore,
  dirSource,
  indexSnapshot,
  s3Source,
} from "./snapshot.js";
import { overview } from "./read-model.js";
import { parseListQuery, parsePeriodParams } from "./requests.js";
import {
  syntheticProjection,
  writeSyntheticProjection,
} from "./test-projection.js";

/**
 * @param {Record<string, any>} [manifest]
 * @returns {any}
 */
function fakeSource(manifest = {}) {
  const projection = syntheticProjection();
  let latest = { prefix: "p1", snapshotId: "snap1" };
  return {
    loads: 0,
    /** @param {{ prefix: string, snapshotId: string }} next */
    publish(next) {
      latest = next;
    },
    async latest() {
      return latest;
    },
    /** @param {string} prefix */
    async load(prefix) {
      this.loads += 1;
      return {
        prefix,
        // The ID latest() names for this prefix, as a real build writes it.
        manifest: {
          ...projection.manifest,
          ...manifest,
          snapshotId: latest.prefix === prefix ? latest.snapshotId : prefix,
        },
        tables: projection.tables,
      };
    },
  };
}

describe("indexSnapshot", () => {
  it("finds Issues, Checks and Sites by ID", () => {
    const { manifest, tables } = syntheticProjection();
    const snap = indexSnapshot({ prefix: "p", manifest, tables });
    const issue = tables.issues[0];
    expect(snap.issuesById.get(issue.issueId)?.[0]).toBe(issue);
    expect(snap.checksById.get(tables.checks[0].checkId)?.[0]).toBe(
      tables.checks[0],
    );
    expect(snap.sitesById.get("s1")?.name).toBe("Synthetic Site 1");
  });

  it("gives the same Overview whatever order the projection's rows come in", () => {
    /** @param {boolean} reversed */
    const october = (reversed) => {
      const { manifest, tables } = syntheticProjection();
      if (reversed) for (const rows of Object.values(tables)) rows.reverse();
      const snap = indexSnapshot({ prefix: "p", manifest, tables });
      return overview(snap, {
        interval: parsePeriodParams(
          { period: "month", month: "2026-10" },
          manifest.evaluatedAt,
        ),
        filter: {},
        list: parseListQuery("sites", {}),
        now: Date.parse(manifest.evaluatedAt),
      });
    };
    expect(october(true)).toEqual(october(false));
  });

  it("counts a day once however many Sites have data on it, so launch week opens on the running month", () => {
    // Three Sites a day from Oct 26 to Nov 6: six days in each month.
    const { manifest, tables } = syntheticProjection();
    tables.site_days = ["s1", "s2", "s3"].flatMap((siteId) =>
      [26, 27, 28, 29, 30, 31, 1, 2, 3, 4, 5, 6].map((d) => ({
        ...tables.site_days[0],
        siteId,
        day: d > 20 ? `2026-10-${d}` : `2026-11-0${d}`,
      })),
    );
    const snap = indexSnapshot({ prefix: "p", manifest, tables });
    expect(
      parsePeriodParams({}, "2026-11-06T19:00:00.000Z", snap.dataDays),
    ).toMatchObject({ startDay: "2026-11-01" });
  });

  it("starts coverage on the earliest day with any record", () => {
    const { manifest, tables } = syntheticProjection();
    const first = tables.site_days.map((d) => d.day).sort()[0];
    expect(indexSnapshot({ prefix: "p", manifest, tables }).coverageStart).toBe(
      first,
    );
  });
});

describe("createSnapshotStore", () => {
  it("loads a snapshot once and serves it from memory", async () => {
    const source = fakeSource();
    const store = createSnapshotStore({ source });
    await Promise.all([store.current(), store.current()]);
    expect(source.loads).toBe(1);
  });

  it("swaps to a newer snapshot once its refresh time passes", async () => {
    const source = fakeSource();
    let now = 0;
    const store = createSnapshotStore({
      source,
      now: () => now,
      refreshMs: 1000,
    });
    await store.current();
    source.publish({ prefix: "p2", snapshotId: "snap2" });
    expect((await store.current()).prefix).toBe("p1");
    now = 1001;
    await store.current();
    await vi.waitFor(async () =>
      expect((await store.current()).prefix).toBe("p2"),
    );
  });

  it("keeps answering from the held snapshot while a newer one loads", async () => {
    const source = fakeSource();
    let now = 0;
    const store = createSnapshotStore({
      source,
      now: () => now,
      refreshMs: 1000,
    });
    await store.current();
    source.publish({ prefix: "p2", snapshotId: "snap2" });
    const load = source.load.bind(source);
    /** @type {() => void} */
    let finish = () => {};
    let loading = false;
    source.load = (/** @type {string} */ prefix) =>
      new Promise((resolve) => {
        loading = true;
        finish = () => resolve(load(prefix));
      });
    now = 1001;
    expect((await store.current()).prefix).toBe("p1");
    expect((await store.current()).prefix).toBe("p1");
    // Wait until the load has started, so finish() is the real one.
    await vi.waitFor(() => expect(loading).toBe(true));
    finish();
    await vi.waitFor(async () =>
      expect((await store.current()).prefix).toBe("p2"),
    );
  });

  it("answers 503 when no snapshot has been built, never zeros", async () => {
    const source = fakeSource();
    source.latest = async () => null;
    await expect(
      createSnapshotStore({ source }).current(),
    ).rejects.toMatchObject({ code: "snapshot_unavailable", statusCode: 503 });
  });

  it("refuses a snapshot built to a different contract", async () => {
    const source = fakeSource({ contractVersion: "insights-v0" });
    await expect(
      createSnapshotStore({ source }).current(),
    ).rejects.toMatchObject({
      code: "snapshot_contract_mismatch",
      statusCode: 503,
    });
  });

  it("keeps serving the last good snapshot when a newer one fails to load", async () => {
    const source = fakeSource();
    let now = 0;
    const store = createSnapshotStore({
      source,
      now: () => now,
      refreshMs: 1000,
    });
    await store.current();
    source.publish({ prefix: "p2", snapshotId: "snap2" });
    const load = source.load.bind(source);
    source.load = vi.fn(async () => {
      throw new Error("s3 down");
    });
    now = 1001;
    expect((await store.current()).prefix).toBe("p1");
    await vi.waitFor(() => expect(source.load).toHaveBeenCalled());
    expect((await store.current()).prefix).toBe("p1");
    source.load = load;
  });

  it("loads an older snapshot by prefix for a job that captured it", async () => {
    const source = fakeSource();
    const store = createSnapshotStore({ source });
    await store.current();
    expect((await store.byPrefix("p0", "snap0")).prefix).toBe("p0");
  });

  it("picks up a rebuilt local folder, which keeps its path", async () => {
    const source = fakeSource();
    let now = 0;
    const store = createSnapshotStore({
      source,
      now: () => now,
      refreshMs: 1000,
    });
    await store.current();
    source.publish({ prefix: "p1", snapshotId: "snap1-rebuilt" });
    now = 1001;
    await store.current();
    await vi.waitFor(() => expect(source.loads).toBe(2));
  });

  it("answers 503 once latest.json is gone, so warm and cold Lambdas agree", async () => {
    const source = fakeSource();
    let now = 0;
    const store = createSnapshotStore({
      source,
      now: () => now,
      refreshMs: 1000,
      refreshWaitMs: 100,
      wait: () => new Promise(() => {}),
    });
    await store.current();
    source.latest = async () => null;
    now = 1001;
    await expect(store.current()).rejects.toMatchObject({
      code: "snapshot_unavailable",
      statusCode: 503,
    });
    await expect(store.current()).rejects.toMatchObject({
      code: "snapshot_unavailable",
    });
  });

  it("answers the stale request, then 503, where a request doesn't wait for the refresh", async () => {
    const source = fakeSource();
    let now = 0;
    const store = createSnapshotStore({
      source,
      now: () => now,
      refreshMs: 1000,
    });
    await store.current();
    source.latest = async () => null;
    now = 1001;
    expect((await store.current()).prefix).toBe("p1");
    // Lets the refresh finish with nobody waiting on it, which must not go unhandled.
    await setImmediate();
    await expect(store.current()).rejects.toMatchObject({
      code: "snapshot_unavailable",
    });
  });

  it("waits for a refresh, since a frozen Lambda would never finish it after replying", async () => {
    const source = fakeSource();
    let now = 0;
    const store = createSnapshotStore({
      source,
      now: () => now,
      refreshMs: 1000,
      refreshWaitMs: 100,
      wait: () => new Promise(() => {}),
    });
    await store.current();
    source.publish({ prefix: "p2", snapshotId: "snap2" });
    now = 1001;
    expect((await store.current()).prefix).toBe("p2");
  });

  it("answers from the held snapshot when the refresh outlasts the wait", async () => {
    const source = fakeSource();
    let now = 0;
    /** @type {number[]} */
    const waits = [];
    const store = createSnapshotStore({
      source,
      now: () => now,
      refreshMs: 1000,
      refreshWaitMs: 100,
      wait: async (ms) => {
        waits.push(ms);
      },
    });
    await store.current();
    source.latest = () => new Promise(() => {});
    now = 1001;
    expect((await store.current()).prefix).toBe("p1");
    expect(waits).toEqual([100]);
  });

  it("lets one refresh finish across requests, however long a frozen Lambda held it", async () => {
    const source = fakeSource();
    let now = 0;
    const store = createSnapshotStore({
      source,
      now: () => now,
      refreshMs: 1000,
      refreshWaitMs: 100,
      wait: async () => {},
    });
    await store.current();
    source.publish({ prefix: "p2", snapshotId: "snap2" });
    const load = source.load.bind(source);
    /** @type {() => void} */
    let finish = () => {};
    let started = 0;
    source.load = (/** @type {string} */ prefix) =>
      new Promise((resolve) => {
        started += 1;
        finish = () => resolve(load(prefix));
      });
    now = 1001;
    expect((await store.current()).prefix).toBe("p1");
    await vi.waitFor(() => expect(started).toBe(1));
    // Ten minutes of wall time, as a Lambda frozen between requests sees it.
    now = 1001 + 10 * 60_000;
    expect((await store.current()).prefix).toBe("p1");
    await setImmediate();
    expect(started).toBe(1);
    finish();
    await vi.waitFor(async () =>
      expect((await store.current()).prefix).toBe("p2"),
    );
  });

  it("shares a load with a job already loading the same prefix", async () => {
    const source = fakeSource();
    let now = 0;
    const store = createSnapshotStore({
      source,
      now: () => now,
      refreshMs: 1000,
    });
    await store.current();
    const load = source.load.bind(source);
    /** @type {() => void} */
    let finish = () => {};
    source.load = vi.fn(
      (/** @type {string} */ prefix) =>
        new Promise((resolve) => {
          finish = () => resolve(load(prefix));
        }),
    );
    const job = store.byPrefix("p2", "snap2");
    source.publish({ prefix: "p2", snapshotId: "snap2" });
    now = 1001;
    await store.current();
    await setImmediate();
    finish();
    expect((await job).prefix).toBe("p2");
    await vi.waitFor(async () =>
      expect((await store.current()).prefix).toBe("p2"),
    );
    expect(source.load).toHaveBeenCalledOnce();
  });

  it("follows latest.json back to an older snapshot, so a rollback lands on every Lambda", async () => {
    const source = fakeSource();
    let now = 0;
    const store = createSnapshotStore({
      source,
      now: () => now,
      refreshMs: 1000,
      refreshWaitMs: 100,
      wait: () => new Promise(() => {}),
    });
    source.publish({ prefix: "p3", snapshotId: "snap3" });
    await store.current();
    source.publish({ prefix: "p2", snapshotId: "snap2" });
    now = 1001;
    expect((await store.current()).prefix).toBe("p2");
  });

  it("never lets a refresh that started earlier replace one that started later", async () => {
    const source = fakeSource();
    let now = 0;
    const store = createSnapshotStore({
      source,
      now: () => now,
      refreshMs: 1000,
    });
    await store.current();
    const load = source.load.bind(source);
    /** @type {() => void} */
    let finishP2 = () => {};
    let p2Started = false;
    source.load = (/** @type {string} */ prefix) =>
      prefix === "p2"
        ? new Promise((resolve) => {
            p2Started = true;
            finishP2 = () => resolve(load(prefix));
          })
        : load(prefix);
    source.publish({ prefix: "p2", snapshotId: "snap2" });
    now = 1001;
    await store.current();
    await vi.waitFor(() => expect(p2Started).toBe(true));
    source.publish({ prefix: "p3", snapshotId: "snap3" });
    now = 2002;
    const later = store.current();
    finishP2();
    await later;
    await vi.waitFor(async () =>
      expect((await store.current()).prefix).toBe("p3"),
    );
    now = 2500;
    expect((await store.current()).prefix).toBe("p3");
  });

  it("loads a rebuilt folder afresh rather than join a job still loading its old build", async () => {
    const source = fakeSource();
    let now = 0;
    const store = createSnapshotStore({
      source,
      now: () => now,
      refreshMs: 1000,
    });
    await store.current();
    const load = source.load.bind(source);
    /** @type {(() => void)[]} */
    const finish = [];
    source.load = vi.fn(
      (/** @type {string} */ prefix) =>
        new Promise((resolve) => {
          finish.push(() => resolve(load(prefix)));
        }),
    );
    const job = store.byPrefix("p2", "snap2-old");
    source.publish({ prefix: "p2", snapshotId: "snap2-new" });
    now = 1001;
    await store.current();
    await setImmediate();
    expect(source.load).toHaveBeenCalledTimes(2);
    for (const done of finish) done();
    await job;
  });

  it("with refreshMs 0, checks latest.json again rather than join a check that read it earlier", async () => {
    const source = fakeSource();
    let now = 0;
    const store = createSnapshotStore({
      source,
      now: () => now,
      refreshMs: 0,
      refreshWaitMs: 20_000,
      wait: () => new Promise(() => {}),
    });
    await store.current();
    const latest = source.latest.bind(source);
    /** @type {() => void} */
    let release = () => {};
    // Reads the pointer now, but answers only once released.
    source.latest = () => {
      const read = latest();
      source.latest = latest;
      return new Promise((resolve) => {
        release = () => resolve(read);
      });
    };
    now = 1;
    const first = store.current();
    source.publish({ prefix: "p2", snapshotId: "snap2" });
    now = 2;
    const second = store.current();
    release();
    expect((await first).prefix).toBe("p1");
    expect((await second).prefix).toBe("p2");
  });

  it("answers 503 when a first load outlasts its wait, then serves that load once it lands", async () => {
    const source = fakeSource();
    const load = source.load.bind(source);
    /** @type {() => void} */
    let finish = () => {};
    source.load = vi.fn(
      (/** @type {string} */ prefix) =>
        new Promise((resolve) => {
          finish = () => resolve(load(prefix));
        }),
    );
    const store = createSnapshotStore({
      source,
      firstLoadWaitMs: 100,
      wait: async () => {},
    });
    await expect(store.current()).rejects.toMatchObject({
      code: "snapshot_unavailable",
      statusCode: 503,
    });
    finish();
    await vi.waitFor(async () =>
      expect((await store.current()).prefix).toBe("p1"),
    );
    expect(source.load).toHaveBeenCalledOnce();
  });

  it("reports dropping the held snapshot when latest.json is gone", async () => {
    const source = fakeSource();
    const onError = vi.fn();
    let now = 0;
    const store = createSnapshotStore({
      source,
      now: () => now,
      refreshMs: 1000,
      onError,
    });
    await store.current();
    source.latest = async () => null;
    now = 1001;
    await store.current();
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(onError.mock.calls[0][0]).toMatchObject({
      code: "snapshot_unavailable",
    });
  });

  it("stops the wait timer once the refresh wins", async () => {
    const source = fakeSource();
    let now = 0;
    /** @type {AbortSignal[]} */
    const signals = [];
    const store = createSnapshotStore({
      source,
      now: () => now,
      refreshMs: 1000,
      refreshWaitMs: 100,
      wait: (_ms, signal) => {
        signals.push(signal);
        return new Promise(() => {});
      },
    });
    await store.current();
    source.publish({ prefix: "p2", snapshotId: "snap2" });
    now = 1001;
    expect((await store.current()).prefix).toBe("p2");
    expect(signals.map((s) => s.aborted)).toEqual([true]);
  });

  it("reports a failed refresh while it keeps serving", async () => {
    const source = fakeSource();
    const onError = vi.fn();
    let now = 0;
    const store = createSnapshotStore({
      source,
      now: () => now,
      refreshMs: 1000,
      onError,
    });
    await store.current();
    source.latest = async () => {
      throw new Error("s3 down");
    };
    now = 1001;
    await store.current();
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect((await store.current()).prefix).toBe("p1");
  });

  it("reports an expired snapshot file once, however many requests hit it", async () => {
    const source = fakeSource();
    const onError = vi.fn();
    source.load = async () => {
      throw Object.assign(new Error("snapshot_unavailable"), {
        code: "snapshot_unavailable",
        statusCode: 503,
        expiredKey: "p1/issues.parquet",
      });
    };
    const store = createSnapshotStore({ source, refreshMs: 0, onError });
    for (let i = 0; i < 3; i += 1)
      await expect(store.current()).rejects.toMatchObject({
        code: "snapshot_unavailable",
      });
    expect(onError).toHaveBeenCalledOnce();
  });

  it("loads an older snapshot once for all the jobs that read it", async () => {
    const source = fakeSource();
    const store = createSnapshotStore({ source });
    await store.current();
    await store.byPrefix("p0", "snap0");
    await store.byPrefix("p0", "snap0");
    expect(source.loads).toBe(2);
  });
});

describe("dirSource", () => {
  /** @type {string} */
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "insights-snapshot-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reads back the tables the projection wrote, with days as text", async () => {
    const projection = syntheticProjection();
    const instance = await DuckDBInstance.create(":memory:");
    const conn = await instance.connect();
    await writeSyntheticProjection(conn, join(dir, "projection"));
    conn.closeSync();
    instance.closeSync();
    const source = dirSource(join(dir, "projection"));
    const latest = await source.latest();
    const loaded = await source.load(/** @type {any} */ (latest).prefix);
    expect(loaded.manifest.contractVersion).toBe(CONTRACT_VERSION);
    // Every table, so a new one is round-trip checked without a new line.
    expect(loaded.tables).toEqual(projection.tables);
  });

  it("refuses another contract before reading any table", async () => {
    const out = join(dir, "projection");
    const instance = await DuckDBInstance.create(":memory:");
    const conn = await instance.connect();
    await writeSyntheticProjection(conn, out);
    conn.closeSync();
    instance.closeSync();
    const manifest = JSON.parse(
      readFileSync(join(out, "manifest.json"), "utf8"),
    );
    writeFileSync(
      join(out, "manifest.json"),
      JSON.stringify({ ...manifest, contractVersion: "insights-v0" }),
    );
    // A missing table would fail in DuckDB if the check came later.
    rmSync(join(out, "checks.parquet"));
    await expect(dirSource(out).load(out)).rejects.toMatchObject({
      code: "snapshot_contract_mismatch",
      statusCode: 503,
    });
  });

  it("reports no snapshot for a folder with no manifest", async () => {
    expect(await dirSource(join(dir, "missing")).latest()).toBeNull();
  });
});

describe("s3Source", () => {
  /** @type {string} */
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "insights-s3-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /**
   * S3 backed by a folder: `projections/latest.json`, then files by key.
   * @param {Record<string, string> | null} pointer
   */
  const fakeS3 = (pointer) => ({
    /** @type {string[]} */
    keys: [],
    /** @param {any} cmd */
    async send(cmd) {
      const key = cmd.input.Key;
      this.keys.push(key);
      const bytes =
        key === "projections/latest.json"
          ? pointer && Buffer.from(JSON.stringify(pointer))
          : (() => {
              try {
                return readFileSync(join(dir, key));
              } catch {
                return null;
              }
            })();
      if (!bytes)
        throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
      return { Body: { transformToByteArray: async () => bytes } };
    },
  });

  it("follows latest.json and reads the tables it points at", async () => {
    const projection = syntheticProjection();
    const instance = await DuckDBInstance.create(":memory:");
    const conn = await instance.connect();
    await writeSyntheticProjection(conn, join(dir, "p1"));
    conn.closeSync();
    instance.closeSync();
    const source = s3Source({
      s3: fakeS3({ prefix: "p1", snapshotId: "snap1" }),
      bucket: "lake",
    });
    expect(await source.latest()).toEqual({
      prefix: "p1",
      snapshotId: "snap1",
    });
    const loaded = await source.load("p1");
    expect(loaded.tables.checks).toEqual(projection.tables.checks);
  });

  it("reports no snapshot when the build hasn't written a pointer", async () => {
    const source = s3Source({ s3: fakeS3(null), bucket: "lake" });
    expect(await source.latest()).toBeNull();
  });

  it.each([
    ["a table", "issues.parquet"],
    ["the manifest", "manifest.json"],
  ])(
    "answers not ready when %s has expired before latest.json",
    async (_, file) => {
      const instance = await DuckDBInstance.create(":memory:");
      const conn = await instance.connect();
      await writeSyntheticProjection(conn, join(dir, "p1"));
      conn.closeSync();
      instance.closeSync();
      rmSync(join(dir, "p1", file));
      const s3 = fakeS3({ prefix: "p1", snapshotId: "snap1" });
      await expect(
        s3Source({ s3, bucket: "lake" }).load("p1"),
      ).rejects.toMatchObject({
        code: "snapshot_unavailable",
        statusCode: 503,
      });
    },
  );

  it("downloads at most two table files at once, so the Lambda holds few in memory", async () => {
    const instance = await DuckDBInstance.create(":memory:");
    const conn = await instance.connect();
    await writeSyntheticProjection(conn, join(dir, "p1"));
    conn.closeSync();
    instance.closeSync();
    const s3 = fakeS3({ prefix: "p1", snapshotId: "snap1" });
    const send = s3.send.bind(s3);
    let open = 0;
    let most = 0;
    s3.send = async (/** @type {any} */ cmd) => {
      open += 1;
      most = Math.max(most, open);
      try {
        await setImmediate();
        return await send(cmd);
      } finally {
        open -= 1;
      }
    };
    await s3Source({ s3, bucket: "lake" }).load("p1");
    expect(most).toBe(2);
  });

  it("names the expired file in its error, for the one log line it gets", async () => {
    const instance = await DuckDBInstance.create(":memory:");
    const conn = await instance.connect();
    await writeSyntheticProjection(conn, join(dir, "p1"));
    conn.closeSync();
    instance.closeSync();
    rmSync(join(dir, "p1", "issues.parquet"));
    const s3 = fakeS3({ prefix: "p1", snapshotId: "snap1" });
    await expect(
      s3Source({ s3, bucket: "lake" }).load("p1"),
    ).rejects.toMatchObject({
      code: "snapshot_unavailable",
      expiredKey: "p1/issues.parquet",
    });
  });

  it("passes on any other read error", async () => {
    const instance = await DuckDBInstance.create(":memory:");
    const conn = await instance.connect();
    await writeSyntheticProjection(conn, join(dir, "p1"));
    conn.closeSync();
    instance.closeSync();
    const s3 = fakeS3({ prefix: "p1", snapshotId: "snap1" });
    const send = s3.send.bind(s3);
    s3.send = async (/** @type {any} */ cmd) => {
      if (cmd.input.Key.endsWith("issues.parquet")) {
        s3.keys.push(cmd.input.Key);
        throw Object.assign(new Error("denied"), { name: "AccessDenied" });
      }
      return send(cmd);
    };
    await expect(
      s3Source({ s3, bucket: "lake" }).load("p1"),
    ).rejects.toMatchObject({ name: "AccessDenied" });
  });
});
