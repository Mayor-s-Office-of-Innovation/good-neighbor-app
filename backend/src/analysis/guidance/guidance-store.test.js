import {
  BatchGetCommand,
  GetCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../../db.js", () => ({ ddb: { send } }));

const {
  answerCondition,
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
      assessmentRevision: 0,
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

  it("records a disputed category but mints no task for it", async () => {
    // Litter sev 3 normally resolves to an escalation task (see the first test);
    // marking it "I don't see this problem" must suppress that task while keeping
    // the condition as a terminal record for false-positive analysis.
    const result = await storeEvaluatedAssessment(
      {
        siteId: "site-1",
        assessmentId: "asm-3",
        checkId: "chk-3",
        reportedAt: "2026-08-18T12:00:00.000Z",
        rawAssessment: {},
        conditions: [{ category: "Litter", severity: 3, description: "trash" }],
        disputedCategories: ["Litter"],
      },
      {
        tableName: "table",
        now: new Date("2026-08-18T12:01:00.000Z"),
        idFactory: vi.fn(),
      },
    );

    const writes = /** @type {any[]} */ (
      send.mock.calls[0][0].input.TransactItems
    );
    // Only the assessment + the condition — no TASK# item.
    expect(writes).toHaveLength(2);
    expect(result.taskItems).toHaveLength(0);

    const assessment = writes[0].Put.Item;
    expect(assessment.summary).toMatchObject({
      totalConditions: 1,
      conditionsResolvedToTasks: 0,
      openTaskCount: 0,
      disputedCount: 1,
    });

    const condition = writes[1].Put.Item;
    expect(condition).toMatchObject({
      sk: "ASSESSMENT#asm-3#COND#001-litter",
      entityType: "CONDITION",
      status: "disputed",
      disputed: true,
      disputeDisposition: "not_present",
      resolvedToTasks: false,
      taskIds: [],
    });
    // Terminal — must not surface in the unresolved (needs-answer/manual) queue.
    expect(condition).not.toHaveProperty("gsi5pk");
    expect(condition.selectedRuleId).toBeNull();
    expect(condition.outcome).toBeNull();
  });

  it("suppresses tasks for a 'not_present' disposition (via dispositions map)", async () => {
    // Same suppression as disputedCategories, driven by the richer dispositions map
    // keyed by the condition's stable conditionId.
    const result = await storeEvaluatedAssessment(
      {
        siteId: "site-1",
        assessmentId: "asm-4",
        checkId: "chk-4",
        reportedAt: "2026-08-18T12:00:00.000Z",
        rawAssessment: {},
        conditions: [{ category: "Litter", severity: 3, description: "trash" }],
        dispositions: { "001-litter": "not_present" },
      },
      {
        tableName: "table",
        now: new Date("2026-08-18T12:01:00.000Z"),
        idFactory: vi.fn(),
      },
    );

    expect(result.taskItems).toHaveLength(0);
    const condition = result.conditionItems[0];
    expect(condition).toMatchObject({
      status: "disputed",
      disputed: true,
      disputeDisposition: "not_present",
      resolvedToTasks: false,
    });
  });

  it("records a 'worse'/'better' disposition as feedback but still mints its task", async () => {
    // better/worse/other are reviewer feedback only: the condition evaluates and
    // mints its task exactly as if unmarked, but the disposition is persisted.
    const result = await storeEvaluatedAssessment(
      {
        siteId: "site-1",
        assessmentId: "asm-5",
        checkId: "chk-5",
        reportedAt: "2026-08-18T12:00:00.000Z",
        rawAssessment: {},
        conditions: [{ category: "Litter", severity: 3, description: "trash" }],
        dispositions: { "001-litter": "worse" },
      },
      {
        tableName: "table",
        now: new Date("2026-08-18T12:01:00.000Z"),
        idFactory: vi.fn(),
      },
    );

    // Task still minted (Litter sev 3 → escalation), just as the undisputed path.
    expect(result.taskItems).toHaveLength(1);
    const condition = result.conditionItems[0];
    expect(condition).toMatchObject({
      disputed: false,
      disputeDisposition: "worse",
      resolvedToTasks: true,
    });
    expect(condition.status).not.toBe("disputed");
    // Not a suppression, so it must not count toward disputedCount.
    expect(result.assessmentItem.summary.disputedCount).toBe(0);
  });

  it("disputing one condition by conditionId does not suppress a sibling sharing its category", async () => {
    // Two Litter conditions get distinct conditionIds (001-litter, 002-litter).
    // A not_present disposition keyed to the first must suppress ONLY that task,
    // leaving the second to evaluate and mint normally — the whole point of keying
    // dispositions by conditionId rather than by category.
    const result = await storeEvaluatedAssessment(
      {
        siteId: "site-1",
        assessmentId: "asm-6",
        checkId: "chk-6",
        reportedAt: "2026-08-18T12:00:00.000Z",
        rawAssessment: {},
        conditions: [
          { category: "Litter", severity: 3, description: "north trash" },
          { category: "Litter", severity: 3, description: "south trash" },
        ],
        dispositions: { "001-litter": "not_present" },
      },
      {
        tableName: "table",
        now: new Date("2026-08-18T12:01:00.000Z"),
        idFactory: vi.fn(),
      },
    );

    // First condition suppressed, second still mints its task.
    expect(result.taskItems).toHaveLength(1);
    expect(result.assessmentItem.summary).toMatchObject({
      totalConditions: 2,
      disputedCount: 1,
      openTaskCount: 1,
    });

    const [first, second] = result.conditionItems;
    expect(first).toMatchObject({
      conditionId: "001-litter",
      status: "disputed",
      disputed: true,
      disputeDisposition: "not_present",
      resolvedToTasks: false,
    });
    expect(second).toMatchObject({
      conditionId: "002-litter",
      disputed: false,
      disputeDisposition: null,
      resolvedToTasks: true,
    });
  });
});

describe("answerCondition", () => {
  beforeEach(() => {
    send.mockReset();
  });

  it("retries parent assessment revision conflicts with a fresh summary", async () => {
    const assessmentBase = {
      pk: "SITE#site-1",
      sk: "ASSESSMENT#asm-1",
      assessmentId: "asm-1",
      status: "needs_answers",
      policyVersion: "actions-escalations-v2",
      summary: {
        totalConditions: 2,
        conditionsNeedAnswer: 2,
        conditionsResolvedToTasks: 0,
        openTaskCount: 0,
        actionCount: 0,
        escalationCount: 0,
        emergencyCount: 0,
        manualReviewCount: 0,
      },
    };
    const condition = {
      pk: "SITE#site-1",
      sk: "ASSESSMENT#asm-1#COND#cond-2",
      conditionId: "cond-2",
      assessmentId: "asm-1",
      checkId: "chk-1",
      policyVersion: "actions-escalations-v2",
      status: "needs_answer",
      analyzerCategory: "Graffiti",
      canonicalCategory: "Graffiti",
      severity: 2,
      answers: {},
      taskIds: [],
      source: { artifactIds: ["art-1"] },
      gsi5pk: "SITE#site-1#CONDITION#UNRESOLVED",
      gsi5sk: "x",
    };
    send.mockResolvedValueOnce({
      Item: { ...assessmentBase, assessmentRevision: 0 },
    });
    send.mockResolvedValueOnce({ Item: condition });
    send.mockRejectedValueOnce(
      Object.assign(new Error("revision conflict"), {
        name: "TransactionCanceledException",
      }),
    );
    send.mockResolvedValueOnce({
      Item: {
        ...assessmentBase,
        assessmentRevision: 1,
        summary: {
          ...assessmentBase.summary,
          conditionsNeedAnswer: 1,
          conditionsResolvedToTasks: 1,
          openTaskCount: 1,
          escalationCount: 1,
        },
      },
    });
    send.mockResolvedValueOnce({ Item: condition });
    send.mockResolvedValueOnce({});

    const idFactory = vi
      .fn()
      .mockReturnValueOnce("task-conflicted")
      .mockReturnValueOnce("task-2");

    const result = await answerCondition({
      tableName: "table",
      siteId: "site-1",
      assessmentId: "asm-1",
      conditionId: "cond-2",
      answers: { onsite: false },
      idFactory,
      now: new Date("2026-08-18T12:02:00.000Z"),
    });

    expect(send).toHaveBeenCalledTimes(6);
    const finalTx = send.mock.calls[5][0];
    expect(finalTx).toBeInstanceOf(TransactWriteCommand);
    expect(finalTx.input.TransactItems[0].Put).toMatchObject({
      ConditionExpression:
        "attribute_exists(sk) AND (attribute_not_exists(#revision) OR #revision = :priorRevision)",
      ExpressionAttributeValues: { ":priorRevision": 1 },
    });
    expect(finalTx.input.TransactItems[0].Put.Item).toMatchObject({
      assessmentRevision: 2,
      status: "tasks_created",
      summary: {
        conditionsNeedAnswer: 0,
        conditionsResolvedToTasks: 2,
        openTaskCount: 2,
        escalationCount: 2,
      },
    });
    expect(result.taskItem).toMatchObject({ taskId: "task-2" });
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
    expect(send.mock.calls[0][0].input.ConsistentRead).toBe(true);
    const claimTx = send.mock.calls[1][0];
    expect(claimTx).toBeInstanceOf(TransactWriteCommand);
    expect(claimTx.input.TransactItems[0].Put).toMatchObject({
      ConditionExpression: "#status = :open",
      ExpressionAttributeValues: { ":open": "open" },
    });
    expect(claimTx.input.TransactItems[0].Put.Item).toMatchObject({
      status: "completing",
      appActionStatus: "executing",
      completionStartedAt: "2026-08-18T12:02:00.000Z",
    });
    expect(
      claimTx.input.TransactItems[0].Put.Item.completionLeaseExpiresAt,
    ).toBe("2026-08-18T12:07:00.000Z");

    const finalTx = send.mock.calls[2][0];
    expect(finalTx).toBeInstanceOf(TransactWriteCommand);
    expect(finalTx.input.TransactItems[0].Put).toMatchObject({
      ConditionExpression: "#status = :completing AND #lease = :leaseExpiresAt",
      ExpressionAttributeValues: {
        ":completing": "completing",
        ":leaseExpiresAt": "2026-08-18T12:07:00.000Z",
      },
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

  it("rejects an active completing task without re-running app actions", async () => {
    send.mockResolvedValueOnce({
      Item: {
        pk: "SITE#site-1",
        sk: "TASK#task-1",
        taskId: "task-1",
        status: "completing",
        completionLeaseExpiresAt: "2026-08-18T12:03:00.000Z",
      },
    });

    await expect(
      completeTaskWithAppActions({
        tableName: "table",
        siteId: "site-1",
        taskId: "task-1",
        completionMethod: "button",
        now: new Date("2026-08-18T12:02:00.000Z"),
      }),
    ).rejects.toMatchObject({ name: "TaskCompletionInProgress" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("reclaims an expired completing task", async () => {
    send.mockResolvedValueOnce({
      Item: {
        pk: "SITE#site-1",
        sk: "TASK#task-1",
        taskId: "task-1",
        status: "completing",
        completionStartedAt: "2026-08-18T11:55:00.000Z",
        completionLeaseExpiresAt: "2026-08-18T12:00:00.000Z",
        kind: "action",
        severity: 2,
        appActions: [],
      },
    });
    send.mockResolvedValueOnce({});
    send.mockResolvedValueOnce({});

    const task = await completeTaskWithAppActions({
      tableName: "table",
      siteId: "site-1",
      taskId: "task-1",
      completionMethod: "button",
      now: new Date("2026-08-18T12:02:00.000Z"),
    });

    const claimTx = send.mock.calls[1][0];
    expect(claimTx.input.TransactItems[0].Put).toMatchObject({
      ConditionExpression:
        "#status = :completing AND (attribute_not_exists(#lease) OR #lease <= :now)",
      ExpressionAttributeValues: {
        ":completing": "completing",
        ":now": "2026-08-18T12:02:00.000Z",
      },
    });
    expect(task).toMatchObject({
      status: "completed",
      completionStartedAt: "2026-08-18T11:55:00.000Z",
    });
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
    expect(send.mock.calls[0][0].input.ConsistentRead).toBe(true);
    expect(send.mock.calls[1][0].input.ConsistentRead).toBe(true);
  });
});
