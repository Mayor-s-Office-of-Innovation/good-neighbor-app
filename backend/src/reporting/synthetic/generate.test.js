import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { classifyItem } from "../../analytics/entity-keys.js";
import { pacificDateKey } from "../../lib/pacific-dates.js";
import { createLocalViews, writeLocalLake } from "../local-lake.js";
import { buildProjection, readLakeInputs } from "../projection.js";
import { RESPONSE_STATES } from "../contract.js";
import { PROFILES, generateYear } from "./generate.js";
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

  beforeAll(async () => {
    conn = await (await DuckDBInstance.create(":memory:")).connect();
    dir = mkdtempSync(join(tmpdir(), "insights-generated-"));
    await writeLocalLake(conn, dir, generated.items, {
      exportedAt: generated.evaluatedAt,
      exportId: "gen",
    });
    await createLocalViews(conn, dir);
  });

  afterAll(() => {
    conn.closeSync();
    rmSync(dir, { recursive: true, force: true });
  });

  it("matches the answers for every Site, month and count", async () => {
    const { tables } = buildProjection(await readLakeInputs(conn), {
      evaluatedAt: generated.evaluatedAt,
      snapshotId: "gen",
    });
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
    const lake = await readLakeInputs(conn);
    // Each update read as one more task, the way a loose classifier would.
    const phantom = generated.items
      .filter((i) => classifyItem(i) === "task_updates")
      .map((i) => ({
        ...i,
        taskId: `${i.taskId}-${i.updateId}`,
        siteId: i.pk.slice(5),
        status: "open",
        createdAt: i.occurredAt,
      }));
    lake.inputs.tasks.push(.../** @type {any[]} */ (phantom));
    const { tables } = buildProjection(lake, {
      evaluatedAt: generated.evaluatedAt,
      snapshotId: "gen",
    });
    expect(
      compareWithAnswers(
        /** @type {any} */ (tables),
        generated.answers,
      ).mismatches.some((m) => m.includes("issuesCreated")),
    ).toBe(true);
  });
});
