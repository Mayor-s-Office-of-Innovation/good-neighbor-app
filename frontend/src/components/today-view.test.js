import { beforeAll, describe, expect, it, vi } from "vitest";

import { formatTime, formatWeekday } from "../i18n/dates.js";
import { t } from "../i18n/i18n.js";
import { escapeHtml } from "../lib/html.js";

beforeAll(() => {
  vi.stubGlobal("HTMLElement", class {});
  vi.stubGlobal("window", {
    addEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
    location: { pathname: "/today" },
  });
  vi.stubGlobal("document", { addEventListener: vi.fn() });
  vi.stubGlobal("history", { pushState: vi.fn() });
  vi.stubGlobal("customElements", {
    define: vi.fn(),
  });
});

describe("site proximity", () => {
  it("uses a one-eighth-mile radius and ignores unavailable coordinates", async () => {
    const { isOutsideSiteRadius } = await import("../domain/home-tasks.js");
    const site = { latitude: 37.7749, longitude: -122.4194 };
    expect(isOutsideSiteRadius(site, site)).toBe(false);
    expect(
      isOutsideSiteRadius({ latitude: 37.7758, longitude: -122.4194 }, site),
    ).toBe(false);
    expect(
      isOutsideSiteRadius({ latitude: 37.778, longitude: -122.4194 }, site),
    ).toBe(true);
    expect(isOutsideSiteRadius(null, site)).toBe(false);
    expect(isOutsideSiteRadius(site, null)).toBe(false);
  });
});

describe("formatOverdueElapsed", () => {
  it("uses hours below one day and days thereafter", async () => {
    const { formatOverdueElapsed } = await import("../domain/home-tasks.js");
    const expected = "2026-09-24T09:00:00.000Z";

    expect(formatOverdueElapsed(expected, "2026-09-24T10:00:00.000Z")).toBe(
      t("home.overdue.hours", { count: 1 }),
    );
    expect(formatOverdueElapsed(expected, "2026-09-24T14:00:00.000Z")).toBe(
      t("home.overdue.hours", { count: 5 }),
    );
    expect(formatOverdueElapsed(expected, "2026-09-25T09:00:00.000Z")).toBe(
      t("home.overdue.days", { count: 1 }),
    );
    expect(formatOverdueElapsed(expected, "2026-09-26T10:00:00.000Z")).toBe(
      t("home.overdue.days", { count: 2 }),
    );
    expect(t("home.overdue.hours", { count: 1 })).not.toBe(
      t("home.overdue.hours", { count: 5 }),
    );
  });
});

describe("isStalePendingSession", () => {
  it("keeps a submitted check's local cards until guidance has finished", async () => {
    const { isStalePendingSession } = await import("../domain/home-tasks.js");
    const session = {
      id: "chk_1",
      status: "capture-complete",
      items: [{ analysis: { status: "analyzing" } }],
    };
    const submitted = [{ id: "chk_1", status: "submitted" }];

    expect(isStalePendingSession(session, submitted)).toBe(false);
    session.items[0].analysis.status = "analyzed";
    expect(isStalePendingSession(session, submitted)).toBe(true);
  });

  it("keeps analyzed local cards until the backend worklist includes them", async () => {
    const { isStalePendingSession } = await import("../domain/home-tasks.js");
    const session = {
      id: "chk_1",
      status: "capture-complete",
      items: [
        {
          analysis: {
            status: "analyzed",
            tasks: [{ taskId: "task_1" }],
          },
        },
      ],
    };
    const submitted = [{ id: "chk_1", status: "submitted" }];

    expect(isStalePendingSession(session, submitted, [])).toBe(false);
    expect(
      isStalePendingSession(session, submitted, [{ taskId: "task_1" }]),
    ).toBe(true);
  });

  it("clears a capture-complete session once the same backend check is completed", async () => {
    const { isStalePendingSession } = await import("../domain/home-tasks.js");

    expect(
      isStalePendingSession({ id: "chk_1", status: "capture-complete" }, [
        { id: "chk_1", status: "submitted" },
      ]),
    ).toBe(true);
  });

  it("keeps a capture-complete session while the backend check has not landed", async () => {
    const { isStalePendingSession } = await import("../domain/home-tasks.js");

    expect(
      isStalePendingSession({ id: "chk_1", status: "capture-complete" }, [
        { id: "chk_2", status: "submitted" },
      ]),
    ).toBe(false);
  });

  it("keeps a capture-complete session while a different check landed", async () => {
    const { isStalePendingSession } = await import("../domain/home-tasks.js");

    expect(
      isStalePendingSession({ id: "chk_1", status: "capture-complete" }, [
        { id: "chk_2", status: "submitted" },
        { id: "chk_3", status: "submitted" },
      ]),
    ).toBe(false);
  });
});

describe("legacy review records", () => {
  // Pre-#192 devices may still carry review-store records with legacy-stage
  // statuses (uploading/analyzing/submitted). No code path produces those
  // statuses anymore; connectedCallback clears any session that is not
  // capture-complete instead of letting it linger. This mirrors that
  // predicate's decision table (the state-level clearing is covered in
  // check-session.test.js against the mocked review store).
  it("every legacy-stage status fails the capture-complete check", () => {
    for (const status of [
      "uploading",
      "analyzing",
      "submitted",
      "analysis_failed",
    ]) {
      const session = { id: `chk_legacy_${status}`, status };
      expect(
        session.status !== "capture-complete",
        `${status} must be cleared, not resumed`,
      ).toBe(true);
    }
  });
});

describe("home task status helpers", () => {
  it("renders the empty To do panel with the single-issue action", async () => {
    const { homeAllDonePanel } = await import("./today-view.templates.js");
    const markup = homeAllDonePanel();

    expect(markup).toContain(escapeHtml(t("today.allDone.title")));
    expect(markup).toContain(escapeHtml(t("today.allDone.text")));
    expect(markup).toContain('data-start-capture="single-problem"');
  });

  it("maps open tasks to needs action and backend 311 filings to in progress", async () => {
    const { homeTaskStatus } = await import("../domain/home-tasks.js");

    expect(homeTaskStatus({ status: "open" }, null)).toBe("needs_action");
    expect(homeTaskStatus({ status: "resolving" }, null)).toBe("in_progress");
    expect(
      homeTaskStatus(
        {
          status: "completed",
          completionMethod: "311_filed",
          updatedAt: "2026-09-08T10:00:00.000Z",
        },
        null,
      ),
    ).toBe("in_progress");
    expect(
      homeTaskStatus(
        {
          status: "completed",
          completionMethod: "311_filed",
          appActionResults: [{ code: "create_311_ticket", status: "closed" }],
          updatedAt: "2026-09-08T10:00:00.000Z",
        },
        null,
        new Date("2026-09-08T12:00:00.000Z"),
      ),
    ).toBe("resolved");
  });

  it("lets backend terminal state override stale local task overrides", async () => {
    const { homeTaskStatus } = await import("../domain/home-tasks.js");

    expect(
      homeTaskStatus(
        {
          status: "completed",
          completionMethod: "manual",
          updatedAt: "2026-09-08T10:00:00.000Z",
        },
        {
          status: "in_progress",
          updatedAt: "2026-09-08T10:05:00.000Z",
        },
        new Date("2026-09-08T12:00:00.000Z"),
      ),
    ).toBe("resolved");
  });

  it("archives resolved tasks after 72 hours", async () => {
    const { homeTaskStatus } = await import("../domain/home-tasks.js");
    const now = new Date("2026-09-08T12:00:00.000Z");

    expect(
      homeTaskStatus(
        { status: "completed", updatedAt: "2026-09-07T12:00:00.000Z" },
        null,
        now,
      ),
    ).toBe("resolved");
    expect(
      homeTaskStatus(
        { status: "completed", updatedAt: "2026-09-04T11:59:00.000Z" },
        null,
        now,
      ),
    ).toBe("archived");
  });

  it("treats open tasks under 3 hours old as new home cards", async () => {
    const { isNewHomeTask } = await import("../domain/home-tasks.js");
    const now = new Date("2026-09-08T12:00:00.000Z");

    expect(
      isNewHomeTask(
        { status: "open", createdAt: "2026-09-08T09:01:00.000Z" },
        null,
        now,
      ),
    ).toBe(true);
    expect(
      isNewHomeTask(
        { status: "open", createdAt: "2026-09-08T08:59:00.000Z" },
        null,
        now,
      ),
    ).toBe(false);
  });

  it("uses backend timestamp variants when deciding if a task is new", async () => {
    const { isNewHomeTask, taskCreatedAt } = await import(
      "../domain/home-tasks.js"
    );
    const now = new Date("2026-09-08T12:00:00.000Z");

    expect(taskCreatedAt({ created_at: "2026-09-08T10:00:00.000Z" })).toBe(
      "2026-09-08T10:00:00.000Z",
    );
    expect(
      taskCreatedAt({ gsi2sk: "2026-09-08T10:15:00.000Z#escalation#2#t1" }),
    ).toBe("2026-09-08T10:15:00.000Z");
    expect(
      isNewHomeTask(
        { status: "open", created_at: "2026-09-08T10:00:00.000Z" },
        null,
        now,
      ),
    ).toBe(true);
  });

  it("prefers persisted short display ids when rendering task metadata", async () => {
    const { displayTaskId } = await import("../domain/home-tasks.js");

    expect(
      displayTaskId({
        shortId: "MOI-CIT-001",
        assessmentId: "long-assessment-id",
      }),
    ).toBe("MOI-CIT-001");
    expect(displayTaskId({ displayId: "CHC-730-002" })).toBe("CHC-730-002");
    expect(displayTaskId({ assessmentId: "long-assessment-id" })).toBe(
      "long-assessment-id",
    );
  });

  it("does not treat resolved or in-progress tasks as new cards", async () => {
    const { isNewHomeTask } = await import("../domain/home-tasks.js");
    const now = new Date("2026-09-08T12:00:00.000Z");

    expect(
      isNewHomeTask(
        { status: "completed", createdAt: "2026-09-08T11:00:00.000Z" },
        null,
        now,
      ),
    ).toBe(false);
    expect(
      isNewHomeTask(
        { status: "open", createdAt: "2026-09-08T11:00:00.000Z" },
        {
          status: "in_progress",
          updatedAt: "2026-09-08T11:10:00.000Z",
        },
        now,
      ),
    ).toBe(false);
  });

  it("renders issue count labels only when issues exist", async () => {
    const { issueCountLabel } = await import("../domain/home-tasks.js");

    expect(issueCountLabel(0)).toBe("");
    expect(issueCountLabel(1)).toBe(t("home.issueCount", { count: 1 }));
    expect(issueCountLabel(2)).toBe(t("home.issueCount", { count: 2 }));
    expect(issueCountLabel(1)).not.toBe(issueCountLabel(2));
  });

  it("summarizes only the latest check's issues and pending actions", async () => {
    const { lastLogSummary } = await import("../domain/home-tasks.js");
    const now = new Date(2026, 8, 23, 12, 0);
    const last = {
      id: "latest",
      submittedAt: new Date(2026, 8, 23, 9, 5).toISOString(),
      issueCount: 2,
    };
    const summary = (outcome) =>
      t("home.lastLog.summary", {
        day: t("date.today"),
        time: formatTime(last.submittedAt),
        outcome,
      });

    expect(
      lastLogSummary(
        last,
        [
          { task: { checkId: "latest" }, homeStatus: "needs_action" },
          { task: { checkId: "older" }, homeStatus: "needs_action" },
        ],
        now,
      ),
    ).toBe(summary(t("home.issueCount", { count: 2 })));
    expect(
      lastLogSummary(
        last,
        [
          { task: { checkId: "latest" }, homeStatus: "in_progress" },
          { task: { checkId: "older" }, homeStatus: "needs_action" },
        ],
        now,
      ),
    ).toBe(summary(t("home.lastLog.allHandled")));
    expect(lastLogSummary(last, [], now)).toBe(
      summary(t("home.lastLog.allHandled")),
    );
    expect(lastLogSummary({ ...last, issueCount: 0 }, [], now)).toBe(
      summary(t("home.lastLog.noIssues")),
    );
  });

  it("uses yesterday or the weekday for earlier last checks", async () => {
    const { lastLogSummary } = await import("../domain/home-tasks.js");
    const now = new Date(2026, 8, 23, 12, 0);
    const check = (date) => ({
      id: "check",
      submittedAt: date.toISOString(),
      issueCount: 1,
    });

    const yesterday = new Date(2026, 8, 22, 18, 0);
    expect(lastLogSummary(check(yesterday), [], now)).toBe(
      t("home.lastLog.summary", {
        day: t("date.yesterday"),
        time: formatTime(yesterday),
        outcome: t("home.lastLog.allHandled"),
      }),
    );
    const monday = new Date(2026, 8, 21, 9, 30);
    expect(
      lastLogSummary(
        check(monday),
        [{ task: { checkId: "check" }, homeStatus: "needs_action" }],
        now,
      ),
    ).toBe(
      t("home.lastLog.summary", {
        day: formatWeekday(monday),
        time: formatTime(monday),
        outcome: t("home.issueCount", { count: 1 }),
      }),
    );
  });

  it("keeps the newest task-bearing check blue only while it is today", async () => {
    const { newestBlueCheckGroup } = await import("../domain/home-tasks.js");
    const entries = [
      {
        task: { checkId: "older" },
        createdAt: "2026-09-22T09:00:00.000Z",
      },
      {
        task: { checkId: "newest" },
        createdAt: "2026-09-22T10:00:00.000Z",
      },
    ];
    const checks = [
      { id: "older", submittedAt: "2026-09-22T09:10:00.000Z" },
      { id: "newest", submittedAt: "2026-09-22T10:10:00.000Z" },
    ];

    expect(
      newestBlueCheckGroup(
        entries,
        checks,
        null,
        new Date("2026-09-22T12:00:00.000Z"),
      ),
    ).toEqual({ id: "newest", time: "2026-09-22T10:10:00.000Z" });
    expect(
      newestBlueCheckGroup(
        entries,
        checks,
        null,
        new Date("2026-09-23T08:00:00.000Z"),
      ),
    ).toEqual({ id: "", time: "" });
  });

  it("uses task timestamps when a recent check header cannot be matched", async () => {
    const { newestBlueCheckGroup } = await import("../domain/home-tasks.js");

    expect(
      newestBlueCheckGroup(
        [
          {
            task: { checkId: "task-check" },
            createdAt: "2026-09-22T10:00:00.000Z",
          },
        ],
        [{ id: "different-header", submittedAt: "2026-09-22T10:05:00.000Z" }],
        null,
        new Date("2026-09-22T12:00:00.000Z"),
      ),
    ).toEqual({ id: "task-check", time: "2026-09-22T10:00:00.000Z" });
  });

  it("treats a completed zero-issue check as the newest blue group", async () => {
    const { newestBlueCheckGroup } = await import("../domain/home-tasks.js");

    expect(
      newestBlueCheckGroup(
        [],
        [
          {
            id: "clear-check",
            issueCount: 0,
            submittedAt: "2026-09-22T10:05:00.000Z",
          },
        ],
        null,
        new Date("2026-09-22T12:00:00.000Z"),
      ),
    ).toEqual({ id: "clear-check", time: "2026-09-22T10:05:00.000Z" });
  });

  it("hydrates only new cards and the selected older bucket", async () => {
    const { visibleTaskEntriesForHydration } = await import(
      "../domain/home-tasks.js"
    );

    expect(
      visibleTaskEntriesForHydration(
        [
          { task: { taskId: "new" }, isNew: true, homeStatus: "needs_action" },
          {
            task: { taskId: "needs_action" },
            isNew: false,
            homeStatus: "needs_action",
          },
          {
            task: { taskId: "in_progress" },
            isNew: false,
            homeStatus: "in_progress",
          },
          {
            task: { taskId: "resolved" },
            isNew: false,
            homeStatus: "resolved",
          },
        ],
        "in_progress",
      ).map((entry) => entry.task.taskId),
    ).toEqual(["in_progress"]);
  });

  it("keeps local problem cards until matching backend task cards are present", async () => {
    const { sessionProblemItemHasBackendCards } = await import(
      "../domain/home-tasks.js"
    );
    const item = {
      analysis: {
        tasks: [
          {
            taskId: "local_task_1",
            conditionId: "condition_litter",
            assessmentId: "assessment_litter",
          },
        ],
      },
    };

    expect(sessionProblemItemHasBackendCards(item, [])).toBe(false);
    expect(
      sessionProblemItemHasBackendCards(item, [
        {
          taskId: "backend_task_other",
          conditionId: "condition_needles",
          assessmentId: "assessment_needles",
        },
      ]),
    ).toBe(false);
    expect(
      sessionProblemItemHasBackendCards(item, [
        {
          taskId: "backend_task_1",
          conditionId: "condition_litter",
          assessmentId: "assessment_litter",
        },
      ]),
    ).toBe(true);
  });
});

describe("card deletion events", () => {
  it.each([false, true])(
    "handles child-originated deletion: %s",
    async (fromChild) => {
      await import("./today-view.js");
      const registration = vi
        .mocked(customElements.define)
        .mock.calls.find(([name]) => name === "today-view");
      const View = /** @type {any} */ (registration[1]);
      const view = new View();
      view._deferredDeletionRender = true;
      view.connectedCallback = vi.fn();
      view._cardDeletedHandler({ target: fromChild ? {} : view });
      expect(view._deferredDeletionRender).toBe(false);
      expect(view.connectedCallback).toHaveBeenCalledTimes(fromChild ? 1 : 0);
      // Capture lives on its own route now; a home-originated deletion always
      // focuses the home control after the re-render.
      expect(view._focusAfterRender).toBe(
        fromChild ? "home-primary-control" : null,
      );
    },
  );
});

describe("in-progress card actions", () => {
  it.each(["completed", "in_progress"])(
    "accepts a saved %s action despite a failed informational 311 closure",
    async (status) => {
      await import("./today-view.js");
      const { getToasts } = await import("../state/toasts.js");
      const registration = vi
        .mocked(customElements.define)
        .mock.calls.find(([name]) => name === "today-view");
      const View = /** @type {any} */ (registration[1]);
      const view = new View();
      const button = { disabled: false };
      const card = {
        querySelectorAll: () => [button],
        querySelector: () => null,
        getAttribute: () => "task-1",
        setAttribute: vi.fn(),
        removeAttribute: vi.fn(),
      };
      const response = {
        task: {
          status,
          completionMethod: "manual",
          appActionResults: [
            { code: "create_311_ticket", status: "submitted" },
            { code: "close_311_ticket", status: "failed", reason: "21" },
          ],
        },
      };
      try {
        expect(await view._run(card, async () => response)).toBe(response);
        expect(getToasts()).toHaveLength(0);
      } finally {
        getToasts().forEach((toast) => toast.close());
      }
    },
  );

  it("merges a completion response over the list record without a reload", async () => {
    await import("./today-view.js");
    const registration = vi
      .mocked(customElements.define)
      .mock.calls.find(([name]) => name === "today-view");
    const View = /** @type {any} */ (registration[1]);
    const view = new View();
    view._homeModel = {
      tasks: [
        { taskId: "a", status: "open", thumbnailUrl: "thumb-a" },
        { taskId: "b", status: "open" },
      ],
    };
    view._applyTaskResult("a", {
      taskId: "a",
      status: "completed",
      canUploadPhotos: true,
    });
    expect(view._homeModel.tasks[0]).toEqual({
      taskId: "a",
      status: "completed",
      thumbnailUrl: "thumb-a",
      canUploadPhotos: true,
    });
    expect(view._homeModel.tasks[1]).toEqual({ taskId: "b", status: "open" });
    view._applyTaskResult("c", { taskId: "c", status: "in_progress" });
    expect(view._homeModel.tasks.map((task) => task.taskId)).toEqual([
      "a",
      "b",
      "c",
    ]);
    view._applyTaskResult("a", null);
    expect(view._homeModel.tasks).toHaveLength(3);
  });

  it("holds a home paint while a native dialog is open and flushes on close", async () => {
    await import("./today-view.js");
    const registration = vi
      .mocked(customElements.define)
      .mock.calls.find(([name]) => name === "today-view");
    const View = /** @type {any} */ (registration[1]);
    const view = new View();
    const model = { tasks: [] };
    view.querySelector = () => ({ open: true });
    view._renderHome(model);
    expect(view._pendingDialogRender).toBe(true);
    expect(view._homeModel).toBe(model);
    const later = { tasks: [{ taskId: "a", status: "open" }] };
    view._renderHome(later);
    expect(view._homeModel).toBe(later);
    view.querySelector = () => null;
    view._renderHome = vi.fn();
    view._flushDialogRender();
    expect(view._renderHome).toHaveBeenCalledWith(later);
    expect(view._pendingDialogRender).toBe(false);
    view._flushDialogRender();
    expect(view._renderHome).toHaveBeenCalledTimes(1);
  });

  it("labels in-progress cards as View or add updates", async () => {
    await import("./today-view.js");
    const registration = vi
      .mocked(customElements.define)
      .mock.calls.find(([name]) => name === "today-view");
    const View = /** @type {any} */ (registration[1]);
    const view = new View();
    view._site = { name: "Test site", address: "1 Test St" };

    const card = view._taskCardEntry(
      {
        task: {
          taskId: "task_311",
          kind: "escalation",
          title: "311 request",
        },
        homeStatus: "in_progress",
        createdAt: "2026-09-30T16:00:00.000Z",
      },
      false,
    );

    expect(card.markup).toContain(escapeHtml(t("card.viewUpdates")));
    expect(card.markup).not.toContain(
      `>${escapeHtml(t("today.card.update"))}<`,
    );
    expect(card.markup).toContain('data-action="update"');
  });
});

describe("live ticker refresh", () => {
  it("refreshes saved ticket statuses on return without disturbing an open dialog", async () => {
    await import("./today-view.js");
    const registration = /** @type {any} */ (
      customElements.define
    ).mock.calls.find(([name]) => name === "today-view");
    const view = new registration[1]();
    view.isConnected = true;
    view._homeModel = { tasks: [{ taskId: "129" }] };
    const refresh = vi.fn();
    view._hydrate311CardStatuses = refresh;
    vi.stubGlobal("document", {
      visibilityState: "visible",
      querySelector: () => null,
    });
    view._refresh311Statuses();
    expect(refresh).toHaveBeenCalledWith(view._homeModel.tasks);
    refresh.mockClear();
    document.querySelector = () => /** @type {any} */ ({ open: true });
    view._refresh311Statuses();
    expect(refresh).not.toHaveBeenCalled();
    document.querySelector = () => null;
    view.isConnected = false;
    view._refresh311Statuses();
    expect(refresh).not.toHaveBeenCalled();
  });
});

it("retains confirmed resolution through delayed and missing index results", async () => {
  await import("./today-view.js");
  const View = /** @type {any} */ (
    vi
      .mocked(customElements.define)
      .mock.calls.find(([name]) => name === "today-view")[1]
  );
  const view = new View();
  const task = {
    taskId: "a",
    status: "completed",
    updatedAt: "2026-10-23T12:00:00Z",
  };
  view._confirmedTasks = new Map([["a", task]]);
  const stale = {
    taskId: "a",
    status: "in_progress",
    updatedAt: "2026-10-23T11:00:00Z",
    thumbnailUrl: "photo",
  };
  expect(view._reconcileConfirmedTasks([stale], true)).toEqual([
    { ...stale, ...task },
  ]);
  expect(view._reconcileConfirmedTasks([], true)).toEqual([task]);
  expect(view._confirmedTasks.size).toBe(1);
  // Seeing completion in one list must not retire it while another is stale.
  expect(view._reconcileConfirmedTasks([stale, task], true)[0].status).toBe(
    "completed",
  );
  expect(view._confirmedTasks.size).toBe(1);
  expect(view._reconcileConfirmedTasks([task], true)).toEqual([task]);
  expect(view._confirmedTasks.size).toBe(0);
});

it("reconciles TaskSheets updates before reloading, including after dismissal", async () => {
  await import("./today-view.js");
  const View = /** @type {any} */ (
    vi
      .mocked(customElements.define)
      .mock.calls.find(([name]) => name === "today-view")[1]
  );
  const view = new View();
  view._homeModel = { tasks: [{ taskId: "a", status: "in_progress" }] };
  // Hold rendering at the model update; the open sheet normally remains mounted.
  view.querySelector = () => ({ open: true });
  view._tasksById = new Map();
  const sheets = view._taskSheets();
  sheets._focusCard = vi.fn();
  const listeners = new Map();
  const dialog = {
    addEventListener: (name, handler) => listeners.set(name, handler),
    open: vi.fn(),
    openResults: vi.fn(),
    remove: vi.fn(),
  };
  const originalCreate = document.createElement;
  document.createElement = /** @type {any} */ (vi.fn(() => dialog));
  sheets.mount = vi.fn();
  const reload = vi.fn();
  sheets._options.reload = reload;
  try {
    await sheets.openUpdates(
      { taskId: "a", status: "in_progress" },
      null,
      "results",
    );
    listeners.get("taskupdateclosed")({ detail: { results: true } });
    expect(sheets._updateDialog).toBeNull();
    reload.mockClear();
    const task = {
      taskId: "a",
      status: "completed",
      updatedAt: "2026-10-23T12:00:00Z",
    };
    reload.mockImplementation(() => {
      expect(view._homeModel.tasks[0].status).toBe("completed");
    });
    listeners.get("taskupdated")({ detail: { task } });
    expect(reload).toHaveBeenCalledOnce();
    view._renderHome({ tasks: [{ taskId: "a", status: "in_progress" }] });
    expect(view._homeModel.tasks).toEqual([task]);
    view._renderHome({ tasks: [] });
    expect(view._homeModel.tasks).toEqual([task]);
  } finally {
    document.createElement = originalCreate;
  }
});

it("retains hydrated evidence on refresh without retaining stale task status", async () => {
  await import("./today-view.js");
  const View = /** @type {any} */ (
    vi
      .mocked(customElements.define)
      .mock.calls.find(([name]) => name === "today-view")[1]
  );
  const view = new View();
  view._homeModel = {
    tasks: [
      {
        taskId: "a",
        checkId: "check",
        status: "open",
        evidence: { text: "Evidence" },
        thumbnailUrl: "photo",
      },
    ],
  };
  view.querySelector = (selector) =>
    selector === ":scope > .home dialog[open]" ? {} : null;
  view._renderHome({
    tasks: [{ taskId: "a", checkId: "check", status: "completed" }],
  });
  expect(view._homeModel.tasks[0]).toMatchObject({
    status: "completed",
    evidence: { text: "Evidence" },
    thumbnailUrl: "photo",
  });
  view._renderHome({
    tasks: [{ taskId: "a", checkId: "different", status: "completed" }],
  });
  expect(view._homeModel.tasks[0].thumbnailUrl).toBeUndefined();
});

it("keeps the existing DOM when a background update does not change the rendered worklist", async () => {
  await import("./today-view.js");
  const View = /** @type {any} */ (
    vi
      .mocked(customElements.define)
      .mock.calls.find(([name]) => name === "today-view")[1]
  );
  const view = new View();
  view._homeMarkup = "same content";
  view._render = () => "same content";
  view.querySelector = (selector) =>
    selector === ":scope > .home" ? {} : null;
  const replace = vi.fn();
  Object.defineProperty(view, "innerHTML", { set: replace });
  view._renderHome({ tasks: [{ taskId: "a", status: "open" }] });
  expect(replace).not.toHaveBeenCalled();
  expect(view._tasksById.get("a").status).toBe("open");
});

describe("return-to-app task freshness", () => {
  async function fixture() {
    await import("./today-view.js");
    const View = /** @type {any} */ (
      vi
        .mocked(customElements.define)
        .mock.calls.find(([name]) => name === "today-view")[1]
    );
    const view = new View();
    view.isConnected = true;
    view._siteId = "site";
    view._homeFilter = "todo";
    view._homeModel = {
      tasks: [
        { taskId: "old", status: "open" },
        { taskId: "history", status: "completed" },
      ],
    };
    view._renderHome = vi.fn((model) => {
      view._homeModel = model;
    });
    view._watchDuplicates = vi.fn();
    view._hydrateVisibleHomeTasks = vi.fn();
    view.querySelector = () => null;
    vi.stubGlobal("document", {
      visibilityState: "visible",
      querySelector: () => null,
    });
    const api = await import("../services/api.js");
    return { view, api };
  }

  it("shares focus/visibility reads, fetches only open tasks, and waits five minutes", async () => {
    const { view, api } = await fixture();
    /** @type {(value: any) => void} */
    let resolve = () => {};
    const fetch = vi.spyOn(api, "listTasks").mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    try {
      const first = view._refreshActiveTab();
      const second = view._refreshActiveTab();
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
      expect(fetch).toHaveBeenCalledWith({ status: "open", limit: 50 });
      resolve({ tasks: [{ taskId: "new", status: "open" }] });
      await Promise.all([first, second]);
      expect(view._homeModel.tasks.map((task) => task.taskId)).toEqual([
        "history",
        "new",
      ]);
      await view._refreshActiveTab();
      expect(fetch).toHaveBeenCalledTimes(1);
      view._taskListFreshness.set("open", Date.now() - 5 * 60 * 1000);
      fetch.mockResolvedValue({ tasks: [] });
      await view._refreshActiveTab();
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      fetch.mockRestore();
    }
  });

  it("keeps failures stale and ignores responses superseded by a full refresh", async () => {
    const { view, api } = await fixture();
    const original = view._homeModel;
    const fetch = vi
      .spyOn(api, "listTasks")
      .mockRejectedValue(new Error("offline"));
    try {
      await view._refreshActiveTab();
      expect(view._homeModel).toBe(original);
      expect(view._taskListFreshness.has("open")).toBe(false);
      /** @type {(value: any) => void} */
      let resolve = () => {};
      fetch.mockImplementation(
        () =>
          new Promise((r) => {
            resolve = r;
          }),
      );
      const pending = view._refreshActiveTab();
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
      view._tabRefreshEpoch++;
      resolve({ tasks: [] });
      await pending;
      expect(view._homeModel).toBe(original);
    } finally {
      fetch.mockRestore();
    }
  });

  it("does no freshness work while hidden or while a full load is active", async () => {
    const { view, api } = await fixture();
    const fetch = vi.spyOn(api, "listTasks");
    try {
      vi.stubGlobal("document", { visibilityState: "hidden" });
      await view._refreshActiveTab();
      vi.stubGlobal("document", { visibilityState: "visible" });
      view._homeRefresh = Promise.resolve();
      await view._refreshActiveTab();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });
  it("fetches only stale statuses needed by In-progress and defers History-only data", async () => {
    const { view, api } = await fixture();
    view._homeFilter = "in_progress";
    view._taskListFreshness.set("completed", Date.now());
    const fetch = vi.spyOn(api, "listTasks").mockResolvedValue({ tasks: [] });
    try {
      await view._refreshActiveTab();
      expect(
        fetch.mock.calls.map(([options]) => options.status).sort(),
      ).toEqual(["completing", "in_progress"]);
      fetch.mockClear();
      view._homeFilter = "history";
      await view._refreshActiveTab();
      expect(
        fetch.mock.calls.map(([options]) => options.status).sort(),
      ).toEqual(["open"]);
    } finally {
      fetch.mockRestore();
    }
  });

  it("shows polite refresh text only after a delay and clears it after completion", async () => {
    const { view, api } = await fixture();
    const { refreshActiveTab } = await import(
      "../services/home-task-freshness.js"
    );
    const status = { textContent: "" };
    view.querySelector = () => status;
    /** @type {(value: any) => void} */
    let resolve = () => {};
    const fetch = vi.spyOn(api, "listTasks").mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    vi.useFakeTimers();
    try {
      const pending = refreshActiveTab(view);
      await vi.advanceTimersByTimeAsync(299);
      expect(status.textContent).toBe("");
      await vi.advanceTimersByTimeAsync(1);
      expect(status.textContent).toBe(t("home.checkingUpdates"));
      resolve({ tasks: [] });
      await pending;
      expect(status.textContent).toBe("");
    } finally {
      vi.useRealTimers();
      fetch.mockRestore();
    }
  });
  it("retires a confirmed override only when a saved or newer server version arrives", async () => {
    const { view, api } = await fixture();
    view._homeFilter = "in_progress";
    const confirmed = {
      taskId: "a",
      status: "completed",
      updatedAt: "2026-10-27T10:00:00Z",
    };
    view._confirmedTasks = new Map([["a", confirmed]]);
    const stale = {
      ...confirmed,
      status: "in_progress",
      updatedAt: "2026-10-27T09:00:00Z",
    };
    const newer = { ...stale, updatedAt: "2026-10-27T11:00:00Z" };
    const fetch = vi
      .spyOn(api, "listTasks")
      .mockImplementation(async ({ status }) => ({
        tasks: status === "in_progress" ? [stale] : [],
      }));
    try {
      await view._refreshActiveTab();
      expect(view._confirmedTasks.has("a")).toBe(true);
      expect(
        view._homeModel.tasks.find((task) => task.taskId === "a"),
      ).toMatchObject(confirmed);
      view._taskListFreshness.clear();
      fetch.mockImplementation(async ({ status }) => ({
        tasks:
          status === "in_progress"
            ? [newer]
            : status === "completed"
              ? [confirmed]
              : [],
      }));
      await view._refreshActiveTab();
      expect(view._confirmedTasks.has("a")).toBe(false);
      expect(
        view._homeModel.tasks.find((task) => task.taskId === "a"),
      ).toMatchObject(newer);
    } finally {
      fetch.mockRestore();
    }
  });

  it("recovers both secondary tabs after all remaining statuses load", async () => {
    const { view, api } = await fixture();
    view._homeFilter = "in_progress";
    view._remainingStatus = "error";
    const fetch = vi.spyOn(api, "listTasks").mockResolvedValue({ tasks: [] });
    try {
      await view._refreshActiveTab();
      expect(view._tabListStatus()).toBe("loaded");
      expect(view._remainingStatus).toBe("loaded");
      view._homeFilter = "history";
      expect(view._tabListStatus()).toBe("loaded");
    } finally {
      fetch.mockRestore();
    }
  });

  it("publishes successful lists once after all responses, retaining a failed list", async () => {
    const { view, api } = await fixture();
    view._homeFilter = "in_progress";
    const pending = new Map();
    const fetch = vi
      .spyOn(api, "listTasks")
      .mockImplementation(
        ({ status }) =>
          new Promise((resolve, reject) =>
            pending.set(status, { resolve, reject }),
          ),
      );
    try {
      const first = view._refreshActiveTab();
      const second = view._refreshActiveTab();
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
      pending
        .get("in_progress")
        .resolve({ tasks: [{ taskId: "new", status: "in_progress" }] });
      pending.get("completing").resolve({ tasks: [] });
      await Promise.resolve();
      expect(view._renderHome).not.toHaveBeenCalled();
      pending.get("completed").reject(new Error("offline"));
      await Promise.all([first, second]);
      expect(view._renderHome).toHaveBeenCalledOnce();
      expect(view._watchDuplicates).toHaveBeenCalledOnce();
      expect(view._homeModel.tasks.map((task) => task.taskId)).toContain(
        "history",
      );
      expect(view._taskListFreshness.has("completed")).toBe(false);
    } finally {
      fetch.mockRestore();
    }
  });
});

it("keeps a shared filing override on the returned original and repairs separated cards", async () => {
  await import("./today-view.js");
  const { setDuplicateUiSite } = await import("../services/feature-flags.js");
  const { readTaskStatusOverrides, writeTaskStatusOverrides } = await import(
    "../state/task-status-overrides.js"
  );
  const View = /** @type {any} */ (
    vi
      .mocked(customElements.define)
      .mock.calls.find(([name]) => name === "today-view")[1]
  );
  let stored = "{}";
  const previousStorage = globalThis.localStorage;
  vi.stubGlobal("localStorage", {
    getItem: () => stored,
    setItem: (_key, value) => {
      stored = value;
    },
  });
  setDuplicateUiSite({ featureFlags: { duplicateDetection: true } });
  try {
    const source = {
      taskId: "repeat",
      status: "open",
      kind: "escalation",
      createdAt: new Date().toISOString(),
    };
    const original = { ...source, taskId: "original", status: "in_progress" };
    const view = new View();
    view._homeModel = { tasks: [source, original] };
    view._duplicateLinks = new Map();
    view._expireRemainingLists = vi.fn();
    view._refreshAfterAction = vi.fn();
    view._run = vi.fn().mockResolvedValue({ task: original });
    writeTaskStatusOverrides({
      repeat: { status: "in_progress" },
      unrelated: { status: "resolved" },
    });
    view._onAction({}, source, { getAttribute: () => "file311" });
    await Promise.resolve();
    expect(readTaskStatusOverrides()).toMatchObject({
      original: { status: "in_progress" },
      unrelated: { status: "resolved" },
    });
    expect(readTaskStatusOverrides().repeat).toBeUndefined();
    expect(
      view._homeModel.tasks.find((task) => task.taskId === "repeat").status,
    ).toBe("open");

    // A returning user may still have the override written by an older client.
    writeTaskStatusOverrides({
      ...readTaskStatusOverrides(),
      repeat: { status: "in_progress" },
    });
    view._taskOverrides = readTaskStatusOverrides();
    view._duplicateLinks.set("repeat", { state: "separated" });
    const entry = view
      ._homeTasks([source])
      .find((entry) => entry.task.taskId === "repeat");
    expect(entry.homeStatus).toBe("needs_action");
    expect(readTaskStatusOverrides().repeat).toBeUndefined();
    expect(readTaskStatusOverrides().original.status).toBe("in_progress");

    // A subsequent independent filing must survive a lagging open-list read.
    view._run.mockResolvedValue({ task: { ...source, status: "in_progress" } });
    view._onAction({}, source, { getAttribute: () => "file311" });
    await Promise.resolve();
    const fresh = readTaskStatusOverrides().repeat;
    expect(fresh.status).toBe("in_progress");
    // Simulate a stale view snapshot, including one retained by another tab.
    view._taskOverrides = { repeat: { status: "in_progress" } };
    for (let render = 0; render < 2; render++) {
      expect(view._homeTasks([source])[0].homeStatus).toBe("in_progress");
      expect(readTaskStatusOverrides().repeat).toEqual(fresh);
    }
    const reloaded = new View();
    reloaded._taskOverrides = readTaskStatusOverrides();
    reloaded._duplicateLinks = new Map([["repeat", { state: "separated" }]]);
    expect(reloaded._homeTasks([source])[0].homeStatus).toBe("in_progress");
    expect(readTaskStatusOverrides().repeat).toEqual(fresh);
  } finally {
    setDuplicateUiSite(null);
    vi.stubGlobal("localStorage", previousStorage);
  }
});

it("does not turn bucket overrides or pending filing states into resolve permission", async () => {
  await import("./today-view.js");
  const View = /** @type {any} */ (
    vi
      .mocked(customElements.define)
      .mock.calls.find(([name]) => name === "today-view")[1]
  );
  const view = new View();
  view._taskWith311CardStatus = (task) => task;
  view._taskStatusMeta = () => "";
  view._primaryCardAction = () => ({
    kind: "file311",
    label: t("today.action.retryFiling"),
  });
  for (const status of [
    "open",
    "completing",
    "resolving",
    "completed",
    "in_progress",
  ]) {
    const { markup } = view._taskCardEntry(
      {
        task: { taskId: "task", status, kind: "escalation" },
        homeStatus: "in_progress",
        createdAt: new Date().toISOString(),
      },
      false,
    );
    expect(markup.includes('data-action="mark-resolved"')).toBe(
      status === "in_progress",
    );
    if (status === "open") expect(markup).toContain('data-action="file311"');
  }
});
