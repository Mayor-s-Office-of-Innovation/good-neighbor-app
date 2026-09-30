import { describe, expect, it } from "vitest";
import { formatPacificUpdated } from "./task-updates.js";

describe("formatPacificUpdated", () => {
  it("uses Monday as the current-week boundary", () => {
    const now = new Date("2026-09-30T19:00:00.000Z"); // Wednesday noon PT
    expect(formatPacificUpdated("2026-09-29T19:00:00.000Z", now)).toContain("yesterday");
    expect(formatPacificUpdated("2026-09-28T19:00:00.000Z", now)).toContain("Monday");
    expect(formatPacificUpdated("2026-09-27T19:00:00.000Z", now)).toContain("09/27/2026");
  });
});
