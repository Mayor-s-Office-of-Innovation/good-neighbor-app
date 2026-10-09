import { describe, expect, it } from "vitest";
import {
  buildTaskUpdateTransition,
  notePhotoLabel,
  presencePeriod,
  presencePromptDue,
  responseExpectedAt,
} from "./task-updates.js";

describe("task updates", () => {
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

it.each([
  { type: "note_photo_update", notes: ["Still here"], photoKeys: ["photo-1"] },
  { type: "additional_action", text: "Called the agency", photoKeys: [] },
])("keeps submitted 311 issues open for $type", (input) => {
  const ticket = {
    code: "create_311_ticket",
    payload: { tickets: [{ srNum: "123" }] },
  };
  const result = buildTaskUpdateTransition(
    { status: "in_progress", appActionResults: [ticket] },
    input,
    { taskId: "t1", updateId: "u1", actorId: "a1" },
  );
  expect(result).toMatchObject({
    task: { status: "in_progress", appActionResults: [ticket] },
    update: { type: input.type, documentationState: "closed" },
  });
  if ("error" in result) throw new Error(result.error);
  expect(result.update.notes || []).toEqual(input.notes || []);
  expect(result.update.photoKeys || []).toEqual(input.photoKeys);
  expect(result.update.text).toBe(input.text);
  expect(result.task).not.toHaveProperty("resolvedAt");
  expect(result.task).not.toHaveProperty("completedAt");
});
