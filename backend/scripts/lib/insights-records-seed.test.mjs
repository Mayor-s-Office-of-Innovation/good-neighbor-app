import { describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  PROFILES,
  generateYear,
} from "../../src/reporting/synthetic/generate.js";
import {
  PHOTO_POOL,
  poolIndex,
  recordRows,
  syntheticPhoto,
  syntheticPhotoKey,
} from "./insights-records-seed.mjs";

const { items } = generateYear({
  seed: 7,
  sites: PROFILES.length,
  startDay: "2026-09-01",
});
const rows = recordRows(items);
const bySk = new Map(rows.map((r) => [`${r.pk}|${r.sk}`, r]));

describe("recordRows", () => {
  it("resolves every photo the record panels look up", () => {
    const tasks = rows.filter((r) => /^TASK#[^#]+$/.test(r.sk));
    expect(tasks.length).toBeGreaterThan(0);
    for (const task of tasks)
      for (const artifactId of task.sourceArtifactIds)
        expect(
          bySk.get(`${task.pk}|CHECK#${task.checkId}#ART#${artifactId}`),
        ).toBeDefined();
    const updates = rows.filter((r) => r.photoKeys);
    expect(updates.length).toBeGreaterThan(0);
    for (const update of updates) {
      const taskId = update.sk.split("#")[1];
      for (const id of update.photoKeys)
        expect(
          bySk.get(`${update.pk}|TASK#${taskId}#MEDIA#${id}`)?.s3Key,
        ).toMatch(/^checks\//);
    }
  });

  it("keeps the links that put duplicates and follow-ups in their Issue", () => {
    const links = rows.filter((r) => r.sk.startsWith("DUP_LINK#"));
    const conditions = rows.filter((r) => /#COND#/.test(r.sk));
    expect(links.length).toBeGreaterThan(0);
    expect(conditions.length).toBeGreaterThan(0);
    for (const link of links)
      for (const id of [link.taskId, link.originalTaskId])
        expect(bySk.get(`${link.pk}|TASK#${id}`)).toBeDefined();
    const onCondition = rows.filter(
      (r) => /^TASK#[^#]+$/.test(r.sk) && r.conditionId,
    );
    expect(onCondition.length).toBeGreaterThan(0);
  });

  it("spreads photos over every pooled image", () => {
    const keys = rows.flatMap((r) => (r.s3Key ? [r.s3Key] : []));
    const used = new Set(
      keys.map((k) => syntheticPhotoKey("check", poolIndex(k))),
    );
    expect(used.size).toBe(PHOTO_POOL);
  });

  it("drops the fields the dev table's worklists index", () => {
    expect(rows.some((r) => "status" in r || "gsi1pk" in r)).toBe(false);
    expect(rows.length).toBeLessThan(items.length);
  });
});

describe("syntheticPhoto", () => {
  it("makes a JPEG at full and thumbnail size", async () => {
    const full = await sharp(
      await syntheticPhoto("check", 0, false),
    ).metadata();
    const thumb = await sharp(
      await syntheticPhoto("update", 5, true),
    ).metadata();
    expect([full.format, full.width, full.height]).toEqual(["jpeg", 1280, 960]);
    expect([thumb.format, thumb.width, thumb.height]).toEqual([
      "webp",
      320,
      240,
    ]);
  });
});
