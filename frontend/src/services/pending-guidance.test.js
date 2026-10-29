import { beforeEach, expect, it, vi } from "vitest";
const list = vi.hoisted(() => vi.fn());
vi.mock("./api.js", () => ({ listPendingGuidance: list }));
const { loadPendingQuestionItems, mergePendingQuestionItems } = await import(
  "./pending-guidance.js"
);
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
beforeEach(() => list.mockReset());
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
