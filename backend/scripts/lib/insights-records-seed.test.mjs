import { describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  PROFILES,
  generateYear,
} from "../../src/reporting/synthetic/generate.js";
import { recordRows, syntheticPhoto } from "./insights-records-seed.mjs";

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
        ).toMatch(/^synthetic\/photos\//);
    }
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
    expect([thumb.width, thumb.height]).toEqual([320, 240]);
  });
});
