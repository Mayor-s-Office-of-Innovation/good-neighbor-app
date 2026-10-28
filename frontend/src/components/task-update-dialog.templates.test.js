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
  it.each(["Marked as complete", "Site marked as resolved"])(
    "preserves City status and normalizes completion wording: %s",
    (label) => {
      const markup = taskUpdateTimeline({
        task: {},
        updates: [
          {
            type: "city_status",
            kind: "resolved",
            label: "Marked as complete",
            occurredAt: "",
          },
          { type: "task_completed", label, occurredAt: "2026-10-22T12:00:00Z" },
        ],
        issueOrigin: "single-problem",
        originalMediaUrl: "",
        mediaUrls: new Map(),
      });
      expect(markup).toContain(t("card.ticker.cityClosed"));
      expect(markup.split(t("taskUpdate.siteResolved"))).toHaveLength(2);
      expect(markup).not.toContain("Marked as complete");
    },
  );
  it("renders an undated City closure without inventing a timestamp", () => {
    const markup = taskUpdateTimeline({
      task: {},
      updates: [{ type: "city_status", kind: "resolved", occurredAt: "" }],
      issueOrigin: "single-problem",
      originalMediaUrl: "",
      mediaUrls: new Map(),
    });
    expect(markup).toContain(t("card.ticker.cityClosed"));
    expect(markup).not.toContain('<time datetime="">');
    expect(markup).not.toContain("Invalid Date");
  });
  it("adds expiry once at the 14-day mark, including paginated timelines", () => {
    const view = {
      task: { status: "in_progress", createdAt: "2026-10-01T12:00:00Z" },
      updates: [],
      issueOrigin: "single-problem",
      originalMediaUrl: "",
      mediaUrls: new Map(),
      now: new Date("2026-10-15T12:00:00Z"),
      nextToken: "older",
    };
    const markup = taskUpdateTimeline(view);
    expect(markup).toContain(t("taskUpdate.expired"));
    expect(markup).toContain('datetime="2026-10-15T12:00:00.000Z"');
    expect(
      taskUpdateTimeline({ ...view, now: new Date("2026-10-15T11:59:59Z") }),
    ).not.toContain(t("taskUpdate.expired"));
    expect(
      taskUpdateTimeline({
        ...view,
        task: { ...view.task, resolvedAt: "2026-10-10T12:00:00Z" },
      }),
    ).not.toContain(t("taskUpdate.expired"));
    expect(
      taskUpdateTimeline({
        ...view,
        task: { ...view.task, resolvedAt: "2026-10-16T12:00:00Z" },
      }),
    ).toContain(t("taskUpdate.expired"));
    expect(
      taskUpdateTimeline({
        ...view,
        updates: [
          {
            type: "issue_expired",
            label: t("taskUpdate.expired"),
            occurredAt: "2026-10-15T12:00:00Z",
          },
        ],
      }).split(t("taskUpdate.expired")),
    ).toHaveLength(2);
  });
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
    expect(markup).not.toContain("data-status-ticker");
    expect(markup).not.toContain(t("card.route.nonEmergency"));
    expect(markup).not.toContain("task-update__metadata");
    expect(markup).toContain('datetime="2026-10-06T20:05:00Z"');
    expect(markup.match(/Site marked as resolved/g)).toHaveLength(1);
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
      }).match(/Site marked as resolved/g),
    ).toHaveLength(1);
    expect(taskUpdateTimeline({ ...view, nextToken: "older" })).not.toContain(
      "Site marked as resolved",
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
    expect(taskUpdateTimeline(view)).toContain("status-ticker--danger");
    expect(
      taskUpdateTimeline({
        ...view,
        task: { kind: "non_actionable_escalation" },
      }),
    ).toContain(t("card.ticker.needsAction"));
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
    expect(capture).not.toContain("task-update__capture-task");
    const results = taskUpdateCapture({
      pendingEvent: { updateId: null },
      results: true,
      task: {
        taskId: "task-1",
        shortId: "AB12",
        userFriendlyLabel: "Litter on sidewalk",
        thumbnailUrl: "https://cdn.example/thumb.jpg",
      },
      files: [],
      notes: ["", "", ""],
      previews: [],
    });
    expect(results).toContain("task-update__capture-task");
    expect(results).toContain("Litter on sidewalk");
    expect(results).toContain("#AB12");
    expect(results).toContain('src="https://cdn.example/thumb.jpg"');
    expect(results).toContain("data-skip");
    expect(capture).toContain("photo-capture-tile");
    expect(capture).toContain("photo-capture-tile__icon");
    expect(capture).toContain("photo-capture-tile__label");
    expect(capture).toContain(t("check.photo.take"));
    expect(taskUpdateActionEditor({ text: "" })).toContain("disabled");
    expect(taskUpdateActionEditor({ text: "Done" })).not.toContain(
      'data-action-outcome="additional_action_resolved" disabled',
    );
  });

  it("shows the card thumbnail as the original photo but opens the lightbox on the full file", () => {
    const markup = taskUpdateTimeline({
      task: {
        taskId: "task-1",
        status: "in_progress",
        createdAt: "2026-09-30T16:00:00.000Z",
      },
      updates: [],
      issueOrigin: "perimeter",
      originalMediaUrl: "https://cdn.example/photo.thumb.webp",
      originalFullMediaUrl: "https://cdn.example/photo.jpg",
      mediaUrls: new Map(),
      now: new Date("2026-09-30T17:00:00.000Z"),
    });
    expect(markup).toContain('src="https://cdn.example/photo.thumb.webp"');
    expect(markup).toContain('data-full-src="https://cdn.example/photo.jpg"');
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

it.each([null, true, false])(
  "requires the 311 help choice (%s) in both editors",
  (cityHelpNeeded) => {
    const action = taskUpdateActionEditor({
      text: "Followed up",
      allowResolution: false,
      cityHelpNeeded,
    });
    const notes = taskUpdateCapture({
      pendingEvent: null,
      files: [],
      notes: ["Still here"],
      previews: [],
      cityHelpNeeded,
    });
    for (const markup of [action, notes]) {
      expect(markup).toContain(t("taskUpdate.cityHelp.title"));
      expect(markup).not.toContain("data-action-outcome");
      expect(markup).toMatch(/class="btn-ink"\s+data-city-help="yes"/);
      expect(markup).toMatch(/class="btn-outline"\s+data-city-help="no"/);
      expect(/data-save-(?:action|notes)\s+disabled/.test(markup)).toBe(
        cityHelpNeeded === null,
      );
      expect(markup).not.toContain("city-help-note");
    }
  },
);

it.each([
  { notes: [], files: [], disabled: true },
  { notes: ["  "], files: [], disabled: true },
  { notes: ["Still here"], files: [], disabled: false },
  { notes: [], files: [new File(["photo"], "photo.jpg")], disabled: false },
])(
  "gates City help choices on capture content: %j",
  ({ notes, files, disabled }) => {
    const markup = taskUpdateCapture({
      pendingEvent: null,
      files,
      notes,
      previews: [],
      cityHelpNeeded: null,
    });
    for (const choice of ["yes", "no"]) {
      const button = markup.match(
        new RegExp(`<button[^>]*data-city-help="${choice}"[^>]*>`),
      )?.[0];
      expect(button).toBeDefined();
      expect(button.includes("disabled")).toBe(disabled);
    }
  },
);

it.each(["", " ", "a"])(
  "gates follow-up choices and Done for text %j",
  (text) => {
    for (const cityHelpNeeded of [null, true, false]) {
      const markup = taskUpdateActionEditor({
        text,
        allowResolution: false,
        cityHelpNeeded,
      });
      for (const choice of ["yes", "no"]) {
        const button = markup.match(
          new RegExp(`<button[^>]*data-city-help="${choice}"[^>]*>`),
        )?.[0];
        expect(button).toBeDefined();
        expect(button.includes("disabled")).toBe(!text.trim());
      }
      expect(/data-save-action\s+disabled/.test(markup)).toBe(
        !text.trim() || cityHelpNeeded === null,
      );
    }
  },
);

it("does not add the City question to non-311 editors", () => {
  expect(taskUpdateActionEditor({ text: "Followed up" })).not.toContain(
    "data-city-help",
  );
  expect(
    taskUpdateCapture({
      pendingEvent: null,
      files: [],
      notes: [],
      previews: [],
    }),
  ).not.toContain("data-city-help");
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
        label: "Site marked as resolved",
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
it("preserves an unattached draft with an explanation and disabled save", () => {
  const markup = taskUpdateCapture({
    pendingEvent: null,
    results: true,
    files: [],
    notes: ["Unsaved note"],
    previews: [],
  });
  expect(markup).toContain("Unsaved note");
  expect(markup).toContain(t("taskUpdate.capture.unattached"));
  expect(markup).toMatch(/data-save-notes\s+disabled/);
  expect(markup).toContain("data-skip");
});

it("uses the identical shared ticker and shows City closure details in the timeline", async () => {
  const { statusTickerMarkup } = await import("./status-ticker.js");
  const task = {
    taskId: "129",
    status: "in_progress",
    ticketStatus: "Closed",
    ticketClosedReason: "8",
    createdAt: new Date(Date.now() - 86400000).toISOString(),
    appActionResults: [
      {
        code: "create_311_ticket",
        payload: { tickets: [{ srNum: "LOCAL-147" }] },
      },
    ],
  };
  const markup = taskUpdateTimeline({
    task,
    updates: [
      {
        type: "city_status",
        kind: "resolved",
        title: "Resolved",
        label: "Resolved",
        closureReason: "Field Work Completed",
        occurredAt: "2026-10-22T21:17:24Z",
      },
    ],
    issueOrigin: "perimeter",
    originalMediaUrl: "",
    mediaUrls: new Map(),
  });
  expect(markup).toContain(statusTickerMarkup(task));
  expect(markup).toContain('data-status-ticker="cityClosed"');
  expect(markup).toContain('datetime="2026-10-22T21:17:24Z"');
  expect(markup).toContain("Field Work Completed");
  expect(markup).not.toContain("task-update__route");
});

it.each([true, false])(
  "always offers resolution and never the periodic prompt (due=%s)",
  (presencePromptDue) => {
    const markup = taskUpdateTimeline({
      task: { status: "in_progress", presencePromptDue },
      updates: [],
      issueOrigin: "single-problem",
      originalMediaUrl: "",
      mediaUrls: new Map(),
    });
    expect(markup).toContain('data-mode="resolve"');
    expect(markup).toContain(t("taskUpdate.markResolved"));
    expect(markup).not.toContain("data-presence=");
    expect(markup).not.toContain(t("taskUpdate.presence.title"));
    expect(markup.indexOf('data-mode="action"')).toBeLessThan(
      markup.indexOf('data-mode="notes"'),
    );
  },
);

it("keeps timeline history and pagination but removes mutation controls in read-only mode", () => {
  const view = {
    task: { status: "in_progress" },
    updates: [],
    issueOrigin: "perimeter",
    originalMediaUrl: "",
    mediaUrls: new Map(),
    nextToken: "older",
  };
  const editable = taskUpdateTimeline(view);
  const readonly = taskUpdateTimeline({ ...view, readOnly: true });
  expect(editable).toContain("data-mode=");
  expect(readonly).not.toContain("data-mode=");
  expect(readonly).toContain("data-load-older");
  expect(readonly).toContain("task-update__timeline");
});

it.each([
  ["completing", true, true],
  ["completed", true, true],
  ["in_progress", false, false],
  ["in_progress", undefined, true],
])(
  "honors server update capability for %s (%s)",
  (status, canUpdate, visible) => {
    const markup = taskUpdateTimeline({
      task: { status, canUpdate },
      updates: [],
      issueOrigin: "perimeter",
      originalMediaUrl: "",
      mediaUrls: new Map(),
    });
    for (const mode of ["notes", "action", "resolve"])
      expect(markup.includes(`data-mode="${mode}"`)).toBe(visible);
  },
);
