import { describe, expect, it } from "vitest";
import { formatPhotoDateTime, photoLocation } from "./photo-lightbox.js";
import { t } from "../i18n/i18n.js";
import { formatDateTime, formatTime, formatWeekday } from "../i18n/dates.js";

describe("formatPhotoDateTime", () => {
  // A Thursday, 12:00 PM Pacific.
  const now = new Date("2026-10-01T19:00:00Z");

  it("uses relative labels within the current Monday-based calendar week", () => {
    const today = "2026-10-01T18:59:00Z";
    expect(formatPhotoDateTime(today, now)).toBe(
      t("card.time.today", { time: formatTime(today) }),
    );
    // Pacific time, not UTC.
    expect(formatPhotoDateTime(today, now)).toContain("11:59");
    const yesterday = "2026-09-30T18:59:00Z";
    expect(formatPhotoDateTime(yesterday, now)).toBe(
      t("lightbox.time.yesterday", { time: formatTime(yesterday) }),
    );
    const tuesday = "2026-09-29T18:59:00Z";
    expect(formatPhotoDateTime(tuesday, now)).toBe(
      t("lightbox.time.weekday", {
        day: formatWeekday(tuesday),
        time: formatTime(tuesday),
      }),
    );
  });

  it("uses a numeric date before the current calendar week", () => {
    const sunday = "2026-09-27T18:59:00Z";
    expect(formatPhotoDateTime(sunday, now)).toBe(
      t("card.time.date", {
        date: formatDateTime(sunday, {
          month: "2-digit",
          day: "2-digit",
          year: "numeric",
        }),
        time: formatTime(sunday),
      }),
    );
    expect(formatPhotoDateTime(sunday, now)).toContain("09/27/2026");
  });

  it("returns an empty string for an unparseable timestamp", () => {
    expect(formatPhotoDateTime("not a date", now)).toBe("");
  });
});

describe("photoLocation", () => {
  it("prefers the first line of the georeferenced address", () => {
    expect(photoLocation("15th Street, San Francisco", "City Hall")).toBe(
      "15th Street",
    );
  });

  it("falls back to the first line of the site address", () => {
    expect(
      photoLocation("", "1 Dr Carlton B Goodlett Place\nSan Francisco"),
    ).toBe("1 Dr Carlton B Goodlett Place");
  });
});
