import { beforeEach, expect, it, vi } from "vitest";
const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../db.js", () => ({ ddb: { send } }));
import { descriptionWrites } from "./description-edits.js";

beforeEach(() => {
  send.mockReset();
});

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

it.each(["valid", "wrong-check", "wrong-photo", "superseded"])(
  "edits an assessment-backed question without an artifact pointer: %s",
  async (state) => {
    send
      .mockResolvedValueOnce({
        Item: {
          assessmentRevision: 2,
          checkId: state === "wrong-check" ? "other" : "check",
          ...(state === "superseded"
            ? { supersededByAssessmentId: "successor" }
            : {}),
        },
      })
      .mockResolvedValueOnce({
        Item: {
          status: "needs_answer",
          taskIds: [],
          source: {
            artifactIds: [state === "wrong-photo" ? "other" : "artifact"],
          },
        },
      });
    const result = descriptionWrites({
      table: "table",
      siteId: "site",
      checkId: "check",
      artifactId: "artifact",
      conditionId: "condition",
      assessmentId: "assessment",
      description: "Synthetic correction",
    });
    if (state === "valid") {
      expect((await result).writes).toHaveLength(2);
      expect(send.mock.calls[0][0].input.Key.sk).toBe("ASSESSMENT#assessment");
    } else await expect(result).rejects.toMatchObject({ status: 409 });
  },
);

it("rejects a question revision that changed after the initial details read", async () => {
  send
    .mockResolvedValueOnce({ Item: { assessmentId: "assessment" } })
    .mockResolvedValueOnce({ Item: { assessmentRevision: 4 } })
    .mockResolvedValueOnce({ Item: { status: "needs_answer", taskIds: [] } });
  await expect(
    descriptionWrites({
      table: "table",
      siteId: "site",
      checkId: "check",
      artifactId: "artifact",
      conditionId: "condition",
      description: "Synthetic correction",
      revision: 3,
    }),
  ).rejects.toMatchObject({ status: 409 });
});

it("stores the retry identity atomically with question text", async () => {
  send
    .mockResolvedValueOnce({ Item: { assessmentId: "assessment" } })
    .mockResolvedValueOnce({ Item: { assessmentRevision: 3 } })
    .mockResolvedValueOnce({ Item: { status: "needs_answer", taskIds: [] } });
  const edit = await descriptionWrites({
    table: "table",
    siteId: "site",
    checkId: "check",
    artifactId: "artifact",
    conditionId: "condition",
    description: "Synthetic correction",
    revision: 3,
    requestId: "same-save",
  });
  expect(edit.writes[1]).toMatchObject({
    Update: { ExpressionAttributeValues: { ":requestId": "same-save" } },
  });
  expect(edit.condition?.detailsEditId).toBe("same-save");
});

it.each([
  "retained",
  "removed",
  "replaced",
  "wrong-photo",
  "wrong-check",
  "rejected",
])(
  "resolves a superseded task assessment only for its surviving condition: %s",
  async (state) => {
    /** @type {Record<string, any>} */
    const rows = {
      "ASSESSMENT#original": {
        checkId: "check",
        lineageId: "artifact",
        supersededByAssessmentId: "middle",
      },
      'GUIDANCE_CURRENT#["check","artifact"]': { assessmentId: "current" },
      "ASSESSMENT#current": {
        checkId: state === "wrong-check" ? "other" : "check",
        assessmentRevision: 4,
      },
      "ASSESSMENT#current#COND#survivor":
        state === "removed"
          ? undefined
          : {
              status: state === "rejected" ? "rejected" : "tasks_created",
              taskIds: [
                state === "replaced" ? "replacement-task" : "retained-task",
              ],
              source: {
                artifactIds: [state === "wrong-photo" ? "other" : "artifact"],
              },
            },
    };
    send.mockImplementation(async (command) => ({
      Item: rows[command.input.Key.sk],
    }));
    const task = {
      taskId: "retained-task",
      assessmentId: "original",
      conditionId: "survivor",
      checkId: "check",
      sourceArtifactIds: ["artifact"],
      status: "open",
    };
    const result = descriptionWrites({
      table: "table",
      siteId: "site",
      task,
      description: "Edited surviving issue",
      title: "Edited title",
    });
    if (state !== "retained") {
      await expect(result).rejects.toMatchObject({ status: 409 });
      return;
    }
    const edit = await result;
    expect(edit.writes[0]).toMatchObject({
      Update: {
        Key: { sk: "ASSESSMENT#current" },
        ExpressionAttributeValues: { ":prior": 4, ":next": 5 },
      },
    });
    expect(edit.writes[1]).toMatchObject({
      Update: {
        Key: { sk: "ASSESSMENT#current#COND#survivor" },
        ExpressionAttributeValues: {
          ":retainedTask": "retained-task",
          ":title": "Edited title",
        },
      },
    });
    expect(edit.writes[0].Update?.ConditionExpression).toContain(
      "attribute_not_exists(supersededByAssessmentId)",
    );
    expect(edit.writes[1].Update?.ConditionExpression).toContain(
      "contains(taskIds, :retainedTask)",
    );
    expect(task.assessmentId).toBe("original");
  },
);

it("bounds redirect loops while assessments are changing", async () => {
  send.mockImplementation(async (command) => ({
    Item: command.input.Key.sk.startsWith("GUIDANCE_CURRENT#")
      ? { assessmentId: "original" }
      : { supersededByAssessmentId: "next" },
  }));
  await expect(
    descriptionWrites({
      table: "table",
      siteId: "site",
      task: {
        taskId: "task",
        status: "open",
        assessmentId: "original",
        conditionId: "condition",
      },
      description: "Synthetic edit",
    }),
  ).rejects.toMatchObject({ status: 409 });
});
