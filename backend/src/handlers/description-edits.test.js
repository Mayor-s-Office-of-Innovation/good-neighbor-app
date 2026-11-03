import { beforeEach, expect, it, vi } from "vitest";
const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../db.js", () => ({ ddb: { send } }));
import { descriptionWrites } from "./description-edits.js";

beforeEach(() => send.mockReset());

it.each(["needs_answer", "manual_review"])(
  "guards a pending %s condition at transaction time",
  async (status) => {
    send
      .mockResolvedValueOnce({ Item: { assessmentId: "assessment" } })
      .mockResolvedValueOnce({ Item: { assessmentRevision: 2 } })
      .mockResolvedValueOnce({ Item: { status, taskIds: [] } });
    const result = await descriptionWrites({
      table: "table",
      siteId: "site",
      checkId: "check",
      artifactId: "artifact",
      conditionId: "condition",
      description: "Synthetic correction",
    });
    expect(result.writes[1]).toMatchObject({
      Update: {
        ConditionExpression:
          "attribute_exists(sk) AND #status = :conditionStatus",
        ExpressionAttributeValues: { ":conditionStatus": status },
      },
    });
  },
);

it("preserves edits of an open task whose condition already created tasks", async () => {
  send
    .mockResolvedValueOnce({ Item: { assessmentRevision: 2 } })
    .mockResolvedValueOnce({
      Item: { status: "tasks_created", taskIds: ["task"] },
    });
  const task = {
    taskId: "task",
    assessmentId: "assessment",
    conditionId: "condition",
    status: "open",
  };
  const result = await descriptionWrites({
    table: "table",
    siteId: "site",
    task,
    description: "Synthetic correction",
  });
  expect(result.tasks).toEqual([task]);
  expect(result.writes[1]).toMatchObject({
    Update: {
      ExpressionAttributeValues: { ":conditionStatus": "tasks_created" },
    },
  });
});
