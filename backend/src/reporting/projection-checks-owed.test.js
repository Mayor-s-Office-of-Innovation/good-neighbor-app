import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import {
  addDays,
  dayKeysBetween,
  pacificDateKey,
} from "../lib/pacific-dates.js";
import { checksOwedResolver } from "../lib/site-compliance.js";
import { createLocalViews, writeLocalLake } from "./local-lake.js";
import { buildProjection } from "./projection.js";
import { PROFILES, generateYear } from "./synthetic/generate.js";
import { buildFromRows, readProjection } from "./test-build.js";

// Oct 19 Pacific.
const EVALUATED = "2026-10-20T00:00:00.000Z";

/**
 * One COMPLIANCE_TERMS# version.
 * @param {string} siteId
 * @param {string} effectiveStart
 * @param {Record<string, any>} [extra]
 */
const terms = (siteId, effectiveStart, extra = {}) => ({
  siteId,
  termsVersionId: `v-${effectiveStart}`,
  effectiveStart,
  requiredChecksPerDay: 3,
  status: "active",
  ...extra,
});

/**
 * @param {Record<string, any>[]} sites
 * @param {Record<string, any>[]} termRows
 * @param {string} [evaluatedAt]
 */
async function buildOwed(sites, termRows, evaluatedAt = EVALUATED) {
  const { tables, manifest } = await buildFromRows(
    { sites, terms: termRows },
    evaluatedAt,
  );
  return {
    owed: Object.fromEntries(
      tables.checks_owed.map((r) => [`${r.siteId} ${r.day}`, r.checksOwed]),
    ),
    openSitesWithoutTerms: manifest.dataQuality.openSitesWithoutTerms,
  };
}

describe("checks_owed in the projection", () => {
  it("owes each day what the terms in force that day set, as the Check report does", async () => {
    const { owed } = await buildOwed(
      [{ siteId: "s1" }, { siteId: "s2" }],
      [
        terms("s1", "2026-10-14", { requiredChecksPerDay: 2 }),
        // A raise from Oct 16 that ends after Oct 17.
        terms("s1", "2026-10-16", {
          requiredChecksPerDay: 5,
          expiresOnExclusive: "2026-10-18",
        }),
        // Never applied, so it doesn't change Oct 15.
        terms("s1", "2026-10-15", { status: "cancelled" }),
      ],
    );
    // Nothing from Oct 18, when the raise ended.
    expect(owed).toEqual({
      "s1 2026-10-14": 2,
      "s1 2026-10-15": 2,
      "s1 2026-10-16": 5,
      "s1 2026-10-17": 5,
    });
  });

  it("owes nothing for a Site with no terms, and counts it if it's open", async () => {
    const result = await buildOwed(
      [
        {
          siteId: "s1",
          compliance: {
            perimeterChecksRequired: true,
            requiredChecksPerDay: 5,
            periodStart: "2026-10-01",
          },
        },
        { siteId: "s2", status: "inactive" },
        // Has terms, from after the snapshot.
        { siteId: "s3" },
      ],
      [terms("s3", "2026-10-25")],
    );
    expect(result).toEqual({ owed: {}, openSitesWithoutTerms: 1 });
  });

  it("owes a past term with no number of its own the default, whatever today's term says", async () => {
    const { owed } = await buildOwed(
      [{ siteId: "s1" }],
      [
        terms("s1", "2026-10-16", {
          requiredChecksPerDay: undefined,
          expiresOnExclusive: "2026-10-18",
        }),
        terms("s1", "2026-10-18", { requiredChecksPerDay: 5 }),
      ],
    );
    expect(owed).toEqual({
      "s1 2026-10-16": 3,
      "s1 2026-10-17": 3,
      "s1 2026-10-18": 5,
      "s1 2026-10-19": 5,
    });
  });

  it("owes the default for a number that isn't a whole count above zero", async () => {
    const { owed } = await buildOwed(
      [{ siteId: "s1" }],
      [
        // Too large to be real; it would also break the whole build.
        terms("s1", "2026-10-15", { requiredChecksPerDay: 1e10 }),
        terms("s1", "2026-10-16", { requiredChecksPerDay: "7" }),
        terms("s1", "2026-10-17", { requiredChecksPerDay: 3.5 }),
        terms("s1", "2026-10-18", { requiredChecksPerDay: 0 }),
        terms("s1", "2026-10-19", { requiredChecksPerDay: -2 }),
      ],
    );
    expect(owed).toEqual({
      "s1 2026-10-15": 3,
      "s1 2026-10-16": 7,
      "s1 2026-10-17": 3,
      "s1 2026-10-18": 3,
      "s1 2026-10-19": 3,
    });
  });

  it("uses the later-made of two versions that start the same day, whatever the row order", async () => {
    // Ended the day it began, then made again that day.
    const ended = terms("s1", "2026-10-18", {
      termsVersionId: "v-a",
      createdAt: "2026-10-18T16:00:00.000Z",
      expiresOnExclusive: "2026-10-18",
    });
    const remade = terms("s1", "2026-10-18", {
      termsVersionId: "v-b",
      createdAt: "2026-10-18T17:00:00.000Z",
      requiredChecksPerDay: 6,
    });
    const expected = { "s1 2026-10-18": 6, "s1 2026-10-19": 6 };
    expect((await buildOwed([{ siteId: "s1" }], [ended, remade])).owed).toEqual(
      expected,
    );
    expect((await buildOwed([{ siteId: "s1" }], [remade, ended])).owed).toEqual(
      expected,
    );
  });

  it("starts owing at the first live term, past a cancelled one or an unreadable start", async () => {
    const { owed } = await buildOwed(
      [{ siteId: "s1" }],
      [
        terms("s1", "", { termsVersionId: "v-blank" }),
        terms("s1", "2026-10-01", { status: "cancelled" }),
        terms("s1", "2026-10-18"),
      ],
    );
    expect(owed).toEqual({ "s1 2026-10-18": 3, "s1 2026-10-19": 3 });
  });

  it("stops owing after the day a Site was closed, though its terms stay open", async () => {
    const { owed } = await buildOwed(
      [
        // Closed at 10 PM Pacific on Oct 16.
        {
          siteId: "s1",
          status: "inactive",
          updatedAt: "2026-10-17T05:00:00.000Z",
        },
        // Closed before its terms began.
        {
          siteId: "s2",
          status: "inactive",
          updatedAt: "2026-10-01T17:00:00.000Z",
        },
        // Closed, at a time that can't be read.
        { siteId: "s3", status: "inactive", updatedAt: "garbage" },
        // Closed Oct 15; a term sweep touched it again on Oct 19.
        {
          siteId: "s4",
          status: "inactive",
          deactivatedAt: "2026-10-15T20:00:00.000Z",
          updatedAt: "2026-10-19T20:00:00.000Z",
        },
      ],
      [
        terms("s1", "2026-10-15"),
        terms("s2", "2026-10-15"),
        terms("s3", "2026-10-15"),
        terms("s4", "2026-10-14"),
      ],
    );
    expect(owed).toEqual({
      "s1 2026-10-15": 3,
      "s1 2026-10-16": 3,
      "s4 2026-10-14": 3,
      "s4 2026-10-15": 3,
    });
  });

  it("stops at the snapshot's day and skips terms that start after it", async () => {
    const { owed } = await buildOwed(
      [
        { siteId: "s1" },
        { siteId: "s2" },
        // Closed after the snapshot, so it owes up to the snapshot's day.
        {
          siteId: "s3",
          status: "inactive",
          updatedAt: "2026-10-25T17:00:00.000Z",
        },
      ],
      [
        terms("s1", "2026-10-18"),
        terms("s2", "2026-10-25"),
        terms("s3", "2026-10-18"),
      ],
    );
    expect(owed).toEqual({
      "s1 2026-10-18": 3,
      "s1 2026-10-19": 3,
      "s3 2026-10-18": 3,
      "s3 2026-10-19": 3,
    });
  });

  it("ends on Pacific days across the November clock change", async () => {
    const { owed } = await buildOwed(
      [
        { siteId: "s1" },
        // Closed 11:30 PM Pacific on Oct 31, already Nov 1 in UTC.
        {
          siteId: "s2",
          status: "inactive",
          updatedAt: "2026-11-01T06:30:00.000Z",
        },
      ],
      [terms("s1", "2026-10-31"), terms("s2", "2026-10-31")],
      // 11:30 PM Pacific on Nov 1, already Nov 2 in UTC.
      "2026-11-02T07:30:00.000Z",
    );
    expect(owed).toEqual({
      "s1 2026-10-31": 3,
      "s1 2026-11-01": 3,
      "s2 2026-10-31": 3,
    });
  });

  it("agrees day by day with the Check report's own resolver", async () => {
    const site = { siteId: "s1" };
    const own = [
      terms("s1", "2026-09-01", { requiredChecksPerDay: 2 }),
      terms("s1", "2026-09-10", { status: "cancelled" }),
      terms("s1", "2026-09-20", {
        requiredChecksPerDay: 4,
        expiresOnExclusive: "2026-09-25",
      }),
      terms("s1", "2026-10-01", { requiredChecksPerDay: undefined }),
      terms("s1", "2026-10-10", { requiredChecksPerDay: 6 }),
    ];
    const { owed } = await buildOwed([site], own);
    const { owedOn } = checksOwedResolver(site, own, "2026-10-19");
    const days = dayKeysBetween("2026-09-01", addDays("2026-10-19", 1));
    expect(days.map((day) => owed[`s1 ${day}`] ?? 0)).toEqual(days.map(owedOn));
  });
});

/**
 * @param {string} siteId
 * @param {Record<string, any>} [extra]
 */
const lakeSite = (siteId, extra = {}) => ({
  pk: `SITE#${siteId}`,
  sk: "#META",
  siteId,
  status: "active",
  updatedAt: "2026-08-01T00:00:00.000Z",
  ...extra,
});

let version = 0;
/**
 * A COMPLIANCE_TERMS# item as the table stores it.
 * @param {string} siteId
 * @param {string} effectiveStart
 * @param {Record<string, any>} [extra]
 */
const lakeTerms = (siteId, effectiveStart, extra = {}) => {
  version += 1;
  const termsVersionId = `v${String(version).padStart(2, "0")}`;
  return {
    pk: `SITE#${siteId}`,
    sk: `COMPLIANCE_TERMS#2026-08-01#${termsVersionId}`,
    siteId,
    termsVersionId,
    effectiveStart,
    requiredChecksPerDay: 3,
    status: "active",
    createdAt: "2026-08-01T17:00:00.000Z",
    ...extra,
  };
};

// Term shapes the generator doesn't make: raises, expiries, cancellations,
// terms with no number, closed Sites and Sites with no terms.
const EDGE_ITEMS = [
  lakeSite("e01"),
  lakeTerms("e01", "2026-09-01", { requiredChecksPerDay: 2 }),
  lakeTerms("e01", "2026-09-05", {
    status: "cancelled",
    requiredChecksPerDay: 9,
  }),
  lakeTerms("e01", "2026-09-10", {
    requiredChecksPerDay: 5,
    expiresOnExclusive: "2026-09-15",
  }),
  lakeTerms("e01", "2026-09-20", { requiredChecksPerDay: undefined }),
  // Closed Sep 11; renamed after, which moved its updatedAt.
  lakeSite("e02", {
    status: "inactive",
    deactivatedAt: "2026-09-12T05:00:00.000Z",
    updatedAt: "2026-09-20T17:00:00.000Z",
  }),
  lakeTerms("e02", "2026-09-01"),
  lakeSite("e03", {
    status: "inactive",
    updatedAt: "2026-08-15T17:00:00.000Z",
  }),
  lakeTerms("e03", "2026-09-01"),
  lakeSite("e04"),
  lakeSite("e05", { status: "inactive" }),
  // Its only term was cancelled.
  lakeSite("e06"),
  lakeTerms("e06", "2026-09-01", { status: "cancelled" }),
  lakeSite("e07"),
  lakeTerms("e07", "2026-09-01", { requiredChecksPerDay: "7" }),
  lakeTerms("e07", "2026-09-08", { requiredChecksPerDay: 3.5 }),
  lakeTerms("e07", "2026-09-15", { requiredChecksPerDay: 0 }),
  lakeTerms("e07", "2026-09-22", { requiredChecksPerDay: -2 }),
  lakeSite("e08"),
  lakeTerms("e08", "2026-10-15"),
  // An empty end means no end.
  lakeSite("e09"),
  lakeTerms("e09", "2026-09-25", { expiresOnExclusive: "" }),
  lakeSite("e10", { status: "inactive", updatedAt: "garbage" }),
  lakeTerms("e10", "2026-09-01"),
];

/**
 * What the Check report's resolver owes each Site, cut at the close day each
 * fixture gives: when it was closed, or for older Sites its last update.
 * @param {Record<string, any>[]} items
 * @param {string} evaluatedAt
 */
function resolverOwed(items, evaluatedAt) {
  const today = pacificDateKey(evaluatedAt);
  const sites = items.filter(
    (i) => i.sk === "#META" && String(i.pk).startsWith("SITE#"),
  );
  const allTerms = items.filter((i) =>
    String(i.sk).startsWith("COMPLIANCE_TERMS#"),
  );
  /** @type {Record<string, number>} */
  const owed = {};
  for (const site of sites) {
    const own = allTerms.filter((t) => t.siteId === site.siteId);
    const starts = own
      .map((t) => t.effectiveStart)
      .filter(Boolean)
      .sort();
    if (!starts.length) continue;
    const last =
      site.status === "inactive"
        ? pacificDateKey(site.deactivatedAt ?? site.updatedAt)
        : today;
    if (!last) continue;
    const { owedOn } = checksOwedResolver(site, own, today);
    const end = addDays(last < today ? last : today, 1);
    for (const day of dayKeysBetween(starts[0], end)) {
      const n = owedOn(day);
      if (n) owed[`${site.siteId} ${day}`] = n;
    }
  }
  return owed;
}

const LAKES = [
  {
    name: "edge-case terms",
    lake: () => ({
      items: EDGE_ITEMS,
      evaluatedAt: "2026-10-01T12:00:00.000Z",
    }),
  },
  {
    name: "the small synthetic year",
    lake: () =>
      generateYear({ seed: 7, sites: PROFILES.length, startDay: "2026-09-01" }),
  },
  {
    name: "seed 14 with 30 Sites",
    lake: () => generateYear({ seed: 14, sites: 30, startDay: "2026-09-01" }),
  },
];

// Read through the lake's own views, so a wrong JSON path in projection.js fails here.
describe.each(LAKES)("checks_owed from the lake, on $name", ({ lake }) => {
  /** @type {any} */
  let conn;
  /** @type {string} */
  let dir;
  /** @type {Record<string, number>} */
  let owed;
  /** @type {{ items: Record<string, any>[], evaluatedAt: string }} */
  let generated;

  beforeAll(async () => {
    generated = lake();
    conn = await (await DuckDBInstance.create(":memory:")).connect();
    await conn.run("SET memory_limit = '1GB'");
    dir = mkdtempSync(join(tmpdir(), "insights-owed-lake-"));
    await writeLocalLake(conn, join(dir, "lake"), generated.items, {
      exportedAt: generated.evaluatedAt,
      exportId: "gen",
    });
    await createLocalViews(conn, join(dir, "lake"));
    await buildProjection(conn, join(dir, "out"), {
      evaluatedAt: generated.evaluatedAt,
      snapshotId: "gen",
    });
    const tables = await readProjection(conn, join(dir, "out"));
    owed = Object.fromEntries(
      tables.checks_owed.map((r) => [`${r.siteId} ${r.day}`, r.checksOwed]),
    );
  });

  afterAll(() => {
    conn.closeSync();
    rmSync(dir, { recursive: true, force: true });
  });

  it("owes what the Check report's resolver owes, up to each Site's close", () => {
    const expected = resolverOwed(generated.items, generated.evaluatedAt);
    expect(Object.keys(expected).length).toBeGreaterThan(0);
    expect(owed).toEqual(expected);
  });
});

it("reads which same-day version was made later from the lake", async () => {
  const items = [
    lakeSite("s1"),
    lakeTerms("s1", "2026-09-30", { createdAt: "2026-09-30T16:00:00.000Z" }),
    lakeTerms("s1", "2026-09-30", {
      createdAt: "2026-09-30T18:00:00.000Z",
      requiredChecksPerDay: 6,
    }),
  ];
  const conn = await (await DuckDBInstance.create(":memory:")).connect();
  const dir = mkdtempSync(join(tmpdir(), "insights-owed-lake-"));
  try {
    const evaluatedAt = "2026-10-01T12:00:00.000Z";
    await writeLocalLake(conn, join(dir, "lake"), items, {
      exportedAt: evaluatedAt,
      exportId: "gen",
    });
    await createLocalViews(conn, join(dir, "lake"));
    await buildProjection(conn, join(dir, "out"), {
      evaluatedAt,
      snapshotId: "gen",
    });
    const { checks_owed } = await readProjection(conn, join(dir, "out"));
    expect(checks_owed.map((r) => [r.day, r.checksOwed])).toEqual([
      ["2026-09-30", 6],
      ["2026-10-01", 6],
    ]);
  } finally {
    conn.closeSync();
    rmSync(dir, { recursive: true, force: true });
  }
});
