import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { classifyItem } from "../../analytics/entity-keys.js";
import { pacificDateKey, pacificDayStartIso } from "../../lib/pacific-dates.js";
import { createLocalViews, writeLocalLake } from "../local-lake.js";
import { buildProjection } from "../projection.js";
import { readProjection } from "../test-build.js";
import { RESPONSE_STATES } from "../contract.js";
import {
  CALM,
  PROFILES,
  generateYear,
  profileOf,
  syntheticSite,
} from "./generate.js";
import { compareWithAnswers } from "./verify.js";

// Two months across the fall-back, one Site per pattern: small enough for
// the unit suite, and every rule still gets exercised.
const SMALL = { seed: 7, sites: PROFILES.length, startDay: "2026-09-01" };

describe("generateYear", () => {
  const { items, answers } = generateYear(SMALL);

  it("makes the same records for the same seed", () => {
    expect(generateYear(SMALL).items).toEqual(items);
    expect(generateYear({ ...SMALL, seed: 8 }).items).not.toEqual(items);
  });

  it("never repeats a table key, so a load can't overwrite a record", () => {
    const keys = items.map((i) => `${i.pk}|${i.sk}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("covers each record kind the counting rules must handle", () => {
    const sk = (/** @type {RegExp} */ re) =>
      items.filter((i) => re.test(i.sk)).length;
    expect(sk(/^TASK#[^#]+$/)).toBeGreaterThan(0);
    expect(sk(/^TASK#.+#UPDATE#/)).toBeGreaterThan(0);
    expect(sk(/^TASK#.+#MEDIA#/)).toBeGreaterThan(0);
    expect(sk(/#UPDATE_MEDIA#/)).toBeGreaterThan(0);
    expect(sk(/^DUP_LINK#/)).toBeGreaterThan(0);
    expect(sk(/^DUP_OVERRIDE#/)).toBeGreaterThan(0);
    expect(sk(/^SF311_JOB#/)).toBeGreaterThan(0);
    expect(
      items.filter((i) => i.supersededByAssessmentId).length,
    ).toBeGreaterThan(0);
    const reasons = new Set(items.map((i) => i.supersessionReason));
    expect(reasons).toContain("issue_deleted");
    expect(reasons).toContain("assessment_refreshed");
    // A kept task under a replaced assessment, which must still count.
    const replaced = new Set(
      items
        .filter((i) => i.supersededByAssessmentId)
        .map((i) => i.assessmentId),
    );
    expect(
      items.some(
        (i) =>
          /^TASK#[^#]+$/.test(i.sk) &&
          replaced.has(i.assessmentId) &&
          i.status !== "superseded",
      ),
    ).toBe(true);
    expect(
      items.filter((i) => i.flowType === "single-problem").length,
    ).toBeGreaterThan(0);
  });

  it("uses only example.org emails and phone numbers kept for fiction", () => {
    const text = JSON.stringify(items);
    const emails = text.match(/[\w.+-]+@[\w.-]+/g) ?? [];
    expect(emails.length).toBeGreaterThan(0);
    expect(emails.every((e) => e.endsWith("@example.org"))).toBe(true);
    const phones = text.match(/\d{3}-\d{3}-\d{4}/g) ?? [];
    expect(phones.length).toBeGreaterThan(0);
    expect(phones.every((p) => /^\d{3}-555-01\d\d$/.test(p))).toBe(true);
  });

  it("covers everything the field app can record", () => {
    const headers = items.filter((i) => /^CHECK#[^#]+$/.test(i.sk));
    const photoCounts = new Set(headers.map((h) => h.photoCount));
    // Checks with no photo, one photo and several.
    expect(photoCounts).toContain(0);
    expect(photoCounts).toContain(1);
    expect([...photoCounts].some((n) => n >= 3)).toBe(true);
    expect(new Set(headers.map((h) => h.evidenceKind))).toEqual(
      new Set([undefined, "photos", "description", "mixed"]),
    );
    const tasks = items.filter((i) => /^TASK#[^#]+$/.test(i.sk));
    expect(new Set(tasks.map((t) => t.severity))).toEqual(
      new Set([1, 2, 3, 4, 5]),
    );
    const updates = items.filter((i) => /^TASK#.+#UPDATE#/.test(i.sk));
    const shapes = new Set(
      updates.map((u) => `${u.notes?.length ?? 0}/${u.photoKeys?.length ?? 0}`),
    );
    for (const shape of ["0/0", "0/1", "1/0", "1/1", "2/2"])
      expect(shapes).toContain(shape);
    expect(updates.some((u) => u.type === "resolution_proof")).toBe(true);
    // The photo routes sign only keys under the photo's own Site and Check.
    const keyed = items.filter((i) => i.s3Key);
    expect(keyed.length).toBeGreaterThan(0);
    for (const i of keyed) {
      const prefix = `checks/${i.pk.slice(5)}/${i.checkId}/`;
      expect(i.s3Key).toBe(`${prefix}${i.artifactId}`);
      expect(i.thumbS3Key).toBe(`${i.s3Key}.thumb.webp`);
    }
    // An unfinished Check holds only what the app writes when it starts.
    const unfinished = items.filter(
      (i) => /^CHECK#[^#]+$/.test(i.sk) && i.status === "in_progress",
    );
    expect(unfinished.length).toBeGreaterThan(0);
    for (const header of unfinished) {
      expect(header).not.toHaveProperty("rubricVersion");
      expect(header).not.toHaveProperty("categories");
    }
  });

  it("names each Site once, as a fictional place marked Synthetic", () => {
    const sites = Array.from({ length: 500 }, (_, s) => syntheticSite(s));
    expect(new Set(sites.map((x) => x.name)).size).toBe(500);
    expect(sites.every((x) => x.name.endsWith(" (Synthetic)"))).toBe(true);
    expect(sites.slice(0, 3).map((x) => x.name)).toEqual([
      "Rivendell Navigation Center (Synthetic)",
      "Bree Street Supportive Housing (Synthetic)",
      "Hobbiton Drop-in Center (Synthetic)",
    ]);
    // The app's own site types, so Manage's type filter reads them.
    expect(new Set(sites.map((x) => x.siteType))).toEqual(
      new Set(["shelter", "permanent_supportive_housing", "drop_in", "other"]),
    );
    const meta = items.filter((i) => i.sk === "#META" && i.type === "site");
    expect(meta.map((i) => i.name)).toEqual(
      meta.map((_, s) => syntheticSite(s).name),
    );
  });

  it("always includes one Site whose stored contact can't be read", () => {
    for (const sites of [11, 18])
      expect(
        Object.values(generateYear({ ...SMALL, sites }).answers.contacts).some(
          (c) => c.publicContact === "unknown",
        ),
      ).toBe(true);
  });

  it("never records staff action on a deleted card", () => {
    const deleted = new Set(
      items
        .filter((i) => i.supersessionReason === "issue_deleted")
        .map((i) => i.taskId),
    );
    expect(deleted.size).toBeGreaterThan(0);
    expect(
      items.filter((i) => /#UPDATE#/.test(i.sk) && deleted.has(i.taskId)),
    ).toEqual([]);
  });

  it("starts no Check after its Site was archived", () => {
    // Several seeds, since a late Check on the last day is rare.
    const late = [1, 2, 3, 4, 5, 6].flatMap((seed) => {
      const all = generateYear({ ...SMALL, seed }).items;
      const archivedAt = new Map(
        all
          .filter((i) => i.sk === "#META" && i.type === "site")
          .filter((i) => i.status === "inactive")
          .map((i) => [i.pk, Date.parse(i.updatedAt)]),
      );
      expect(archivedAt.size).toBeGreaterThan(0);
      return all.filter(
        (i) =>
          /^CHECK#[^#]+$/.test(i.sk) &&
          archivedAt.has(i.pk) &&
          Date.parse(i.startedAt) > Number(archivedAt.get(i.pk)),
      );
    });
    expect(late).toEqual([]);
  });

  it("files a Check that ends after midnight on the day it ended", () => {
    const long = generateYear({ ...SMALL, photosPerCheck: [30, 40] }).items;
    const rows = long.filter((i) => i.sk.startsWith("CHECK_COMPLETION#"));
    const started = new Map(
      long
        .filter((i) => /^CHECK#[^#]+$/.test(i.sk))
        .map((i) => [i.checkId, pacificDateKey(i.startedAt)]),
    );
    expect(
      rows.some((i) => started.get(i.checkId) !== i.sk.split("#")[1]),
    ).toBe(true);
    expect(
      rows.filter((i) => i.sk.split("#")[1] !== pacificDateKey(i.completedAt)),
    ).toEqual([]);
  });

  it("gives every card its own short ID and dates each replacement", () => {
    const tasks = items.filter((i) => /^TASK#[^#]+$/.test(i.sk));
    const ids = tasks.map((t) => `${t.pk}|${t.shortId}`);
    expect(new Set(ids).size).toBe(ids.length);
    expect(
      tasks.filter((t) => t.status === "superseded" && !t.supersededAt),
    ).toEqual([]);
  });

  it("refuses a start day after the evaluation day", () => {
    expect(() => generateYear({ ...SMALL, startDay: "2027-01-01" })).toThrow(
      "startDay",
    );
  });

  it("gives each Site its pattern and every response state an example", () => {
    expect(Object.values(answers.profiles)).toEqual(PROFILES.map((p) => p.key));
    const months = Object.values(answers.bySiteMonth);
    for (const state of RESPONSE_STATES)
      expect(months.some((m) => m[state] > 0)).toBe(true);
  });

  it("has a perimeter Check within an hour of midnight on the fall-back day", () => {
    const fallBack = items.filter(
      (i) =>
        i.flowType === "perimeter" &&
        i.startedAt >= "2026-11-01T07:00:00.000Z" &&
        i.startedAt < "2026-11-01T08:00:00.000Z",
    );
    expect(fallBack.length).toBeGreaterThan(0);
  });
});

describe("projection over generated records", () => {
  /** @type {any} */
  let conn;
  /** @type {string} */
  let dir;
  const generated = generateYear(SMALL);

  /**
   * @param {Record<string, any>[]} items
   * @param {string} name
   * @returns {Promise<Record<string, Record<string, any>[]>>}
   */
  const project = async (items, name) => {
    const lake = join(dir, name, "lake");
    const out = join(dir, name, "projection");
    await writeLocalLake(conn, lake, items, {
      exportedAt: generated.evaluatedAt,
      exportId: "gen",
    });
    await createLocalViews(conn, lake);
    await buildProjection(conn, out, {
      evaluatedAt: generated.evaluatedAt,
      snapshotId: "gen",
    });
    return readProjection(conn, out);
  };

  beforeAll(async () => {
    conn = await (await DuckDBInstance.create(":memory:")).connect();
    await conn.run("SET memory_limit = '1GB'");
    dir = mkdtempSync(join(tmpdir(), "insights-generated-"));
  });

  afterAll(() => {
    conn.closeSync();
    rmSync(dir, { recursive: true, force: true });
  });

  it("matches the answers for every Site, month and count", async () => {
    const tables = await project(generated.items, "as-generated");
    const result = compareWithAnswers(
      /** @type {any} */ (tables),
      generated.answers,
    );
    expect(result.mismatches).toEqual([]);
    expect(result.checked).toBeGreaterThan(100);
  });

  it("flags a contact row for a Site the answers don't know", () => {
    const result = compareWithAnswers(
      {
        site_days: [],
        site_contacts: [
          { siteId: "extra", publicContact: "available", siteContact: "x" },
        ],
      },
      { bySiteMonth: {}, contacts: {}, profiles: {} },
    );
    expect(result.mismatches).toHaveLength(2);
  });

  it("would catch a counting rule that also counted update rows", async () => {
    // Each update stored as one more task, the way a loose classifier would read it.
    const phantom = generated.items
      .filter((i) => classifyItem(i) === "task_updates")
      .map((i) => ({
        pk: i.pk,
        sk: `TASK#${i.taskId}-${i.updateId}`,
        taskId: `${i.taskId}-${i.updateId}`,
        status: "open",
        createdAt: i.occurredAt,
      }));
    const tables = await project([...generated.items, ...phantom], "phantom");
    expect(
      compareWithAnswers(
        /** @type {any} */ (tables),
        generated.answers,
      ).mismatches.some((m) => m.includes("issuesCreated")),
    ).toBe(true);
  });
});

describe("unfinished Checks in the answer key", () => {
  // Seed 14 starts an unfinished Check at Pacific midnight on Oct 1, where
  // the generator's loop day (Sep 30) and the Pacific day disagree.
  const { items, answers } = generateYear({
    seed: 14,
    sites: 30,
    startDay: "2026-09-01",
  });

  // Without this Check, the month test below cannot catch a wrong month.
  it("starts one in the first hour of a Pacific month", () => {
    const HOUR_MS = 60 * 60 * 1000;
    const atMidnight = items.some((i) => {
      if (i.flowType !== "perimeter" || i.status !== "in_progress")
        return false;
      const day = pacificDateKey(i.startedAt);
      if (!day.endsWith("-01")) return false;
      const sinceMidnight =
        Date.parse(i.startedAt) - Date.parse(pacificDayStartIso(day));
      return sinceMidnight >= 0 && sinceMidnight < HOUR_MS;
    });
    expect(atMidnight).toBe(true);
  });

  it("counts each one in the Pacific month it started", () => {
    /** @type {Record<string, number>} */
    const counted = {};
    for (const i of items)
      if (i.flowType === "perimeter" && i.status === "in_progress") {
        const site = i.checkId.replace(/-c\d+$/, "");
        const key = `${site}|${pacificDateKey(i.startedAt).slice(0, 7)}`;
        counted[key] = (counted[key] ?? 0) + 1;
      }
    const expected = Object.fromEntries(
      Object.entries(answers.bySiteMonth)
        .filter(([, m]) => m.unfinishedChecks > 0)
        .map(([key, m]) => [key, m.unfinishedChecks]),
    );
    expect(counted).toEqual(expected);
  });
});

describe("profileOf", () => {
  it("cycles every profile in a small year", () => {
    const keys = Array.from({ length: 24 }, (_, s) => profileOf(s, 24).key);
    expect(new Set(keys)).toEqual(new Set(PROFILES.map((p) => p.key)));
  });

  it("makes 9 in 10 Sites calm in a large year, keeping every other profile", () => {
    const keys = Array.from({ length: 500 }, (_, s) => profileOf(s, 500).key);
    expect(keys.filter((k) => k === CALM.key)).toHaveLength(450);
    expect(new Set(keys)).toEqual(
      new Set([CALM.key, ...PROFILES.map((p) => p.key)]),
    );
  });
});
