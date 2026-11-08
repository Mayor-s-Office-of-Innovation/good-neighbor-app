import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { SITE_DAY_METRICS } from "../src/reporting/activity.js";
import {
  syntheticProjection,
  writeSyntheticProjection,
} from "../src/reporting/api/test-projection.js";
import {
  answerTotals,
  multiply,
  periods,
  quantile,
  runLoad,
  wholeCounts,
} from "./insights-load.mjs";

/** @type {string} */
let dataDir;
beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "insights-load-"));
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  await writeSyntheticProjection(conn, join(dataDir, "projection"));
  conn.closeSync();
  instance.closeSync();
});
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

/** @param {Record<string, number>} [off] amounts to add to the true totals */
function writeAnswers(off = {}) {
  /** @type {Record<string, number>} */
  const month = {};
  for (const row of syntheticProjection().tables.site_days)
    for (const m of SITE_DAY_METRICS) month[m] = (month[m] ?? 0) + row[m];
  for (const [m, n] of Object.entries(off)) month[m] += n;
  writeFileSync(
    join(dataDir, "answers.json"),
    JSON.stringify({ bySiteMonth: { "s1|2026-10": month } }),
  );
}

describe("wholeCounts", () => {
  it("reads each count as a number", () => {
    expect(wholeCounts({ copies: "21", rounds: "1" })).toEqual({
      copies: 21,
      rounds: 1,
    });
  });

  it.each(["0", "2.5", "x"])("refuses %j", (value) => {
    expect(() => wholeCounts({ parallel: value })).toThrow(
      "--parallel must be a whole number of 1 or more",
    );
  });
});

describe("multiply", () => {
  it("copies every row under new Site and record IDs", () => {
    const out = multiply(
      {
        sites: [{ siteId: "s1", name: "North" }],
        issues: [{ siteId: "s1", issueId: "i1" }],
        site_days: [{ siteId: "s1", day: "2026-10-01" }],
      },
      2,
    );
    expect(out.sites).toEqual([
      { siteId: "s1", name: "North" },
      { siteId: "s1-copy1", name: "North (copy 1)" },
    ]);
    expect(out.issues[1]).toEqual({ siteId: "s1-copy1", issueId: "i1-copy1" });
    expect(out.site_days[1]).toEqual({
      siteId: "s1-copy1",
      day: "2026-10-01",
    });
  });

  it("returns one copy unchanged", () => {
    const tables = { sites: [{ siteId: "s1" }] };
    expect(multiply(tables, 1)).toBe(tables);
  });
});

describe("periods", () => {
  it("reads months in Pacific time", () => {
    // 01:00 UTC on 1 Nov is still 31 Oct in San Francisco.
    expect(periods("2026-11-01T01:00:00.000Z")).toEqual({
      today: "2026-10-31",
      month: { period: "month", month: "2026-09" },
      year: { period: "custom", from: "2025-10-01", to: "2026-10-01" },
    });
  });
});

describe("answerTotals", () => {
  it("adds each metric over every Site and month, skipping other fields", () => {
    expect(
      answerTotals({
        bySiteMonth: {
          a: { checksCompleted: 2, issuesCreated: 1, label: "x" },
          b: { checksCompleted: 3 },
        },
      }),
    ).toEqual({ checksCompleted: 5, issuesCreated: 1 });
    expect(answerTotals({})).toEqual({});
  });
});

describe("quantile", () => {
  it("sorts a copy before picking", () => {
    const xs = [4, 1, 3, 2];
    expect(quantile(xs, 0.5)).toBe(3);
    expect(xs).toEqual([4, 1, 3, 2]);
  });
});

describe("runLoad", () => {
  /**
   * @param {number} copies
   * @param {{ maxExportRows?: number, table?: (data: any) => void }} [opts]
   */
  const run = async (copies, opts = {}) => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "table").mockImplementation(opts.table ?? (() => {}));
    try {
      return await runLoad({
        dataDir,
        copies,
        rounds: 1,
        parallel: 2,
        maxExportRows: opts.maxExportRows,
      });
    } finally {
      vi.restoreAllMocks();
    }
  };

  it("times every endpoint and finds the counts agree with the answers", async () => {
    writeAnswers();
    const { sites, timings, problems } = await run(1);
    expect(problems).toEqual([]);
    expect(sites).toBe(3);
    expect(Object.keys(timings)).toHaveLength(11);
    for (const t of Object.values(timings)) expect(t.bytes).toBeGreaterThan(0);
  });

  it("still times the other endpoints when one fails, and names it", async () => {
    writeAnswers();
    /** @type {any} */
    let printed;
    const { timings, problems } = await run(1, {
      maxExportRows: 0,
      table: (data) => {
        printed = data;
      },
    });
    const label = "export request, 12 months of Issues";
    expect(timings[label].error).toMatch(/^413 /);
    expect(Object.keys(printed)).toHaveLength(11);
    expect(timings["overview, month"].bytes).toBeGreaterThan(0);
    expect(problems).toContainEqual(expect.stringContaining(label));
  });

  it("names a total that differs from the generator's answer", async () => {
    writeAnswers({ issuesCreated: 1 });
    const { problems } = await run(1);
    expect(problems).toEqual([
      expect.stringMatching(/^issuesCreated: Overview \d+, generator \d+$/),
    ]);
  });

  it("still agrees across copies, where the answers don't apply", async () => {
    writeAnswers({ issuesCreated: 1 });
    const { sites, problems } = await run(3);
    expect(sites).toBe(9);
    expect(problems).toEqual([]);
  });

  it("refuses a folder with no projection", async () => {
    await expect(
      runLoad({
        dataDir: join(dataDir, "none"),
        copies: 1,
        rounds: 1,
        parallel: 1,
      }),
    ).rejects.toThrow("no projection in");
  });
});
