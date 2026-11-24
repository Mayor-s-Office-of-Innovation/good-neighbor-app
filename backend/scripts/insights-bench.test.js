import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import {
  createSnapshotStore,
  dirSource,
} from "../src/reporting/api/snapshot.js";
import { writeSyntheticProjection } from "../src/reporting/api/test-projection.js";
import {
  QUERIES,
  buildSize,
  builtFrom,
  childResult,
  fileBytes,
  main,
  measure,
  quantile,
  queriesFor,
  requests,
  wholeNumbers,
} from "./insights-bench.mjs";

/** @type {string} */
let root;
/** @type {string} */
let base;
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "insights-bench-"));
  base = join(root, "projection");
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  await writeSyntheticProjection(conn, base);
  conn.closeSync();
  instance.closeSync();
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const manifestOf = (/** @type {string} */ dir) =>
  JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));

describe("wholeNumbers", () => {
  it("reads a comma-separated list", () => {
    expect(wholeNumbers("500,1000", "--sites")).toEqual([500, 1000]);
  });

  it.each(["0", "1.5", "", "2,x"])("refuses %j", (list) => {
    expect(() => wholeNumbers(list, "--sites")).toThrow(
      "--sites must be whole numbers of 1 or more",
    );
  });
});

describe("requests", () => {
  it("asks for the 12 months before this Pacific month and last month", () => {
    // 01:00 UTC on 1 Nov is still 31 Oct in San Francisco.
    const req = requests({ evaluatedAt: "2026-11-01T01:00:00.000Z" });
    expect(req.today).toBe("2026-10-31");
    expect(req.year).toMatchObject({
      startDay: "2025-10-01",
      endDay: "2026-10-01",
    });
    expect(req.month).toMatchObject({
      startDay: "2026-09-01",
      endDay: "2026-10-01",
    });
  });
});

describe("quantile", () => {
  it("picks from a sorted list without running off the end", () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(3);
    expect(quantile([1, 2, 3, 4], 0.99)).toBe(4);
  });
});

// The bench's SQL only times the right work if it answers as the API does,
// so each query is held to read-model.js on the same files.
describe("queriesFor", () => {
  it("answers every query through the shipped reader", async () => {
    const store = createSnapshotStore({ source: dirSource(base) });
    try {
      const snap = await store.current();
      const queries = queriesFor(snap, requests(snap.manifest));
      expect(Object.keys(queries)).toEqual(QUERIES);
      const site = /** @type {any} */ (await queries.site());
      expect(site.site.siteId).toBe(snap.sites[0].siteId);
      // The CSV and the report are the jobs' own output, measured in characters.
      expect(await queries.export()).toBeGreaterThan(0);
      expect(await queries.report()).toBeGreaterThan(0);
    } finally {
      await store.close();
    }
  });
});

describe("builtFrom", () => {
  it("rebuilds after insights:data reruns, though the snapshot ID stays the same", async () => {
    const out = join(root, "3-sites-1y");
    await buildSize(base, out, 3, 1);
    const baseText = readFileSync(join(base, "manifest.json"), "utf8");
    expect(builtFrom(manifestOf(out), baseText)).toBe(true);
    const rerun = { ...JSON.parse(baseText), rowCounts: { issues: 1 } };
    expect(builtFrom(manifestOf(out), JSON.stringify(rerun))).toBe(false);
  });
});

describe("buildSize", () => {
  it("copies Sites under new IDs and moves each extra year back a span", async () => {
    const out = join(root, "5-sites-2y");
    await buildSize(base, out, 5, 2);
    const built = manifestOf(out);
    const input = manifestOf(base);
    expect(built.snapshotId).toBe(input.snapshotId);
    expect(built.bench).toMatchObject({ sites: 5, years: 2, copies: 2 });
    expect(built.rowCounts.sites).toBe(5);
    const store = createSnapshotStore({ source: dirSource(out) });
    try {
      const snap = await store.current();
      expect(snap.sitesById.has("s1-copy1")).toBe(true);
    } finally {
      await store.close();
    }
    // Each Site's moved year adds a second copy of every dated row.
    expect(built.rowCounts.checks).toBeGreaterThan(input.rowCounts.checks);
  });
});

describe("fileBytes", () => {
  it("counts only the files a query reads", async () => {
    const size = (/** @type {string} */ n) =>
      statSync(join(base, `${n}.parquet`)).size;
    expect(await fileBytes(base, "issues")).toBe(
      size("issues") + size("sites"),
    );
    expect(await fileBytes(base, "site")).toBe(
      size("site_days") + size("sites"),
    );
  });
});

describe("measure", () => {
  it("times the warm runs after the first answer", async () => {
    const r = await measure("overview", base, { runs: 3 });
    expect(r.warmP50).toBeGreaterThan(0);
    expect(r.warmP95).toBeGreaterThanOrEqual(r.warmP50);
    expect(r.peakRssMiB).toBeGreaterThan(r.peakHeapMiB);
  });
});

describe("childResult", () => {
  const timed = { coldMs: 5, peakRssMiB: 100, peakHeapMiB: 20 };

  it("reads the child's last stdout line", () => {
    expect(
      childResult({
        code: 0,
        signal: null,
        out: `warning\n${JSON.stringify(timed)}\n`,
        err: "",
      }),
    ).toEqual({ ok: true, ...timed });
  });

  it("fails a run over the Lambda's memory", () => {
    expect(
      childResult({
        code: 0,
        signal: null,
        out: JSON.stringify({ ...timed, peakRssMiB: 2100 }),
        err: "",
      }),
    ).toMatchObject({
      ok: false,
      failure: "peak RSS 2100 MiB, over the Lambda's 2048",
    });
  });

  it("names a heap crash", () => {
    expect(
      childResult({
        code: null,
        signal: "SIGABRT",
        out: "",
        err: "FATAL ERROR: Reached heap limit Allocation failed",
      }),
    ).toMatchObject({ ok: false, failure: "out of memory at 2048 MiB heap" });
  });

  it("gives the error line, not the stack, for a thrown error", () => {
    expect(
      childResult({
        code: 1,
        signal: null,
        out: "not json",
        err: "file:///x.mjs:1\nError: no Site s9\n    at site (x.mjs:2)",
      }),
    ).toEqual({ ok: false, failure: "exit 1", detail: "Error: no Site s9" });
  });
});

describe("main", () => {
  it("builds a size once, then times every query in its own process", async () => {
    const benchDir = join(root, "bench");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "table").mockImplementation(() => {});
    try {
      const opts = {
        dir: root,
        sites: "3",
        years: "1",
        runs: "1",
      };
      const results = await main(opts, benchDir);
      expect(results.map((r) => [r.query, r.ok])).toEqual(
        QUERIES.map((q) => [q, true]),
      );
      log.mockClear();
      await main({ ...opts, sites: "3" }, benchDir);
      expect(log.mock.calls.flat().join("\n")).not.toContain("built");
    } finally {
      vi.restoreAllMocks();
    }
  }, 60_000);

  it("refuses a folder with no projection", async () => {
    await expect(
      main({
        dir: join(root, "none"),
        sites: "1",
        years: "1",
        runs: "1",
      }),
    ).rejects.toThrow("no projection in");
  });
});
