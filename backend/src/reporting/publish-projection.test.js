import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createViews } from "../analytics/lake-views.js";
import { LATEST_PROJECTION_KEY } from "./contract.js";
import { createLocalViews, writeLocalLake } from "./local-lake.js";
import { TABLE_SCHEMAS } from "./projection.js";
import {
  buildLatestProjection,
  publishProjection,
} from "./publish-projection.js";

vi.mock(import("../analytics/lake-views.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  createViews: vi.fn(),
}));

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
/** @type {{ key: string, body: any, length?: number }[]} */
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
      const { Key, Body, ContentLength } = command.input;
      // Read a streamed body, as S3 would, so the test sees its text.
      const body = Body instanceof Readable ? await buffer(Body) : Body;
      puts.push({ key: Key, body, length: ContentLength });
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
    expect(puts.length).toBeGreaterThan(0);
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

  it("clears a folder a timed-out build left behind on Lambda, but no other files", async () => {
    vi.stubEnv("AWS_LAMBDA_FUNCTION_NAME", "analytics-projection");
    await mkdir(join(scratch, "insights-projection-old"));
    await writeFile(join(scratch, "insights-snapshot-keep"), "");
    await build();
    expect(await readdir(scratch)).toEqual(["insights-snapshot-keep"]);
  });

  it("keeps other build folders off Lambda, where another worktree may be building", async () => {
    vi.stubEnv("AWS_LAMBDA_FUNCTION_NAME", "");
    await mkdir(join(scratch, "insights-projection-other"));
    await build();
    expect(await readdir(scratch)).toEqual(["insights-projection-other"]);
  });

  it("streams each table with its length, so no file sits whole in memory", async () => {
    vi.spyOn(s3, "send");
    await build();
    const tables = s3.send.mock.calls
      .map(([command]) => command.input)
      .filter((input) => input.Key.endsWith(".parquet"));
    expect(tables.length).toBeGreaterThan(1);
    for (const input of tables) expect(input.Body).toBeInstanceOf(Readable);
    for (const put of puts.filter((p) => p.key.endsWith(".parquet")))
      expect(put.length).toBe(put.body.length);
  });

  it("closes DuckDB before uploading, so its memory is free for the upload", async () => {
    /** @type {any} */
    let held;
    /** @type {unknown[]} */
    const usable = [];
    const upload = /** @type {any} */ (s3.send.getMockImplementation());
    s3.send.mockImplementation(async (command) => {
      usable.push(
        await held.run("SELECT 1").then(
          () => true,
          () => false,
        ),
      );
      return upload(command);
    });
    await buildLatestProjection({
      s3,
      bucket: "lake",
      now: () => NOW,
      prepare: async (conn) => {
        held = conn;
        await prepare(conn);
      },
    });
    expect(usable.length).toBeGreaterThan(1);
    expect(usable).not.toContain(true);
  });

  it("uploads the tables together, and latest.json only once all have landed", async () => {
    let inFlight = 0;
    let most = 0;
    /** @type {number[]} */
    const atLatest = [];
    const upload = /** @type {any} */ (s3.send.getMockImplementation());
    s3.send.mockImplementation(async (command) => {
      if (command.input.Key === LATEST_PROJECTION_KEY) atLatest.push(inFlight);
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      await upload(command);
      inFlight -= 1;
    });
    await build();
    expect(most).toBeGreaterThan(1);
    expect(atLatest).toEqual([0]);
  });

  it("refuses to run without a lake bucket", async () => {
    await expect(
      buildLatestProjection({ s3, bucket: "", prepare }),
    ).rejects.toThrow("Missing LAKE_BUCKET");
    expect(puts).toEqual([]);
  });

  it("works in one temporary folder and removes it after a failed build", async () => {
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
    // Half of the Lambda's 2 GiB of /tmp; the extensions and output need the rest.
    expect(settings.max_temp_directory_size).toBe("1.0 GiB");
  });

  it("reads the S3 lake when no local lake is passed", async () => {
    vi.mocked(createViews).mockImplementationOnce(async (conn) => {
      await prepare(conn);
      return { empty: [] };
    });
    await buildLatestProjection({
      s3,
      bucket: "lake",
      endpoint: "http://127.0.0.1:9000",
      now: () => NOW,
    });
    expect(createViews).toHaveBeenCalledWith(expect.anything(), "lake", {
      s3,
      endpoint: "http://127.0.0.1:9000",
    });
    expect(puts.at(-1)?.key).toBe(LATEST_PROJECTION_KEY);
  });

  it.each([
    ["path-style URLs for an emulator endpoint", "http://127.0.0.1:9000", true],
    ["AWS's default URLs with no endpoint", undefined, false],
  ])("builds its own S3 client with %s", async (_, endpoint, pathStyle) => {
    /** @type {any} */
    let client;
    vi.mocked(createViews).mockImplementationOnce(
      async (_conn, _bucket, opts) => {
        client = opts?.s3;
        throw new Error("stop before upload");
      },
    );
    await expect(
      buildLatestProjection({ bucket: "lake", endpoint, now: () => NOW }),
    ).rejects.toThrow("stop before upload");
    expect(Boolean(client.config.forcePathStyle)).toBe(pathStyle);
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
