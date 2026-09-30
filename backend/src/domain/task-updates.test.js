import { describe, expect, it } from "vitest";
import {
  buildTaskUpdateTransition,
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
        {
          status: "in_progress",
          inProgressAt: start,
          lastAnsweredPresencePeriod: 1,
        },
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

  it.each([undefined, null, 0, -1, "not-a-number"])(
    "does not derive a response deadline from %s hours",
    (maxAcceptableResponseHours) => {
      expect(
        responseExpectedAt({
          notifiedAt: "2026-09-29T20:00:00.000Z",
          maxAcceptableResponseHours,
        }),
      ).toBeNull();
    },
  );

  it("builds task and timeline snapshots without persistence concerns", () => {
    const result = buildTaskUpdateTransition(
      {
        status: "in_progress",
        inProgressAt: "2026-09-30T08:00:00.000Z",
        lastAnsweredPresencePeriod: 0,
      },
      { type: "presence_resolved" },
      {
        taskId: "task-1",
        updateId: "update-1",
        actorId: "user-1",
        now: new Date("2026-09-30T12:00:00.000Z"),
      },
    );

    expect(result).toMatchObject({
      update: {
        type: "presence_resolved",
        label: "Site team marked as resolved",
        documentationState: "open_for_documentation",
      },
      task: {
        status: "completed",
        latestUpdateLabel: "Resolved",
        completionMethod: "site_team_resolved",
      },
    });
  });
});
