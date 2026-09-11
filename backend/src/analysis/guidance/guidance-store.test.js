import {
  BatchGetCommand,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
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
  supersedeOpenTasksForCondition,
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

/**
 * @param {object} [opts]
 * @param {string} [opts.providerShortCode]
 * @param {string} [opts.siteShortCode]
 * @param {number} [opts.nextTaskDisplayNumber]
 */
function mockTaskShortIdAllocation({
  providerShortCode = "MOI",
  siteShortCode = "CIT",
  nextTaskDisplayNumber = 1,
} = {}) {
  send.mockResolvedValueOnce({
    Item: { providerShortCode, siteShortCode },
  });
  send.mockResolvedValueOnce({
    Attributes: { nextTaskDisplayNumber },
  });
}

describe("storeEvaluatedAssessment", () => {
  beforeEach(() => {
    send.mockReset();
    send.mockResolvedValue({});
  });

  it("stores the assessment, conditions, and immediately resolvable tasks", async () => {
    mockTaskShortIdAllocation();

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

    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[0][0]).toBeInstanceOf(GetCommand);
    expect(send.mock.calls[0][0].input).toMatchObject({
      TableName: "table",
      Key: { pk: "SITE#site-1", sk: "#META" },
      ConsistentRead: true,
    });
    expect(send.mock.calls[1][0]).toBeInstanceOf(UpdateCommand);
    expect(send.mock.calls[1][0].input).toMatchObject({
      TableName: "table",
      Key: { pk: "SITE#site-1", sk: "COUNTER#task-display-id" },
      ExpressionAttributeValues: expect.objectContaining({ ":count": 1 }),
      ReturnValues: "UPDATED_NEW",
    });
    const command = send.mock.calls[2][0];
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
      shortId: "MOI-CIT-001",
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

  it("allocates one contiguous short-id block for multi-task assessments", async () => {
    mockTaskShortIdAllocation({
      providerShortCode: "GUB",
      siteShortCode: "STJ",
      nextTaskDisplayNumber: 12,
    });

    const result = await storeEvaluatedAssessment(
      {
        siteId: "site-1",
        assessmentId: "asm-many",
        reportedAt: "2026-08-18T12:00:00.000Z",
        rawAssessment: {},
        conditions: [
          { category: "Litter", severity: 3, description: "north trash" },
          { category: "Litter", severity: 3, description: "south trash" },
        ],
      },
      {
        tableName: "table",
        now: new Date("2026-08-18T12:01:00.000Z"),
        idFactory: vi
          .fn()
          .mockReturnValueOnce("task-11")
          .mockReturnValueOnce("task-12"),
      },
    );

    expect(send.mock.calls[1][0]).toBeInstanceOf(UpdateCommand);
    expect(send.mock.calls[1][0].input.ExpressionAttributeValues).toMatchObject(
      { ":count": 2 },
    );
    expect(result.taskItems.map((task) => task.shortId)).toEqual([
      "GUB-STJ-011",
      "GUB-STJ-012",
    ]);
    expect(result.conditionItems.map((condition) => condition.taskIds)).toEqual(
      [["task-11"], ["task-12"]],
    );
  });

  it("runs task-created 311 actions silently after minting an action task", async () => {
    mockTaskShortIdAllocation({
      providerShortCode: "GUB",
      siteShortCode: "STJ",
    });

    const result = await storeEvaluatedAssessment(
      {
        siteId: "site-1",
        assessmentId: "asm-silent",
        checkId: "chk-silent",
        reportedAt: "2026-08-18T12:00:00.000Z",
        rawAssessment: {},
        conditions: [
          {
            category: "Litter",
            severity: 1,
            description: "small litter",
          },
        ],
      },
      {
        tableName: "table",
        env: { GNP_311_SUBMISSION_ENABLED: "true" },
        now: new Date("2026-08-18T12:01:00.000Z"),
        idFactory: vi.fn().mockReturnValueOnce("task-silent"),
      },
    );

    expect(send).toHaveBeenCalledTimes(4);
    const task = result.taskItems[0];
    expect(task).toMatchObject({
      taskId: "task-silent",
      shortId: "GUB-STJ-001",
      kind: "action",
      appActionStatus: "failed",
      appActionResults: [
        {
          code: "create_311_ticket",
          status: "failed",
          payload: {
            serviceCodeOrAction: "1.1.4.7.20.0",
            responsibleAgencyCode: "76",
            executionTrigger: "task_created",
          },
        },
      ],
    });

    const updateTx = send.mock.calls[3][0];
    expect(updateTx).toBeInstanceOf(TransactWriteCommand);
    expect(updateTx.input.TransactItems[0].Put).toMatchObject({
      ConditionExpression: "#status = :open",
      ExpressionAttributeValues: { ":open": "open" },
    });
    expect(updateTx.input.TransactItems[0].Put.Item).toMatchObject({
      taskId: "task-silent",
      appActionStatus: "failed",
    });
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
    mockTaskShortIdAllocation({
      providerShortCode: "MOI",
      siteShortCode: "CIT",
      nextTaskDisplayNumber: 41,
    });
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
    mockTaskShortIdAllocation({
      providerShortCode: "MOI",
      siteShortCode: "CIT",
      nextTaskDisplayNumber: 42,
    });
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

    expect(send).toHaveBeenCalledTimes(10);
    const finalTx = send.mock.calls[9][0];
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
    expect(result.taskItem).toMatchObject({
      taskId: "task-2",
      shortId: "MOI-CIT-042",
    });
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
            payload: { serviceCodeOrAction: "1.1.4.7.20.0" },
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
      env: { GNP_311_SUBMISSION_ENABLED: "false" },
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
      appActionStatus: "skipped",
      appActionResults: [
        {
          code: "create_311_ticket",
          status: "skipped",
          reason: "feature_disabled",
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

  it("rejects 311-filed completion without a user-confirmed 311 app action", async () => {
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
            payload: {
              serviceCodeOrAction: "1.1.4.7.20.0",
              executionTrigger: "task_created",
            },
          },
        ],
      },
    });

    await expect(
      completeTaskWithAppActions({
        tableName: "table",
        siteId: "site-1",
        taskId: "task-1",
        completionMethod: "311_filed",
        now: new Date("2026-08-18T12:02:00.000Z"),
      }),
    ).rejects.toMatchObject({
      name: "InvalidCompletionMethod",
      message: "Task has no executable 311 filing action",
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("keeps a 311-filed task open when filing does not submit", async () => {
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
            payload: {
              serviceCodeOrAction: "1.1.4.7.20.0",
              executionTrigger: "user_confirmed",
            },
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
      completionMethod: "311_filed",
      env: { GNP_311_SUBMISSION_ENABLED: "false" },
      now: new Date("2026-08-18T12:02:00.000Z"),
    });

    expect(task).toMatchObject({
      status: "open",
      appActionStatus: "skipped",
      appActionResults: [
        {
          code: "create_311_ticket",
          status: "skipped",
          reason: "feature_disabled",
        },
      ],
    });
    const finalTx = send.mock.calls[2][0];
    expect(finalTx.input.TransactItems[0].Put.Item).toMatchObject({
      status: "open",
      completionLeaseExpiresAt: null,
      gsi2pk: "SITE#site-1#TASK#open",
    });
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

  it("closes an agency-76 ticket when completing with the done path", async () => {
    send.mockResolvedValueOnce({
      Item: {
        pk: "SITE#site-1",
        sk: "TASK#task-1",
        taskId: "task-1",
        status: "open",
        kind: "action",
        severity: 2,
        appActions: [
          {
            code: "create_311_ticket",
            payload: {
              serviceCodeOrAction: "1.1.4.7.20.0",
              executionTrigger: "task_created",
            },
          },
        ],
        appActionResults: [
          {
            code: "create_311_ticket",
            status: "submitted",
            payload: {
              tickets: [
                {
                  serviceCode: "1.1.4.7.20.0",
                  responsibleAgency: "76",
                  srNum: "2000008106",
                  attachments: [],
                },
              ],
            },
            externalId: "2000008106",
            recordedAt: "2026-08-18T11:00:00.000Z",
          },
        ],
      },
    });
    send.mockResolvedValueOnce({});
    send.mockResolvedValueOnce({});
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ UpdateID: 4321, return_code: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    try {
      const task = await completeTaskWithAppActions({
        tableName: "table",
        siteId: "site-1",
        taskId: "task-1",
        completionMethod: "manual",
        env: {
          GNP_311_SUBMISSION_ENABLED: "true",
          DYNAMO_TABLE: "table",
          S3_UPLOAD_BUCKET: "bucket",
          SQS_QUEUE_URL: "queue",
          SF311_CREATESR_URL: "https://hub.example.test/createsr",
          SF311_UPDATESR_URL: "https://hub.example.test/updatesr",
          SF311_AGENCY_LOOKUP_URL: "https://hub.example.test/lookup",
          SF311_BASIC_AUTH_USER: "user",
          SF311_BASIC_AUTH_PASS: "pass",
        },
        now: new Date("2026-08-18T12:02:00.000Z"),
      });

      expect(task).toMatchObject({
        status: "completed",
        completionMethod: "manual",
        appActionStatus: "submitted",
        appActionResults: [
          {
            code: "create_311_ticket",
            status: "submitted",
            externalId: "2000008106",
          },
          {
            code: "close_311_ticket",
            status: "submitted",
            payload: {
              closures: [
                {
                  serviceCode: "1.1.4.7.20.0",
                  srNum: "2000008106",
                  status: "closed",
                  updateId: "4321",
                },
              ],
            },
          },
        ],
      });
      const closeCall = fetchMock.mock.calls[0];
      expect(JSON.parse(closeCall[1].body)).toMatchObject({
        SRnum: "2000008106",
        UpdateType: "11",
        NumericSubType: "8",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("still completes the task when 311 closure fails", async () => {
    send.mockResolvedValueOnce({
      Item: {
        pk: "SITE#site-1",
        sk: "TASK#task-1",
        taskId: "task-1",
        status: "open",
        kind: "action",
        severity: 2,
        appActions: [
          {
            code: "create_311_ticket",
            payload: {
              serviceCodeOrAction: "1.1.4.7.20.0",
              executionTrigger: "task_created",
            },
          },
        ],
        appActionResults: [
          {
            code: "create_311_ticket",
            status: "submitted",
            payload: {
              tickets: [
                {
                  serviceCode: "1.1.4.7.20.0",
                  responsibleAgency: "76",
                  srNum: "2000008106",
                  attachments: [],
                },
              ],
            },
            externalId: "2000008106",
            recordedAt: "2026-08-18T11:00:00.000Z",
          },
        ],
      },
    });
    send.mockResolvedValueOnce({});
    send.mockResolvedValueOnce({});
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          return_code: 26,
          error_description: "SendingAgency Must Be ResponsibleAgency",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    try {
      const task = await completeTaskWithAppActions({
        tableName: "table",
        siteId: "site-1",
        taskId: "task-1",
        completionMethod: "manual",
        env: {
          GNP_311_SUBMISSION_ENABLED: "true",
          DYNAMO_TABLE: "table",
          S3_UPLOAD_BUCKET: "bucket",
          SQS_QUEUE_URL: "queue",
          SF311_CREATESR_URL: "https://hub.example.test/createsr",
          SF311_UPDATESR_URL: "https://hub.example.test/updatesr",
          SF311_AGENCY_LOOKUP_URL: "https://hub.example.test/lookup",
          SF311_BASIC_AUTH_USER: "user",
          SF311_BASIC_AUTH_PASS: "pass",
        },
        now: new Date("2026-08-18T12:02:00.000Z"),
      });

      expect(task).toMatchObject({
        status: "completed",
        appActionStatus: "partial",
        appActionResults: [
          { code: "create_311_ticket", status: "submitted" },
          {
            code: "close_311_ticket",
            status: "failed",
            payload: {
              closures: [
                { srNum: "2000008106", status: "failed", reason: "26" },
              ],
            },
          },
        ],
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("never synthesizes closure for the 311_filed completion path", async () => {
    send.mockResolvedValueOnce({
      Item: {
        pk: "SITE#site-1",
        sk: "TASK#task-1",
        taskId: "task-1",
        status: "open",
        kind: "escalation",
        severity: 3,
        location: {
          latitude: 37.76656393517443,
          longitude: -122.4213267021692,
        },
        appActions: [
          {
            code: "create_311_ticket",
            payload: {
              serviceCodeOrAction: "1.1.4.7.20.0",
              executionTrigger: "user_confirmed",
            },
          },
        ],
        appActionResults: [
          {
            code: "create_311_ticket",
            status: "submitted",
            payload: {
              tickets: [
                {
                  serviceCode: "1.1.4.7.20.0",
                  responsibleAgency: "76",
                  srNum: "2000008106",
                  attachments: [],
                },
              ],
            },
            externalId: "2000008106",
            recordedAt: "2026-08-18T11:00:00.000Z",
          },
        ],
      },
    });
    send.mockResolvedValueOnce({});
    send.mockResolvedValueOnce({});
    // The 311_filed path re-executes the user_confirmed filing action; the
    // prior ticket is reused (no CreateSR), and artifact lookup returns none.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ return_code: 0 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const task = await completeTaskWithAppActions({
      tableName: "table",
      siteId: "site-1",
      taskId: "task-1",
      completionMethod: "311_filed",
      env: {
        GNP_311_SUBMISSION_ENABLED: "true",
        DYNAMO_TABLE: "table",
        S3_UPLOAD_BUCKET: "bucket",
        SQS_QUEUE_URL: "queue",
        SF311_CREATESR_URL: "https://hub.example.test/createsr",
        SF311_UPDATESR_URL: "https://hub.example.test/updatesr",
        SF311_AGENCY_LOOKUP_URL: "https://hub.example.test/lookup",
        SF311_BASIC_AUTH_USER: "user",
        SF311_BASIC_AUTH_PASS: "pass",
      },
      now: new Date("2026-08-18T12:02:00.000Z"),
    });

    expect(task).toMatchObject({
      status: "completed",
      completionMethod: "311_filed",
    });
    // The user_confirmed filing re-ran (idempotent: prior ticket reused) and
    // no closure action was synthesized for the 311_filed path.
    expect(
      /** @type {{ code: string }[]} */ (task.appActionResults).some(
        (r) => r.code === "close_311_ticket",
      ),
    ).toBe(false);
  });

  it("records no closure when the 311 feature flag is disabled", async () => {
    send.mockResolvedValueOnce({
      Item: {
        pk: "SITE#site-1",
        sk: "TASK#task-1",
        taskId: "task-1",
        status: "open",
        kind: "action",
        severity: 2,
        appActions: [],
        appActionResults: [
          {
            code: "create_311_ticket",
            status: "submitted",
            payload: {
              tickets: [
                {
                  serviceCode: "1.1.4.7.20.0",
                  responsibleAgency: "76",
                  srNum: "2000008106",
                  attachments: [],
                },
              ],
            },
            externalId: "2000008106",
            recordedAt: "2026-08-18T11:00:00.000Z",
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
      completionMethod: "manual",
      env: { GNP_311_SUBMISSION_ENABLED: "false" },
      now: new Date("2026-08-18T12:02:00.000Z"),
    });

    expect(task).toMatchObject({
      status: "completed",
      appActionStatus: "submitted",
      appActionResults: [{ code: "create_311_ticket", status: "submitted" }],
    });
    expect(
      /** @type {{ code: string }[]} */ (task.appActionResults).some(
        (r) => r.code === "close_311_ticket",
      ),
    ).toBe(false);
  });

  it("final write merges prior results with the closure result", async () => {
    // Regression guard for the mid-completion checkpoint design: the final
    // completion write must carry BOTH the persisted create result (closure
    // eligibility on any later retry) and the fresh closure result. Replacing
    // the array here is exactly the clobber the merge-aware checkpoint exists
    // to prevent.
    send.mockResolvedValueOnce({
      Item: {
        pk: "SITE#site-1",
        sk: "TASK#task-1",
        taskId: "task-1",
        status: "open",
        kind: "action",
        severity: 2,
        appActions: [],
        appActionResults: [
          {
            code: "create_311_ticket",
            status: "submitted",
            payload: {
              tickets: [
                {
                  serviceCode: "1.1.4.7.20.0",
                  responsibleAgency: "76",
                  srNum: "2000008106",
                  attachments: [],
                },
              ],
            },
            externalId: "2000008106",
            recordedAt: "2026-08-18T11:00:00.000Z",
          },
        ],
      },
    });
    send.mockResolvedValueOnce({});
    send.mockResolvedValueOnce({});
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ UpdateID: 4321, return_code: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    try {
      await completeTaskWithAppActions({
        tableName: "table",
        siteId: "site-1",
        taskId: "task-1",
        completionMethod: "manual",
        env: {
          GNP_311_SUBMISSION_ENABLED: "true",
          DYNAMO_TABLE: "table",
          S3_UPLOAD_BUCKET: "bucket",
          SQS_QUEUE_URL: "queue",
          SF311_CREATESR_URL: "https://hub.example.test/createsr",
          SF311_UPDATESR_URL: "https://hub.example.test/updatesr",
          SF311_AGENCY_LOOKUP_URL: "https://hub.example.test/lookup",
          SF311_BASIC_AUTH_USER: "user",
          SF311_BASIC_AUTH_PASS: "pass",
        },
        now: new Date("2026-08-18T12:02:00.000Z"),
      });

      const finalTx = send.mock.calls.at(-1)?.[0];
      const persisted = /** @type {any} */ (finalTx?.input?.TransactItems?.[0])
        ?.Put?.Item?.appActionResults;
      expect(persisted).toMatchObject([
        { code: "create_311_ticket", status: "submitted" },
        {
          code: "close_311_ticket",
          status: "submitted",
          payload: {
            closures: [{ srNum: "2000008106", status: "closed" }],
          },
        },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("completes an onsite task whose only app action is a failed task_created 311 notification", async () => {
    // Onsite tasks carry a create_311_ticket (task_created) so the City gets a
    // dedup/awareness signal even though they won't dispatch. When that silent
    // notification failed at creation, a manual "we picked this up" completion
    // (user_confirmed) runs no actions for its trigger and must NOT inherit the
    // stale failure and roll the task back to open.
    send.mockResolvedValueOnce({
      Item: {
        pk: "SITE#site-1",
        sk: "TASK#task-1",
        taskId: "task-1",
        status: "open",
        kind: "action",
        severity: 2,
        appActions: [
          {
            code: "create_311_ticket",
            payload: {
              executionTrigger: "task_created",
              serviceCodeOrAction: null,
            },
          },
        ],
        appActionResults: [
          {
            code: "create_311_ticket",
            status: "failed",
            reason: "missing_service_code",
          },
        ],
        appActionStatus: "failed",
      },
    });
    send.mockResolvedValueOnce({});
    send.mockResolvedValueOnce({});

    const task = await completeTaskWithAppActions({
      tableName: "table",
      siteId: "site-1",
      taskId: "task-1",
      completionMethod: "manual",
      now: new Date("2026-08-18T12:02:00.000Z"),
    });

    // No external 311 call is attempted for a user_confirmed completion of a
    // task_created-only action: Get + claim + final write, nothing more.
    expect(send).toHaveBeenCalledTimes(3);
    const finalTx = send.mock.calls[2][0];
    expect(finalTx.input.TransactItems[0].Put.Item).toMatchObject({
      status: "completed",
      completedAt: "2026-08-18T12:02:00.000Z",
      completionMethod: "manual",
      gsi2pk: "SITE#site-1#TASK#completed",
    });
    expect(task).toMatchObject({ status: "completed" });
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

describe("supersedeOpenTasksForCondition", () => {
  beforeEach(() => {
    send.mockReset();
  });

  it("supersedes only open tasks for the amended condition and artifact", async () => {
    send.mockResolvedValueOnce({
      Items: [
        {
          pk: "SITE#site-1",
          sk: "TASK#task-1",
          taskId: "task-1",
          status: "open",
          kind: "action",
          severity: 2,
          conditionId: "cond-litter",
          checkId: "chk-1",
          assessmentId: "chk-1-art-1",
        },
        {
          pk: "SITE#site-1",
          sk: "TASK#task-2",
          taskId: "task-2",
          status: "open",
          kind: "escalation",
          severity: 3,
          conditionId: "cond-litter",
          checkId: "chk-1",
          assessmentId: "chk-1-art-2",
        },
      ],
    });
    send.mockResolvedValueOnce({});

    const result = await supersedeOpenTasksForCondition({
      tableName: "table",
      siteId: "site-1",
      conditionId: "cond-litter",
      checkId: "chk-1",
      assessmentIdPrefix: "chk-1-art-1",
      analysisId: "ana-1",
      reason: "analysis_condition_edited",
      now: new Date("2026-08-18T12:02:00.000Z"),
    });

    expect(result.supersededTaskIds).toEqual(["task-1"]);
    expect(send).toHaveBeenCalledTimes(2);
    const query = send.mock.calls[0][0];
    expect(query).toBeInstanceOf(QueryCommand);
    expect(query.input).toMatchObject({
      IndexName: "GSI2",
      KeyConditionExpression: "gsi2pk = :worklist",
      FilterExpression: "#conditionId = :conditionId",
      ExpressionAttributeValues: {
        ":worklist": "SITE#site-1#TASK#open",
        ":conditionId": "cond-litter",
      },
    });
    const tx = send.mock.calls[1][0];
    expect(tx).toBeInstanceOf(TransactWriteCommand);
    expect(tx.input.TransactItems).toHaveLength(1);
    const put = tx.input.TransactItems[0].Put;
    expect(put.ConditionExpression).toBe("#status = :open");
    expect(put.Item).toMatchObject({
      taskId: "task-1",
      status: "superseded",
      supersededAt: "2026-08-18T12:02:00.000Z",
      supersededByAnalysisId: "ana-1",
      supersessionReason: "analysis_condition_edited",
      gsi2pk: "SITE#site-1#TASK#superseded",
    });
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
