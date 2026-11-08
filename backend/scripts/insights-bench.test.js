import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { SITE_DAY_METRICS } from "../src/reporting/activity.js";
import * as readModel from "../src/reporting/api/read-model.js";
import { dirSource, indexSnapshot } from "../src/reporting/api/snapshot.js";
import { writeSyntheticProjection } from "../src/reporting/api/test-projection.js";
import {
  QUERIES,
  bucketRanges,
  buildSize,
  byName,
  childResult,
  designB,
  fileBytes,
  main,
  measure,
  quantile,
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

describe("bucketRanges", () => {
  it("cuts months, ending the last at the interval's end", () => {
    expect(
      bucketRanges(
        { startDay: "2026-01-01", endDay: "2026-02-15" },
        "month",
        "2026-12-31",
      ),
    ).toEqual([
      { start: "2026-01-01", end: "2026-02-01" },
      { start: "2026-02-01", end: "2026-02-15" },
    ]);
  });

  it("stops at the bucket holding today", () => {
    expect(
      bucketRanges(
        { startDay: "2026-03-02", endDay: "2026-04-01" },
        "week",
        "2026-03-10",
      ),
    ).toEqual([
      { start: "2026-03-02", end: "2026-03-09" },
      { start: "2026-03-09", end: "2026-03-16" },
    ]);
  });
});

describe("byName", () => {
  it("sorts names as people read them, then by ID", () => {
    const sites = [
      { siteId: "b", name: "Site 10" },
      { siteId: "c", name: null },
      { siteId: "a", name: "site 9" },
      { siteId: "d", name: "Site 9" },
    ];
    expect(sites.sort(byName).map((s) => s.siteId)).toEqual([
      "c",
      "d",
      "a",
      "b",
    ]);
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
describe("designB", () => {
  /** @param {Record<string, any>} row */
  const metrics = (row) =>
    Object.fromEntries(SITE_DAY_METRICS.map((m) => [m, Number(row?.[m] ?? 0)]));
  /** @param {any} t */
  const flat = (t) => metrics({ ...t.activity, ...t.response });
  /** @param {any} change */
  const changes = (change) =>
    change &&
    Object.fromEntries(
      SITE_DAY_METRICS.map((m) => [m, [change[m].current, change[m].prior]]),
    );
  /** @param {any[]} series */
  const buckets = (series) =>
    series.map((b) => ({
      start: b.start,
      end: b.end,
      partial: b.partial,
      noData: b.noData,
      ...metrics(b),
    }));
  /** @type {Record<string, (r: any) => any>} */
  const answer = {
    overview: (r) => ({
      totals: flat(r.totals),
      comparison: changes(r.comparison.change),
      siteCount: r.siteCount,
      page: r.sites.map((/** @type {any} */ s) => ({
        siteId: s.siteId,
        name: s.name,
        maxSeverity: s.maxSeverity,
        ...flat(s),
      })),
    }),
    trends: (r) => ({
      siteCount: r.scope.siteCount,
      comparison: changes(r.comparison.change),
      current: buckets(r.series.current),
      prior: buckets(r.series.prior),
      breakdown: r.breakdown.map((/** @type {any} */ g) => ({
        value: g.value,
        sites: g.sites,
        current: metrics(g.current),
        prior: g.prior && metrics(g.prior),
      })),
      categories: r.categories,
    }),
    site: (r) => ({
      siteId: r.site.siteId,
      totals: flat(r.totals),
      comparison: changes(r.comparison.change),
      days: r.days.map((/** @type {any} */ d) => ({
        day: d.day,
        ...metrics(d),
      })),
    }),
    issues: (r) => ({
      total: r.total,
      page: r.issues.map((/** @type {any} */ i) => [
        i.issueId,
        i.siteId,
        i.createdAt,
        i.siteName,
      ]),
    }),
  };

  it.each(QUERIES)("answers %s as read-model.js does", async (query) => {
    const req = { ...requests(manifestOf(base)), siteId: "s1" };
    const snap = indexSnapshot(await dirSource(base).load(base));
    const want = {
      overview: () =>
        readModel.overview(snap, {
          interval: req.year,
          filter: {},
          list: req.siteList,
          now: req.now,
        }),
      trends: () =>
        readModel.trends(snap, {
          interval: req.year,
          scope: {},
          breakdown: "department",
          now: req.now,
        }),
      site: () =>
        readModel.siteDetail(snap, "s1", { interval: req.year, now: req.now }),
      issues: () =>
        readModel.listIssues(snap, {
          interval: req.month,
          filter: {},
          list: req.issueList,
          now: req.now,
        }),
    }[query]();
    const b = await designB(base, req);
    try {
      expect(answer[query](await b.run(query))).toEqual(answer[query](want));
    } finally {
      b.close();
    }
  });

  it("refuses a Site the files don't hold", async () => {
    const b = await designB(base, requests(manifestOf(base)));
    try {
      await expect(b.run("site")).rejects.toThrow("no Site syn-site-01");
    } finally {
      b.close();
    }
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
    const b = await designB(out, {
      ...requests(built),
      siteId: "s1-copy1",
    });
    try {
      const site = await b.run("site");
      expect(site.site.siteId).toBe("s1-copy1");
      // Each Site's moved year adds a second copy of every dated row.
      expect(built.rowCounts.checks).toBeGreaterThan(input.rowCounts.checks);
    } finally {
      b.close();
    }
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
    const r = await measure("overview", base, { runs: 3, threads: 1 });
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
        threads: "1",
      };
      const results = await main(opts, benchDir);
      expect(results.map((r) => [r.query, r.ok])).toEqual(
        QUERIES.map((q) => [q, q !== "site"]),
      );
      // The synthetic Sites aren't named syn-site-01, so Site detail fails.
      expect(results[2].detail).toContain("no Site syn-site-01");
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
        threads: "1",
      }),
    ).rejects.toThrow("no projection in");
  });
});
