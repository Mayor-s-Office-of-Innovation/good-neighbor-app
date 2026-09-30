import { describe, expect, it } from "vitest";
import {
  taskUpdateActionEditor,
  taskUpdateCapture,
  taskUpdateDialogShell,
  taskUpdateTimeline,
  taskUpdateTimelineTone,
} from "./task-update-dialog.templates.js";

describe("task update dialog templates", () => {
  it("renders the timeline independently of the controller", () => {
    const markup = taskUpdateTimeline({
      task: {
        taskId: "task-1",
        shortId: "GUB-STJ-001",
        status: "in_progress",
        kind: "onsite",
        userFriendlyLabel: "Blocked sidewalk",
        description: "A description",
        createdAt: "2026-09-30T16:00:00.000Z",
      },
      updates: [],
      issueOrigin: "single-problem",
      originalMediaUrl: "",
      mediaUrls: new Map(),
      nextToken: "next-page",
      now: new Date("2026-09-30T17:00:00.000Z"),
    });

    expect(markup).toContain("Add a note or photo");
    expect(markup).toContain("Load older updates");
    expect(markup).not.toContain("Issue added as a single issue");
    expect(markup).toContain("#GUB-STJ-001");
  });

  it("renders capture and action states from view data", () => {
    expect(
      taskUpdateCapture({
        pendingEvent: null,
        files: [],
        notes: ["", "", ""],
        previews: [],
      }),
    ).toContain("Add a typed note");
    expect(taskUpdateActionEditor({ text: "" })).toContain("disabled");
    expect(taskUpdateActionEditor({ text: "Done" })).not.toContain(
      'data-action-outcome="additional_action_resolved" disabled',
    );
  });

  it("renders issue creation only after the oldest update page is loaded", () => {
    const base = {
      task: {
        taskId: "task-1",
        status: "in_progress",
        createdAt: "2026-09-30T16:00:00.000Z",
      },
      updates: [],
      issueOrigin: "perimeter",
      originalMediaUrl: "",
      mediaUrls: new Map(),
      now: new Date("2026-09-30T17:00:00.000Z"),
    };
    expect(taskUpdateTimeline({ ...base, nextToken: "older" })).not.toContain(
      "Issue added during a perimeter check",
    );
    expect(taskUpdateTimeline(base)).toContain(
      "Issue added during a perimeter check",
    );
  });

  it("shows overdue filed requests until they are explicitly resolved", () => {
    const task = {
      taskId: "task-1",
      kind: "escalation",
      status: "completed",
      responseExpectedAt: "2026-09-29T12:00:00.000Z",
      createdAt: "2026-09-29T10:00:00.000Z",
    };
    const view = {
      task,
      updates: [],
      issueOrigin: "perimeter",
      originalMediaUrl: "",
      mediaUrls: new Map(),
      now: new Date("2026-09-30T12:00:00.000Z"),
    };
    expect(taskUpdateTimeline(view)).toContain(
      "Expected response time has passed",
    );
    expect(
      taskUpdateTimeline({
        ...view,
        task: { ...task, resolvedAt: "2026-09-30T11:00:00.000Z" },
      }),
    ).not.toContain("Expected response time has passed");
  });

  it("keeps shell navigation and timeline tones explicit", () => {
    const shell = taskUpdateDialogShell({
      mode: "note-text",
      state: "ready",
      content: "x",
    });
    expect(shell).toContain('aria-label="Back"');
    expect(shell).toContain("Discard changes");
    expect(shell).not.toContain("Discard and close");
    expect(taskUpdateTimelineTone("presence_resolved")).toBe("resolved");
    expect(taskUpdateTimelineTone("note_photo_update")).toBe("general");
  });
});
