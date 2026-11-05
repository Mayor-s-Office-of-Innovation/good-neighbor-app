import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { CONTRACT_VERSION } from "../contract.js";
import { TABLE_SCHEMAS } from "../projection.js";
import {
  createSnapshotStore,
  dirSource,
  indexSnapshot,
  s3Source,
} from "./snapshot.js";
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

  it("groups each Site's days in day order, and its Issues", () => {
    const { manifest, tables } = syntheticProjection();
    tables.site_days.reverse();
    const snap = indexSnapshot({ prefix: "p", manifest, tables });
    const days = snap.daysBySite.get("s1")?.map((d) => d.day) ?? [];
    expect(days).toEqual([...days].sort());
    expect(days).toHaveLength(
      tables.site_days.filter((d) => d.siteId === "s1").length,
    );
    expect(snap.issuesBySite.get("s2")?.map((i) => i.siteId)).toEqual([
      "s2",
      "s2",
    ]);
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
    expect((await store.byPrefix("p0")).prefix).toBe("p0");
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

  it("loads an older snapshot once for all the jobs that read it", async () => {
    const source = fakeSource();
    const store = createSnapshotStore({ source });
    await store.current();
    await store.byPrefix("p0");
    await store.byPrefix("p0");
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

  it("passes on a missing table's error, having asked for every table", async () => {
    const instance = await DuckDBInstance.create(":memory:");
    const conn = await instance.connect();
    await writeSyntheticProjection(conn, join(dir, "p1"));
    conn.closeSync();
    instance.closeSync();
    rmSync(join(dir, "p1", "issues.parquet"));
    const s3 = fakeS3({ prefix: "p1", snapshotId: "snap1" });
    await expect(
      s3Source({ s3, bucket: "lake" }).load("p1"),
    ).rejects.toMatchObject({ name: "NoSuchKey" });
    expect(s3.keys.filter((k) => k.endsWith(".parquet"))).toHaveLength(
      Object.keys(TABLE_SCHEMAS).length,
    );
  });
});
