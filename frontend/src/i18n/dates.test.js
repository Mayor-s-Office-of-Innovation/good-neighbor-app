import { afterEach, describe, expect, it } from "vitest";

import {
  formatMonthDay,
  pacificWeekdayIndex,
  formatNumericDate,
  formatTime,
  formatWeekday,
  pacificDaysAgo,
} from "./dates.js";
import { setLocale } from "./i18n.js";

// 2026-10-02T22:05:00Z is 3:05 PM Pacific (PDT) on Friday 2 October.
const ISO = "2026-10-02T22:05:00Z";

afterEach(async () => {
  await setLocale("en");
});

describe("dates", () => {
  it("formats in Pacific time with US conventions in English", () => {
    expect(formatTime(ISO)).toBe("3:05 PM");
    expect(formatWeekday(ISO)).toBe("Friday");
    expect(formatMonthDay(ISO)).toBe("Oct 2");
    expect(formatNumericDate(ISO)).toBe("10/02/26");
  });

  it("keeps US conventions but translates names in another locale", async () => {
    await setLocale("es");
    expect(formatWeekday(ISO).toLowerCase()).toBe("viernes");
    expect(formatTime(ISO)).toMatch(/3:05/);
  });

  it("keeps the 12-hour clock in locales that default to 24-hour time", async () => {
    await setLocale("vi");
    expect(formatTime(ISO)).toMatch(/3:05/);
    expect(formatTime(ISO)).not.toMatch(/15:05/);
  });

  it("reports the Pacific weekday without any locale text", () => {
    expect(pacificWeekdayIndex(ISO)).toBe(5); // Friday 2 Oct 2026, Pacific
    expect(pacificWeekdayIndex("2026-10-04T06:30:00Z")).toBe(6); // still Sat 3 Oct PT
    expect(pacificWeekdayIndex("bad")).toBeNull();
  });

  it("returns an empty string for unparseable input", () => {
    expect(formatTime("not a date")).toBe("");
  });

  it("counts whole Pacific days between instants", () => {
    const now = new Date("2026-10-03T06:30:00Z"); // still 2 Oct 11:30 PM Pacific
    expect(pacificDaysAgo(ISO, now)).toBe(0);
    expect(pacificDaysAgo(ISO, new Date("2026-10-03T08:00:00Z"))).toBe(1);
    expect(pacificDaysAgo("bad", now)).toBeNull();
  });
});
