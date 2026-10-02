import { describe, expect, it } from "vitest";
import { t } from "../i18n/i18n.js";
import { formatDateTime, formatTime, formatWeekday } from "../i18n/dates.js";
import { formatPacificUpdated } from "./task-updates.js";

describe("formatPacificUpdated", () => {
  it("uses Monday as the current-week boundary", () => {
    const now = new Date("2026-09-30T19:00:00.000Z"); // Wednesday noon PT
    expect(formatPacificUpdated("2026-09-29T19:00:00.000Z", now)).toContain(
      t("date.yesterday"),
    );
    expect(formatPacificUpdated("2026-09-28T19:00:00.000Z", now)).toContain(
      formatWeekday("2026-09-28T19:00:00.000Z"),
    );
    expect(formatPacificUpdated("2026-09-27T19:00:00.000Z", now)).toContain(
      formatDateTime("2026-09-27T19:00:00.000Z", {
        month: "2-digit",
        day: "2-digit",
        year: "numeric",
      }),
    );
  });

  it("composes the sentence from the day word and the time", () => {
    const now = new Date("2026-09-30T19:00:00.000Z");
    const value = "2026-09-30T16:05:00.000Z";
    expect(formatPacificUpdated(value, now)).toBe(
      t("taskUpdate.updatedAt", {
        day: t("date.today"),
        time: formatTime(value),
      }),
    );
    expect(formatPacificUpdated("not a date", now)).toBe("");
  });
});
