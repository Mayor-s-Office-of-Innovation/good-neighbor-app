import { beforeAll, describe, expect, it, vi } from "vitest";

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

describe("isStalePendingSession", () => {
  it("keeps a ready review session when the newest backend check is the same UI id", async () => {
    const { isStalePendingSession } = await import("./today-view.js");

    expect(
      isStalePendingSession({ id: "chk_1", status: "submitted" }, [
        { id: "chk_1", status: "submitted" },
      ]),
    ).toBe(false);
  });

  it("clears a ready review session when a newer backend check has replaced it", async () => {
    const { isStalePendingSession } = await import("./today-view.js");

    expect(
      isStalePendingSession({ id: "chk_1", status: "submitted" }, [
        { id: "chk_2", status: "submitted" },
      ]),
    ).toBe(true);
  });

  it("keeps an analyzing session once the same backend check is completed", async () => {
    const { isStalePendingSession } = await import("./today-view.js");

    expect(
      isStalePendingSession({ id: "chk_1", status: "analyzing" }, [
        { id: "chk_1", status: "submitted" },
      ]),
    ).toBe(false);
  });
});

describe("newestTasksFirst", () => {
  it("sorts task cards by most recent createdAt first", async () => {
    const { newestTasksFirst } = await import("./today-view.js");

    expect(
      newestTasksFirst([
        { taskId: "older", createdAt: "2026-08-20T10:00:00.000Z" },
        { taskId: "newest", createdAt: "2026-08-26T16:17:51.304Z" },
        { taskId: "middle", createdAt: "2026-08-25T12:00:00.000Z" },
      ]).map((task) => task.taskId),
    ).toEqual(["newest", "middle", "older"]);
  });
});

describe("home task status helpers", () => {
  it("does not apply first-run centering while capture is visible", async () => {
    const { shouldShowFirstRunHome } = await import("./today-view.js");

    expect(
      shouldShowFirstRunHome({
        captureVisible: true,
        last: null,
        taskCount: 0,
        hasResultCards: false,
      }),
    ).toBe(false);
    expect(
      shouldShowFirstRunHome({
        captureVisible: false,
        last: null,
        taskCount: 0,
        hasResultCards: false,
      }),
    ).toBe(true);
  });

  it("defers capture-complete session renders until capture animates out", async () => {
    const { shouldDeferSessionRenderDuringCapture } = await import(
      "./today-view.js"
    );

    expect(
      shouldDeferSessionRenderDuringCapture("capture", {
        status: "capture-complete",
      }),
    ).toBe(true);
    expect(
      shouldDeferSessionRenderDuringCapture("leaving-capture", {
        status: "capture-complete",
      }),
    ).toBe(true);
    expect(shouldDeferSessionRenderDuringCapture("capture", null)).toBe(true);
    expect(
      shouldDeferSessionRenderDuringCapture("home", {
        status: "capture-complete",
      }),
    ).toBe(false);
    expect(
      shouldDeferSessionRenderDuringCapture("capture", {
        status: "submitted",
      }),
    ).toBe(false);
  });

  it("maps open tasks to needs action and 311 overrides to in progress", async () => {
    const { homeTaskStatus } = await import("./today-view.js");

    expect(homeTaskStatus({ status: "open" }, null)).toBe("needs_action");
    expect(
      homeTaskStatus(
        { status: "completed", updatedAt: "2026-09-08T10:00:00.000Z" },
        {
          status: "in_progress",
          updatedAt: "2026-09-08T10:05:00.000Z",
        },
      ),
    ).toBe("in_progress");
  });

  it("archives resolved tasks after 72 hours", async () => {
    const { homeTaskStatus } = await import("./today-view.js");
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
    const { isNewHomeTask } = await import("./today-view.js");
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
    const { isNewHomeTask, taskCreatedAt } = await import("./today-view.js");
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
    const { displayTaskId } = await import("./today-view.js");

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
    const { isNewHomeTask } = await import("./today-view.js");
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

  it("renders filter labels with counts", async () => {
    const { activeHomeFilterLabel } = await import("./today-view.js");

    expect(
      activeHomeFilterLabel("needs_action", {
        needs_action: 6,
        in_progress: 1,
      }),
    ).toBe("Needs Action • 6");
  });

  it("renders issue count labels only when issues exist", async () => {
    const { issueCountLabel } = await import("./today-view.js");

    expect(issueCountLabel(0)).toBe("");
    expect(issueCountLabel(1)).toBe("1 issue found");
    expect(issueCountLabel(2)).toBe("2 issues found");
  });

  it("matches backend tasks already represented by live capture cards", async () => {
    const { taskMatchesSessionSignatures, taskSignaturesFromSessionItems } =
      await import("./today-view.js");

    const signatures = taskSignaturesFromSessionItems([
      {
        analysis: {
          artifactId: "artifact_a",
          assessment: { assessmentId: "assessment_a" },
          conditions: [{ conditionId: "condition_a" }],
          tasks: [{ taskId: "task_a" }, { taskId: "task_b" }],
        },
      },
      {
        analysis: {
          tasks: [
            {
              taskId: "task_a",
              conditionId: "condition_b",
              sourceArtifactIds: ["artifact_b"],
            },
          ],
        },
      },
    ]);

    expect([...signatures.taskIds].sort()).toEqual(["task_a", "task_b"]);
    expect(taskMatchesSessionSignatures({ taskId: "task_a" }, signatures)).toBe(
      true,
    );
    expect(
      taskMatchesSessionSignatures({ conditionId: "condition_b" }, signatures),
    ).toBe(true);
    expect(
      taskMatchesSessionSignatures(
        { assessmentId: "assessment_a" },
        signatures,
      ),
    ).toBe(true);
    expect(
      taskMatchesSessionSignatures(
        { sourceArtifactIds: ["artifact_b"] },
        signatures,
      ),
    ).toBe(true);
    expect(
      taskMatchesSessionSignatures(
        {
          assessmentId: "ac342d41-8ecf-4eeb-a471-bb85cea4ce0d-artifact_a",
        },
        signatures,
      ),
    ).toBe(false);
    expect(
      taskMatchesSessionSignatures(
        {
          assessmentId:
            "ac342d41-8ecf-4eeb-a471-bb85cea4ce0d-11111111-2222-3333-4444-555555555555",
        },
        taskSignaturesFromSessionItems([
          { analysis: { artifactId: "11111111-2222-3333-4444-555555555555" } },
        ]),
      ),
    ).toBe(true);
  });

  it("keeps local problem cards until matching backend task cards are present", async () => {
    const { sessionProblemItemHasBackendCards } = await import(
      "./today-view.js"
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
