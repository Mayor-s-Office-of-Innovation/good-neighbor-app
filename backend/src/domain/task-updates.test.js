import { describe, expect, it } from "vitest";
import {
  notePhotoLabel,
  presencePeriod,
  presencePromptDue,
  qualifyingAction,
  responseExpectedAt,
} from "./task-updates.js";

describe("task updates", () => {
  it("recognizes only the four confirmed escalation labels", () => {
    expect(qualifyingAction("We called SFACC")).toMatchObject({
      agency: "SFACC",
      label: "Called SFACC",
    });
    expect(qualifyingAction("Call SFACC")).toBeNull();
  });

  it("uses fixed four-hour periods from the original start", () => {
    const start = "2026-11-01T08:30:00.000Z";
    expect(presencePeriod(start, "2026-11-01T12:29:59.999Z")).toBe(0);
    expect(presencePeriod(start, "2026-11-01T12:30:00.000Z")).toBe(1);
    expect(
      presencePromptDue(
        { status: "in_progress", inProgressAt: start, lastAnsweredPresencePeriod: 1 },
        "2026-11-01T16:30:00.000Z",
      ),
    ).toBe(true);
  });

  it("maps note/photo combinations without counts", () => {
    expect(notePhotoLabel(["a"], [])).toBe("Updated with note");
    expect(notePhotoLabel([], ["a", "b"])).toBe("Updated with photos");
    expect(notePhotoLabel(["a"], ["b"])).toBe("Updated with photos and notes");
  });

  it("derives the response deadline in elapsed hours", () => {
    expect(
      responseExpectedAt({
        notifiedAt: "2026-09-29T20:00:00.000Z",
        maxAcceptableResponseHours: 4,
      }),
    ).toBe("2026-09-30T00:00:00.000Z");
  });
});
