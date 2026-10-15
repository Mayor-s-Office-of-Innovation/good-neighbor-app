import { describe, expect, it } from "vitest";
import { t } from "../i18n/i18n.js";
import {
  careCompose,
  careDetail,
  careList,
  careOptions,
} from "./care-work.templates.js";
import { groupCareWork, careDay } from "../domain/care-work.js";
const entry = {
  workId: "one",
  kind: "power_washed",
  note: "",
  createdAt: "2026-10-16T06:30:00Z",
  photos: [],
};
describe("proactive care screens", () => {
  it("allows fixed work without evidence but requires a custom description", () => {
    expect(careCompose({ ...entry, files: [] })).not.toMatch(
      /data-save\s+disabled/,
    );
    expect(careCompose({ ...entry, kind: "other", files: [] })).toMatch(
      /data-save\s+disabled/,
    );
    expect(
      careCompose({ ...entry, kind: "other", note: "Swept", files: [] }),
    ).not.toMatch(/data-save\s+disabled/);
    expect(careCompose({ ...entry, files: [] }, true)).toMatch(
      /data-save\s+disabled/,
    );
  });
  it("offers seven fixed types and something else with localized titles", () => {
    const markup = careOptions();
    expect(markup.match(/data-kind=/g)).toHaveLength(8);
    expect(markup).toContain(t("care.kind.calledHauler"));
  });
  it("groups by Pacific day rather than UTC, keeps years distinct and sorts newest first", () => {
    const groups = groupCareWork([
      entry,
      { ...entry, workId: "two", createdAt: "2026-10-16T07:30:00Z" },
      { ...entry, workId: "three", createdAt: "2026-10-16T05:30:00Z" },
    ]);
    expect(
      groups.map((group) => group.items.map((item) => item.workId)),
    ).toEqual([["two"], ["one", "three"]]);
    expect(careDay(entry.createdAt, new Date("2026-10-16T07:30:00Z"))).toBe(
      t("card.history.yesterday"),
    );
  });
  it("escapes user text, never offers edit/delete, and explains expired photos", () => {
    const markup = careDetail({
      ...entry,
      kind: "other",
      note: '<img src=x onerror="evil()">',
      photos: [{ expiresAt: 0 }],
    });
    expect(markup).toContain("&lt;img");
    expect(markup).not.toContain("<img src=x");
    expect(markup).toContain(t("care.photo.expired"));
    expect(markup).not.toMatch(/data-(edit|delete|save)/);
    expect(markup).not.toContain("Where");
    expect(careList([entry])).toContain(t("care.new"));
  });
});
