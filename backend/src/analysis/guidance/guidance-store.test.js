import {
  BatchGetCommand,
  GetCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../../db.js", () => ({ ddb: { send } }));

const {
  completeTaskWithAppActions,
  getAssessmentGuidance,
  markTaskCannotDo,
  storeEvaluatedAssessment,
} = await import("./guidance-store.js");

/**
 * @param {BatchGetCommand} command
 * @returns {Record<string, string>[]}
 */
function batchKeys(command) {
  return /** @type {{ table: { Keys: Record<string, string>[] } }} */ (
    command.input.RequestItems
  ).table.Keys;
}

describe("storeEvaluatedAssessment", () => {
  beforeEach(() => {
    send.mockReset();
    send.mockResolvedValue({});
  });

  it("stores the assessment, conditions, and immediately resolvable tasks", async () => {
    const result = await storeEvaluatedAssessment(
      {
        siteId: "site-1",
        assessmentId: "asm-1",
        checkId: "chk-1",
        reportedAt: "2026-08-18T12:00:00.000Z",
        rubricVersion: "1.0.0",
        grade: "Poor",
        rawAssessment: { assessment: "payload" },
        conditions: [
          {
            category: "Litter",
            severity: 3,
            description: "trash",
            sourceArtifactIds: ["art-1"],
          },
          {
            category: "Graffiti",
            severity: 2,
            description: "tag",
            sourceArtifactIds: ["art-2"],
          },
        ],
      },
      {
        tableName: "table",
        now: new Date("2026-08-18T12:01:00.000Z"),
        idFactory: vi.fn().mockReturnValueOnce("task-1"),
      },
    );

    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0][0];
    expect(command).toBeInstanceOf(TransactWriteCommand);
    const writes = /** @type {any[]} */ (command.input.TransactItems);
    expect(writes).toHaveLength(4);

    const assessment = writes[0].Put.Item;
    expect(assessment).toMatchObject({
      pk: "SITE#site-1",
      sk: "ASSESSMENT#asm-1",
      entityType: "ASSESSMENT",
      status: "needs_answers",
      policyVersion: "actions-escalations-v2",
      gsi1pk: "SITE#site-1#ASSESSMENT",
      gsi1sk: "2026-08-18T12:00:00.000Z#asm-1",
      summary: {
        totalConditions: 2,
        conditionsNeedAnswer: 1,
        conditionsResolvedToTasks: 1,
        openTaskCount: 1,
        actionCount: 0,
        escalationCount: 1,
        emergencyCount: 0,
        manualReviewCount: 0,
      },
    });

    const litter = writes[1].Put.Item;
    expect(litter).toMatchObject({
      sk: "ASSESSMENT#asm-1#COND#001-litter",
      entityType: "CONDITION",
      policyVersion: "actions-escalations-v2",
      status: "tasks_created",
      selectedRuleId: "LITTER-2",
      taskIds: ["task-1"],
      resolvedToTasks: true,
      gsi4pk: "SITE#site-1#CONDITION#SEV#3",
      gsi4sk: "2026-08-18T12:00:00.000Z#asm-1#001-litter",
    });
    expect(litter).not.toHaveProperty("gsi5pk");

    const graffiti = writes[2].Put.Item;
    expect(graffiti).toMatchObject({
      sk: "ASSESSMENT#asm-1#COND#002-graffiti",
      policyVersion: "actions-escalations-v2",
      status: "needs_answer",
      needsAnswer: { key: "onsite" },
      resolvedToTasks: false,
      gsi4pk: "SITE#site-1#CONDITION#SEV#2",
      gsi5pk: "SITE#site-1#CONDITION#UNRESOLVED",
      gsi5sk: "2026-08-18T12:00:00.000Z#SEV#2#asm-1#002-graffiti",
    });

    const task = writes[3].Put.Item;
    expect(task).toMatchObject({
      pk: "SITE#site-1",
      sk: "TASK#task-1",
      entityType: "TASK",
      assessmentId: "asm-1",
      checkId: "chk-1",
      conditionId: "001-litter",
      ruleId: "LITTER-2",
      kind: "escalation",
      type: "city_escalation",
      status: "open",
      category: "Litter",
      severity: 3,
      appActionStatus: "pending",
      appActionResults: [],
      gsi2pk: "SITE#site-1#TASK#open",
      gsi2sk: "2026-08-18T12:01:00.000Z#escalation#3#task-1",
    });

    expect(result.taskItems).toHaveLength(1);
    expect(result.conditionItems).toHaveLength(2);
  });

  it("marks unresolved analyzer categories for manual review", async () => {
    await storeEvaluatedAssessment(
      {
        siteId: "site-1",
        assessmentId: "asm-2",
        reportedAt: "2026-08-18T12:00:00.000Z",
        rawAssessment: {},
        conditions: [{ category: "Unmapped", severity: 4 }],
      },
      {
        tableName: "table",
        now: new Date("2026-08-18T12:01:00.000Z"),
      },
    );

    const writes = /** @type {any[]} */ (
      send.mock.calls[0][0].input.TransactItems
    );
    expect(writes[0].Put.Item.status).toBe("manual_review");
    expect(writes[1].Put.Item).toMatchObject({
      status: "manual_review",
      resolvedToTasks: false,
      gsi5pk: "SITE#site-1#CONDITION#UNRESOLVED",
    });
    expect(writes).toHaveLength(2);
  });
});

describe("completeTaskWithAppActions", () => {
  beforeEach(() => {
    send.mockReset();
  });

  it("marks a task completed and records app action results", async () => {
    send.mockResolvedValueOnce({
      Item: {
        pk: "SITE#site-1",
        sk: "TASK#task-1",
        taskId: "task-1",
        status: "open",
        kind: "escalation",
        severity: 3,
        appActions: [
          {
            code: "create_311_ticket",
            payload: { category311: "Street and sidewalk cleaning" },
          },
        ],
      },
    });
    send.mockResolvedValueOnce({});
    send.mockResolvedValueOnce({});

    const task = await completeTaskWithAppActions({
      tableName: "table",
      siteId: "site-1",
      taskId: "task-1",
      completionMethod: "button",
      env: { GNP_311_SUBMISSION_ENABLED: "true" },
      now: new Date("2026-08-18T12:02:00.000Z"),
    });

    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[0][0]).toBeInstanceOf(GetCommand);
    const claimTx = send.mock.calls[1][0];
    expect(claimTx).toBeInstanceOf(TransactWriteCommand);
    expect(claimTx.input.TransactItems[0].Put).toMatchObject({
      ConditionExpression: "#status = :open",
      ExpressionAttributeValues: { ":open": "open" },
    });
    expect(claimTx.input.TransactItems[0].Put.Item).toMatchObject({
      status: "completing",
      appActionStatus: "executing",
    });

    const finalTx = send.mock.calls[2][0];
    expect(finalTx).toBeInstanceOf(TransactWriteCommand);
    expect(finalTx.input.TransactItems[0].Put).toMatchObject({
      ConditionExpression: "#status = :completing",
      ExpressionAttributeValues: { ":completing": "completing" },
    });
    expect(finalTx.input.TransactItems[0].Put.Item).toMatchObject({
      status: "completed",
      completedAt: "2026-08-18T12:02:00.000Z",
      completionMethod: "button",
      appActionStatus: "not_configured",
      appActionResults: [
        {
          code: "create_311_ticket",
          status: "not_configured",
          reason: "311_client_unavailable",
        },
      ],
      gsi2pk: "SITE#site-1#TASK#completed",
      gsi2sk: "2026-08-18T12:02:00.000Z#escalation#3#task-1",
    });
    expect(task).toMatchObject({ status: "completed" });
  });

  it("returns a stored completed task for an identical replay", async () => {
    send.mockResolvedValueOnce({
      Item: {
        pk: "SITE#site-1",
        sk: "TASK#task-1",
        taskId: "task-1",
        status: "completed",
        completionMethod: "button",
      },
    });

    const task = await completeTaskWithAppActions({
      tableName: "table",
      siteId: "site-1",
      taskId: "task-1",
      completionMethod: "button",
      now: new Date("2026-08-18T12:02:00.000Z"),
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(task).toMatchObject({
      status: "completed",
      completionMethod: "button",
    });
  });

  it("rejects a conflicting terminal completion replay", async () => {
    send.mockResolvedValueOnce({
      Item: {
        pk: "SITE#site-1",
        sk: "TASK#task-1",
        taskId: "task-1",
        status: "completed",
        completionMethod: "button",
      },
    });

    await expect(
      completeTaskWithAppActions({
        tableName: "table",
        siteId: "site-1",
        taskId: "task-1",
        completionMethod: "manual",
        now: new Date("2026-08-18T12:02:00.000Z"),
      }),
    ).rejects.toMatchObject({ name: "TerminalConflict" });
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("markTaskCannotDo", () => {
  beforeEach(() => {
    send.mockReset();
  });

  it("returns a stored cannot-do task for an identical replay", async () => {
    send.mockResolvedValueOnce({
      Item: {
        pk: "SITE#site-1",
        sk: "TASK#task-1",
        taskId: "task-1",
        status: "cannot_do",
        cannotDo: { reason: "It doesn't feel safe", note: "dark outside" },
      },
    });

    const task = await markTaskCannotDo({
      tableName: "table",
      siteId: "site-1",
      taskId: "task-1",
      reason: "It doesn't feel safe",
      note: "dark outside",
      now: new Date("2026-08-18T12:02:00.000Z"),
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(task).toMatchObject({ status: "cannot_do" });
  });
});

describe("getAssessmentGuidance", () => {
  beforeEach(() => {
    send.mockReset();
  });

  it("retries unprocessed task keys and chunks large task reads", async () => {
    const taskIds = Array.from({ length: 101 }, (_, index) => `task-${index}`);
    send.mockResolvedValueOnce({ Item: { assessmentId: "asm-1" } });
    send.mockResolvedValueOnce({
      Items: [{ conditionId: "c1", taskIds }],
    });
    send.mockResolvedValueOnce({
      Responses: { table: [{ taskId: "task-0" }] },
      UnprocessedKeys: {
        table: {
          Keys: [{ pk: "SITE#site-1", sk: "TASK#task-1" }],
        },
      },
    });
    send.mockResolvedValueOnce({
      Responses: { table: [{ taskId: "task-1" }] },
    });
    send.mockResolvedValueOnce({
      Responses: { table: [{ taskId: "task-100" }] },
    });

    const guidance = await getAssessmentGuidance({
      tableName: "table",
      siteId: "site-1",
      assessmentId: "asm-1",
    });

    const batchCalls = send.mock.calls
      .map((call) => call[0])
      .filter((command) => command instanceof BatchGetCommand);
    expect(batchCalls).toHaveLength(3);
    /** @type {[BatchGetCommand, BatchGetCommand, BatchGetCommand]} */
    const typedBatchCalls = [
      /** @type {BatchGetCommand} */ (batchCalls[0]),
      /** @type {BatchGetCommand} */ (batchCalls[1]),
      /** @type {BatchGetCommand} */ (batchCalls[2]),
    ];
    const [firstBatch, retryBatch, secondBatch] = typedBatchCalls;
    expect(batchKeys(firstBatch)).toHaveLength(100);
    expect(batchKeys(retryBatch)).toEqual([
      { pk: "SITE#site-1", sk: "TASK#task-1" },
    ]);
    expect(batchKeys(secondBatch)).toHaveLength(1);
    expect(guidance.tasks).toEqual([
      { taskId: "task-0" },
      { taskId: "task-1" },
      { taskId: "task-100" },
    ]);
  });
});
