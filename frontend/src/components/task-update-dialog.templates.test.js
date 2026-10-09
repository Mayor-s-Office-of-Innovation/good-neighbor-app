import { describe, expect, it } from "vitest";
import { t } from "../i18n/i18n.js";
import {
  taskUpdateActionEditor,
  taskUpdateCapture,
  taskUpdateDialogShell,
  taskUpdateTimeline,
  taskUpdateTimelineTone,
} from "./task-update-dialog.templates.js";

describe("task update dialog templates", () => {
  it("shows legacy direct completion without call metadata and avoids duplicate events", () => {
    const view = {
      task: {
        kind: "onsite",
        status: "completed",
        createdAt: "2026-10-06T20:00:00Z",
        completedAt: "2026-10-06T20:05:00Z",
      },
      updates: [],
      issueOrigin: "single-problem",
      originalMediaUrl: "",
      mediaUrls: new Map(),
    };
    const markup = taskUpdateTimeline(view);
    expect(markup).toContain(t("card.route.onsite"));
    expect(markup).not.toContain(t("card.route.nonEmergency"));
    expect(markup).not.toContain("task-update__metadata");
    expect(markup).toContain('datetime="2026-10-06T20:05:00Z"');
    expect(markup.match(/Marked as complete/g)).toHaveLength(1);
    expect(
      taskUpdateTimeline({
        ...view,
        updates: [
          {
            type: "task_completed",
            label: "Marked as complete",
            occurredAt: view.task.completedAt,
          },
        ],
      }).match(/Marked as complete/g),
    ).toHaveLength(1);
    expect(taskUpdateTimeline({ ...view, nextToken: "older" })).not.toContain(
      "Marked as complete",
    );
    expect(taskUpdateTimelineTone("task_completed")).toBe("resolved");
  });

  it("identifies phone actions from their route and configured phone number", () => {
    const view = {
      task: {
        kind: "non_actionable_escalation",
        appActions: [{ code: "open_phone", payload: { phoneNumber: "911" } }],
      },
      updates: [],
      issueOrigin: "single-problem",
      originalMediaUrl: "",
      mediaUrls: new Map(),
    };
    expect(taskUpdateTimeline(view)).toContain(t("card.route.emergency"));
    expect(
      taskUpdateTimeline({
        ...view,
        task: { kind: "non_actionable_escalation" },
      }),
    ).toContain(t("card.route.nonEmergency"));
  });
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

    expect(markup).toContain(t("taskUpdate.updates.addNote"));
    expect(markup).toContain(t("taskUpdate.updates.loadOlder"));
    expect(markup).not.toContain(t("taskUpdate.created.single"));
    expect(markup).toContain("#GUB-STJ-001");
  });

  it("renders capture and action states from view data", () => {
    const capture = taskUpdateCapture({
      pendingEvent: null,
      files: [],
      notes: ["", "", ""],
      previews: [],
    });
    expect(capture).toContain(t("taskUpdate.capture.addNote"));
    expect(capture).toContain("photo-capture-tile");
    expect(capture).toContain("photo-capture-tile__icon");
    expect(capture).toContain("photo-capture-tile__label");
    expect(capture).toContain(t("check.photo.take"));
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
      t("taskUpdate.created.perimeter"),
    );
    expect(taskUpdateTimeline(base)).toContain(
      t("taskUpdate.created.perimeter"),
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
    expect(taskUpdateTimeline(view)).toContain(t("taskUpdate.overdue"));
    expect(
      taskUpdateTimeline({
        ...view,
        task: { ...task, resolvedAt: "2026-09-30T11:00:00.000Z" },
      }),
    ).not.toContain(t("taskUpdate.overdue"));
  });

  it("keeps shell navigation and timeline tones explicit", () => {
    const shell = taskUpdateDialogShell({
      mode: "note-text",
      state: "ready",
      content: "x",
    });
    expect(shell).toContain(`aria-label="${t("common.back")}"`);
    expect(shell).toContain(t("common.discardChanges"));
    expect(shell).not.toContain("Discard and close");
    expect(taskUpdateTimelineTone("presence_resolved")).toBe("resolved");
    expect(taskUpdateTimelineTone("note_photo_update")).toBe("general");
  });
});

it("reuses capture with the results title and skip, then renders saved content in history", () => {
  const capture = taskUpdateCapture({
    pendingEvent: { type: "task_completed" },
    results: true,
    files: [],
    notes: [],
    previews: [],
  });
  expect(capture).toContain(t("taskUpdate.capture.resultsTitle"));
  expect(capture).toContain("data-skip");
  const timeline = taskUpdateTimeline({
    task: { status: "completed" },
    updates: [
      {
        type: "task_completed",
        label: "Marked as complete",
        occurredAt: "2026-10-08T12:00:00Z",
        notes: ["Area cleaned"],
        photoKeys: ["photo-1"],
      },
    ],
    issueOrigin: "perimeter",
    originalMediaUrl: "",
    mediaUrls: new Map([["photo-1", "https://example.test/photo.jpg"]]),
  });
  expect(timeline).toContain("Area cleaned");
  expect(timeline).toContain('src="https://example.test/photo.jpg"');
});

it("keeps notes and skip available without an uploadable check", () => {
  const markup = taskUpdateCapture({
    pendingEvent: { updateId: "update-1" },
    results: true,
    photosAllowed: false,
    files: [],
    notes: [],
    previews: [],
  });
  expect(markup).not.toContain("data-photos");
  expect(markup).toContain(t("taskUpdate.photo.unavailable"));
  expect(markup).toContain("data-add-note");
  expect(markup).toContain("data-skip");
});
it("preserves a conflicted draft with an explanation and disabled save", () => {
  const markup = taskUpdateCapture({
    pendingEvent: null,
    results: true,
    files: [],
    notes: ["Unsaved note"],
    previews: [],
  });
  expect(markup).toContain("Unsaved note");
  expect(markup).toContain(t("taskUpdate.capture.conflict"));
  expect(markup).toMatch(/data-save-notes\s+disabled/);
  expect(markup).toContain("data-skip");
});
