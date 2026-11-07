import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LATEST_PROJECTION_KEY } from "./contract.js";
import { createLocalViews, writeLocalLake } from "./local-lake.js";
import { TABLE_SCHEMAS } from "./projection.js";
import {
  buildLatestProjection,
  publishProjection,
} from "./publish-projection.js";

const NOW = new Date("2026-11-05T12:00:00.000Z");
const SNAPSHOT_ID = "2026-11-05T12-00-00-000Z";
// One Site with one finished Check, stored as the app stores them.
const LAKE_ITEMS = [
  { pk: "SITE#s1", sk: "#META", siteId: "s1", status: "active" },
  {
    pk: "SITE#s1",
    sk: "CHECK#c1",
    siteId: "s1",
    checkId: "c1",
    status: "completed",
    flowType: "perimeter",
    startedAt: "2026-11-02T16:00:00.000Z",
    completedAt: "2026-11-02T16:10:00.000Z",
  },
];

/** @type {string} */
let tmp;
/** @type {string} */
let scratch;
/** @type {{ key: string, body: any }[]} */
let puts;
/** @type {{ send: import("vitest").Mock }} */
let s3;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "publish-projection-test-"));
  // Its own folder, since other suites use the system one at the same time.
  scratch = join(tmp, "scratch");
  await mkdir(scratch);
  vi.stubEnv("TMPDIR", scratch);
  puts = [];
  s3 = {
    send: vi.fn(async (command) => {
      puts.push({ key: command.input.Key, body: command.input.Body });
    }),
  };
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(tmp, { recursive: true, force: true });
});

/**
 * Stands in for the S3 views, over rows written the way the converter writes them.
 * @param {any} conn
 */
async function prepare(conn) {
  await writeLocalLake(conn, join(tmp, "lake"), LAKE_ITEMS, {
    exportedAt: "2026-11-05T06:00:00.000Z",
    exportId: "e1",
  });
  await createLocalViews(conn, join(tmp, "lake"));
}

const build = () =>
  buildLatestProjection({
    s3,
    bucket: "lake",
    now: () => NOW,
    prepare,
  });

describe("buildLatestProjection", () => {
  it("publishes every table of the lake's snapshot and points latest.json at it last", async () => {
    const published = await build();
    expect(published.snapshotId).toBe(SNAPSHOT_ID);
    expect(published.prefix).toMatch(
      new RegExp(`^projections/[^/]+/${SNAPSHOT_ID}$`),
    );
    expect(puts.map((p) => p.key).sort()).toEqual(
      [
        ...Object.keys(TABLE_SCHEMAS).map(
          (name) => `${published.prefix}/${name}.parquet`,
        ),
        `${published.prefix}/manifest.json`,
        LATEST_PROJECTION_KEY,
      ].sort(),
    );
    expect(puts.at(-1)?.key).toBe(LATEST_PROJECTION_KEY);
    expect(JSON.parse(puts.at(-1)?.body)).toEqual(published);
  });

  it("counts the lake's rows into the manifest", async () => {
    const { prefix } = await build();
    const manifest = puts.find((p) => p.key === `${prefix}/manifest.json`);
    const parsed = JSON.parse(String(manifest?.body));
    expect(parsed.snapshotId).toBe(SNAPSHOT_ID);
    expect(parsed.evaluatedAt).toBe(NOW.toISOString());
    expect(parsed.asOf).toBe("2026-11-05T06:00:00.000Z");
    expect(parsed.rowCounts.checks).toBe(1);
    expect(parsed.rowCounts.sites).toBe(1);
  });

  it("keeps the last snapshot live when an upload fails", async () => {
    const upload = /** @type {any} */ (s3.send.getMockImplementation());
    s3.send.mockImplementationOnce(upload).mockImplementationOnce(async () => {
      throw new Error("s3 down");
    });
    await expect(build()).rejects.toThrow("s3 down");
    expect(puts).toHaveLength(1);
    expect(puts.map((p) => p.key)).not.toContain(LATEST_PROJECTION_KEY);
  });

  it("asks S3 to encrypt every file, as the other lake writers do", async () => {
    await build();
    const sent = s3.send.mock.calls.map(([command]) => command.input);
    expect(sent.length).toBeGreaterThan(1);
    expect(sent.map((input) => input.ServerSideEncryption)).toEqual(
      sent.map(() => "aws:kms"),
    );
  });

  it("clears a folder a timed-out build left behind, but no other files", async () => {
    await mkdir(join(scratch, "insights-projection-old"));
    await writeFile(join(scratch, "insights-snapshot-keep"), "");
    await build();
    expect(await readdir(scratch)).toEqual(["insights-snapshot-keep"]);
  });

  it("refuses to run without a lake bucket", async () => {
    await expect(
      buildLatestProjection({ s3, bucket: "", prepare }),
    ).rejects.toThrow("Missing LAKE_BUCKET");
    expect(puts).toEqual([]);
  });

  it("works in one temporary folder and leaves it behind after a failed build", async () => {
    /** @type {string[]} */
    let during = [];
    await expect(
      buildLatestProjection({
        s3,
        bucket: "lake",
        prepare: async () => {
          during = await readdir(scratch);
          throw new Error("no lake");
        },
      }),
    ).rejects.toThrow("no lake");
    expect(during).toEqual([expect.stringMatching(/^insights-projection-/)]);
    expect(await readdir(scratch)).toEqual([]);
  });

  it("leaves no temporary files behind after a build that succeeds", async () => {
    await build();
    expect(await readdir(scratch)).toEqual([]);
  });

  it("caps DuckDB's memory and spill below the Lambda's limits", async () => {
    /** @type {Record<string, string>} */
    let settings = {};
    await buildLatestProjection({
      s3,
      bucket: "lake",
      now: () => NOW,
      prepare: async (conn) => {
        const reader = await conn.runAndReadAll(
          "SELECT name, value FROM duckdb_settings() WHERE name IN ('memory_limit', 'max_temp_directory_size')",
        );
        settings = Object.fromEntries(reader.getRows());
        await prepare(conn);
      },
    });
    expect(settings.memory_limit).toMatch(/^1\.[0-9]+ GiB$/);
    expect(settings.max_temp_directory_size).toMatch(/^1\.[0-9]+ GiB$/);
  });
});

describe("publishProjection", () => {
  it("files the snapshot under its contract version, so a reader on another contract refuses it", async () => {
    const dir = join(tmp, "built");
    await mkdir(dir);
    await writeFile(join(dir, "sites.parquet"), "rows");
    const result = await publishProjection({
      s3,
      bucket: "lake",
      dir,
      manifest: { contractVersion: "v9", snapshotId: "snap" },
      written: ["sites.parquet"],
    });
    expect(result).toEqual({
      prefix: "projections/v9/snap",
      snapshotId: "snap",
    });
    expect(puts[0].key).toBe("projections/v9/snap/sites.parquet");
    expect(String(puts[0].body)).toBe("rows");
  });
});
