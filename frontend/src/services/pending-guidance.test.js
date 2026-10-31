import { beforeEach, expect, it, vi } from "vitest";
vi.mock("./task-evidence.js", () => ({
  hydratePendingQuestionEvidence: vi.fn(async (items) => items),
}));
const list = vi.hoisted(() => vi.fn());
const read = vi.hoisted(() => vi.fn());
vi.mock("./api.js", () => ({
  listPendingGuidance: list,
  getAssessmentGuidance: read,
}));
const {
  loadPendingQuestionItems,
  mergePendingQuestionItems,
  reconcileLocalGuidance,
} = await import("./pending-guidance.js");
const { sessionProblemItemHasBackendCards, isStalePendingSession } =
  await import("../domain/home-tasks.js");
const condition = {
  conditionId: "bulky",
  status: "needs_answer",
  needsAnswer: {
    key: "provider_generated",
    prompt: "Are these items from your site?",
    options: [],
  },
  source: { artifactIds: ["text-artifact"] },
};
const group = {
  assessment: { assessmentId: "assessment", checkId: "old-check" },
  conditions: [condition],
};
beforeEach(() => {
  list.mockReset();
  read.mockReset();
});
it("recovers questions from older reports across empty pages without local state", async () => {
  list
    .mockResolvedValueOnce({ guidance: [], nextToken: "next" })
    .mockResolvedValueOnce({ guidance: [group], nextToken: null });
  const items = await loadPendingQuestionItems();
  expect(list.mock.calls).toEqual([[null], ["next"]]);
  expect(items[0]).toMatchObject({
    checkId: "old-check",
    analysis: {
      artifactId: "text-artifact",
      assessment: group.assessment,
      conditions: [condition],
    },
  });
  expect(mergePendingQuestionItems([], items, [])).toEqual(items);
});
it("never treats an existing task as covering an unanswered sibling condition", () => {
  const item = {
    analysis: {
      status: "analyzed",
      assessment: group.assessment,
      tasks: [{ taskId: "blocked", conditionId: "obstruction" }],
      conditions: [condition],
    },
  };
  const tasks = [
    {
      taskId: "blocked",
      conditionId: "obstruction",
      assessmentId: "assessment",
    },
  ];
  expect(sessionProblemItemHasBackendCards(item, tasks)).toBe(false);
  expect(
    isStalePendingSession(
      { id: "old-check", status: "capture-complete", items: [item] },
      [{ id: "old-check" }],
      tasks,
    ),
  ).toBe(false);
  expect(
    sessionProblemItemHasBackendCards(item, [
      ...tasks,
      { conditionId: "bulky", assessmentId: "assessment" },
    ]),
  ).toBe(true);
  expect(
    sessionProblemItemHasBackendCards(item, [
      ...tasks,
      { conditionId: "bulky", assessmentId: "another-assessment" },
    ]),
  ).toBe(false);
});
it("shows recovered questions and tasks once when the local copy also exists", async () => {
  list.mockResolvedValueOnce({ guidance: [group], nextToken: null });
  const pending = await loadPendingQuestionItems();
  const tasks = [
    {
      taskId: "blocked",
      conditionId: "obstruction",
      assessmentId: "assessment",
    },
  ];
  const local = [
    {
      id: "local",
      analysis: {
        status: "analyzed",
        assessment: group.assessment,
        tasks,
        conditions: [condition],
      },
    },
  ];
  expect(mergePendingQuestionItems(local, pending, tasks)).toEqual(pending);
});
it("does not conflate identical condition IDs from different assessments", async () => {
  list.mockResolvedValueOnce({
    guidance: [
      group,
      {
        ...group,
        assessment: { assessmentId: "another", checkId: "new-check" },
      },
    ],
    nextToken: null,
  });
  const pending = await loadPendingQuestionItems();
  expect(pending).toHaveLength(2);
  expect(pending[0].id).not.toBe(pending[1].id);
});
it("does not silently return a partial list on read failure", async () => {
  list
    .mockResolvedValueOnce({ guidance: [group], nextToken: "next" })
    .mockRejectedValueOnce(new Error("offline"));
  await expect(loadPendingQuestionItems()).rejects.toThrow("offline");
});

it("drops terminal local conditions without dropping unanswered siblings or local tasks", () => {
  const task = { taskId: "local-task", conditionId: "other" };
  const local = {
    id: "local",
    analysis: {
      status: "analyzed",
      assessment: group.assessment,
      conditions: [
        { conditionId: "done", status: "completed" },
        { conditionId: "removed", status: "rejected" },
        condition,
      ],
      tasks: [task],
    },
  };
  expect(mergePendingQuestionItems([local], [], [])[0].analysis).toMatchObject({
    conditions: [condition],
    tasks: [task],
  });
  expect(
    mergePendingQuestionItems(
      [
        {
          ...local,
          analysis: {
            ...local.analysis,
            conditions: [{ conditionId: "done", status: "completed" }],
            tasks: [],
          },
        },
      ],
      [],
      [],
    ),
  ).toEqual([]);
});

it("publishes recovered pages before historical pagination finishes", async () => {
  /** @type {(value: any) => void} */
  let release = () => {};
  list
    .mockResolvedValueOnce({ guidance: [group], nextToken: "older" })
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
  const onPage = vi.fn();
  const loading = loadPendingQuestionItems(onPage);
  await vi.waitFor(() => expect(onPage).toHaveBeenCalledOnce());
  expect(onPage.mock.calls[0][0][0].analysis.conditions).toEqual([condition]);
  release({ guidance: [], nextToken: null });
  expect(await loading).toHaveLength(1);
});
it.each(["rejected", "completed"])(
  "replaces retained local questions with authoritative %s state",
  async (status) => {
    read.mockResolvedValueOnce({
      ...group,
      conditions: [{ ...condition, status, needsAnswer: null }],
      tasks: [],
    });
    const items = await reconcileLocalGuidance([
      { id: "local", analysis: { status: "analyzed", ...group, tasks: [] } },
    ]);
    expect(mergePendingQuestionItems(items, [], [])).toEqual([]);
  },
);
it("adopts task completion or supersession from another device", async () => {
  const task = {
    taskId: "task",
    conditionId: "bulky",
    assessmentId: "assessment",
    status: "open",
  };
  read.mockResolvedValueOnce({
    ...group,
    conditions: [],
    tasks: [{ ...task, status: "superseded" }],
  });
  const items = await reconcileLocalGuidance([
    { id: "local", analysis: { status: "analyzed", ...group, tasks: [task] } },
  ]);
  expect(items[0].analysis.tasks[0].status).toBe("superseded");
  expect(mergePendingQuestionItems(items, [], items[0].analysis.tasks)).toEqual(
    [],
  );
});
it("does not silently reuse local questions when validation fails", async () => {
  read.mockRejectedValueOnce(new Error("unavailable"));
  await expect(reconcileLocalGuidance([{ analysis: group }])).rejects.toThrow(
    "unavailable",
  );
});

it.each([false, true])(
  "does not overwrite a local assessment advanced during validation (new identity: %s)",
  async (changedId) => {
    const item = {
      id: "local",
      analysis: {
        status: "analyzed",
        assessment: { assessmentId: "a", assessmentRevision: 1 },
        conditions: [condition],
        tasks: [],
      },
    };
    /** @type {(value:any)=>void} */ let release = () => {};
    read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const loading = reconcileLocalGuidance([item]);
    item.analysis.assessment = {
      assessmentId: changedId ? "successor" : "a",
      assessmentRevision: 2,
    };
    release({
      assessment: { assessmentId: "a", assessmentRevision: 1 },
      conditions: [],
      tasks: [],
    });
    const result = await loading;
    expect(result).toEqual([item]);
    expect(result[0].analysis.assessment.assessmentRevision).toBe(2);
  },
);

it("stops historical pagination after its refresh becomes obsolete", async () => {
  let active = true;
  list.mockResolvedValueOnce({ guidance: [], nextToken: "more" });
  await loadPendingQuestionItems(
    () => {
      active = false;
    },
    () => active,
  );
  expect(list).toHaveBeenCalledOnce();
});

it("keeps the captured photo when a server question replaces its local condition", () => {
  const local = {
    id: "local",
    kind: "photo",
    dataUrl: "data:image/webp;base64,AA",
    analysis: {
      status: "analyzed",
      artifactId: "photo",
      assessment: group.assessment,
      conditions: [condition],
      tasks: [],
    },
  };
  const pending = {
    id: "pending",
    kind: "unknown",
    checkId: "old-check",
    analysis: {
      artifactId: "photo",
      assessment: group.assessment,
      conditions: [condition],
    },
  };
  const result = mergePendingQuestionItems([local], [pending], []);
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({
    id: "pending",
    kind: "photo",
    dataUrl: local.dataUrl,
  });
  expect(result[0].analysis).toBe(pending.analysis);
});
