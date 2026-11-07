import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { createLocalViews, writeLocalLake } from "./local-lake.js";
import {
  buildChecksOwed,
  buildProjection,
  openSitesWithoutTerms,
} from "./projection.js";
import { PROFILES, generateYear } from "./synthetic/generate.js";
import { readProjection } from "./test-build.js";

/**
 * @param {string} siteId
 * @param {Record<string, any>} extra
 */
const site = (siteId, extra) => ({
  pk: `SITE#${siteId}`,
  sk: "#META",
  siteId,
  status: "active",
  updatedAt: "2026-08-01T00:00:00.000Z",
  ...extra,
});

let version = 0;
/**
 * @param {string} siteId
 * @param {string} effectiveStart
 * @param {Record<string, any>} [extra]
 */
const terms = (siteId, effectiveStart, extra = {}) => {
  version += 1;
  return {
    pk: `SITE#${siteId}`,
    sk: `COMPLIANCE_TERMS#${effectiveStart}#v${version}`,
    siteId,
    termsVersionId: `v${version}`,
    effectiveStart,
    requiredChecksPerDay: 3,
    status: "active",
    ...extra,
  };
};

// Term shapes the generator doesn't make: raises, expiries, cancellations,
// terms with no number, closed Sites and Sites with no terms.
const EDGE_ITEMS = [
  site("e01", {}),
  terms("e01", "2026-09-01", { requiredChecksPerDay: 2 }),
  terms("e01", "2026-09-05", { status: "cancelled", requiredChecksPerDay: 9 }),
  terms("e01", "2026-09-10", {
    requiredChecksPerDay: 5,
    expiresOnExclusive: "2026-09-15",
  }),
  terms("e01", "2026-09-20", { requiredChecksPerDay: undefined }),
  site("e02", { status: "inactive", updatedAt: "2026-09-12T05:00:00.000Z" }),
  terms("e02", "2026-09-01"),
  site("e03", { status: "inactive", updatedAt: "2026-08-15T17:00:00.000Z" }),
  terms("e03", "2026-09-01"),
  site("e04", {}),
  site("e05", { status: "inactive" }),
  site("e06", {}),
  terms("e06", "2026-09-01", { status: "cancelled" }),
  site("e07", {}),
  terms("e07", "2026-09-01", { requiredChecksPerDay: "7" }),
  terms("e07", "2026-09-08", { requiredChecksPerDay: 3.5 }),
  terms("e07", "2026-09-15", { requiredChecksPerDay: 0 }),
  terms("e07", "2026-09-22", { requiredChecksPerDay: -2 }),
  site("e08", {}),
  terms("e08", "2026-10-15"),
  site("e09", {}),
  terms("e09", "2026-09-25", { expiresOnExclusive: "" }),
  site("e10", { status: "inactive", updatedAt: "garbage" }),
  terms("e10", "2026-09-01"),
];

// The JavaScript owed-Checks rule is the oracle until it's removed, so the
// SQL build must write the same rows from the same lake.
const DATASETS = [
  {
    name: "the small synthetic year",
    lake: () =>
      generateYear({ seed: 7, sites: PROFILES.length, startDay: "2026-09-01" }),
  },
  {
    name: "seed 14 with 30 Sites",
    lake: () => generateYear({ seed: 14, sites: 30, startDay: "2026-09-01" }),
  },
  {
    name: "edge-case terms",
    lake: () => ({
      items: EDGE_ITEMS,
      evaluatedAt: "2026-10-01T12:00:00.000Z",
    }),
  },
];

describe.each(DATASETS)(
  "SQL and JavaScript owed Checks on $name",
  ({ lake }) => {
    /** @type {any} */
    let conn;
    /** @type {string} */
    let dir;
    /** @type {{ tables: Record<string, Record<string, any>[]>, manifest: Record<string, any> }} */
    let sql;
    /** @type {Record<string, any>[]} */
    let sites;
    /** @type {Record<string, any>[]} */
    let terms;
    /** @type {string} */
    let evaluatedAt;

    beforeAll(async () => {
      const generated = lake();
      evaluatedAt = generated.evaluatedAt;
      conn = await (await DuckDBInstance.create(":memory:")).connect();
      await conn.run("SET memory_limit = '1GB'");
      dir = mkdtempSync(join(tmpdir(), "insights-owed-oracle-"));
      await writeLocalLake(conn, join(dir, "lake"), generated.items, {
        exportedAt: evaluatedAt,
        exportId: "gen",
      });
      await createLocalViews(conn, join(dir, "lake"));
      const { manifest } = await buildProjection(conn, join(dir, "sql"), {
        evaluatedAt,
        snapshotId: "gen",
      });
      sql = { tables: await readProjection(conn, join(dir, "sql")), manifest };
      /** @param {string} view */
      const records = async (view) =>
        (await conn.runAndReadAll(`SELECT siteId, raw FROM ${view}`))
          .getRowObjectsJS()
          .map((/** @type {Record<string, any>} */ r) => ({
            ...JSON.parse(String(r.raw)),
            siteId: r.siteId,
          }));
      sites = await records("sites");
      terms = await records("compliance_terms");
    });

    afterAll(() => {
      conn.closeSync();
      rmSync(dir, { recursive: true, force: true });
    });

    it("writes identical checks_owed rows, in order", () => {
      const js = buildChecksOwed(sites, terms, evaluatedAt);
      expect(js.length).toBeGreaterThan(0);
      expect(sql.tables.checks_owed).toEqual(js);
    });

    it("counts the same open Sites without terms", () => {
      expect(sql.manifest.dataQuality.openSitesWithoutTerms).toBe(
        openSitesWithoutTerms(sites, terms),
      );
    });
  },
);
