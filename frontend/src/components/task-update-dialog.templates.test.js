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
      now: new Date("2026-09-30T17:00:00.000Z"),
    });

    expect(markup).toContain("Issue added as a single issue");
    expect(markup).toContain("Add a note or photo");
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

  it("keeps shell navigation and timeline tones explicit", () => {
    expect(
      taskUpdateDialogShell({
        mode: "note-text",
        state: "ready",
        content: "x",
      }),
    ).toContain('aria-label="Back"');
    expect(taskUpdateTimelineTone("presence_resolved")).toBe("resolved");
    expect(taskUpdateTimelineTone("note_photo_update")).toBe("general");
  });
});
