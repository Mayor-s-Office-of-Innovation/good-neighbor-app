import {
  BatchGetCommand,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { activeCatalog } from "./catalog-registry.js";

const { send, queue311Filing } = vi.hoisted(() => ({
  send: vi.fn(),
  queue311Filing: vi.fn(),
}));
vi.mock("../../db.js", () => ({ ddb: { send } }));
vi.mock("./sf311-filing-queue.js", () => ({ queue311Filing }));

const {
  answerCondition,
  completeTaskWithAppActions,
  getAssessmentGuidance,
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

  it.each([1, 24])(
    "keeps maximum admitted tasks, jobs and %i evidence guards atomic",
    async (evidenceCount) => {
      const evidence = Array.from(
        { length: evidenceCount },
        (_, i) => `artifact-${i}`,
      );
      const condition = {
        category: "Litter",
        severity: 1,
        sourceArtifactIds: evidence,
      };
      const input = {
        siteId: "site-1",
        assessmentId: "budget",
        checkId: "check-1",
        reportedAt: "2026-10-30T12:00:00Z",
        rawAssessment: { artifactId: evidence[0] },
        conditions: [condition],
      };
      const limit = Math.floor((100 - 2 - evidenceCount) / 3);
      input.conditions = Array.from({ length: limit }, () => ({
        ...condition,
      }));
      mockTaskShortIdAllocation();
      let sequence = 0;
      const result = await storeEvaluatedAssessment(input, {
        tableName: "table",
        idFactory: () => `task-${sequence++}`,
        env: { GNP_311_SUBMISSION_ENABLED: "true" },
      });
      const transaction = send.mock.calls
        .map(([command]) => command)
        .find((command) => command instanceof TransactWriteCommand);
      const items = transaction?.input.TransactItems || [];
      expect(result.taskItems).toHaveLength(limit);
      expect(items.filter((item) => item.ConditionCheck)).toHaveLength(
        evidenceCount,
      );
      expect(
        items.filter((item) => item.Put?.Item?.entityType === "SF311_OUTBOX"),
      ).toHaveLength(limit);
      expect(items.length).toBeLessThanOrEqual(100);
      send.mockClear();
      input.conditions.push(condition);
      await expect(
        storeEvaluatedAssessment(input, {
          tableName: "table",
          env: { GNP_311_SUBMISSION_ENABLED: "true" },
        }),
      ).rejects.toMatchObject({ name: "TransactionTooLarge" });
      expect(send).not.toHaveBeenCalled();
      input.conditions.pop();
      send.mockImplementation(async (command) => {
        if (command instanceof GetCommand)
          return { Item: result.assessmentItem };
        if (command instanceof QueryCommand)
          return { Items: result.conditionItems };
        if (command instanceof BatchGetCommand)
          return { Responses: { table: result.taskItems } };
        return {};
      });
      const revision = {
        ...input,
        assessmentId: "revision",
        previousAssessmentId: "budget",
      };
      const retained = await storeEvaluatedAssessment(revision, {
        tableName: "table",
      });
      expect(retained.taskItems.map((task) => task.taskId)).toEqual(
        result.taskItems.map((task) => task.taskId),
      );
      expect(
        send.mock.calls.some(([command]) => command instanceof UpdateCommand),
      ).toBe(false);
      send.mockClear();
      await expect(
        storeEvaluatedAssessment(
          {
            ...revision,
            conditions: input.conditions.map((condition) => ({
              ...condition,
              description: "Changed evidence",
            })),
          },
          { tableName: "table", env: { GNP_311_SUBMISSION_ENABLED: "true" } },
        ),
      ).rejects.toMatchObject({ name: "TransactionTooLarge" });
      expect(
        send.mock.calls.some(
          ([command]) =>
            command instanceof UpdateCommand ||
            command instanceof TransactWriteCommand,
        ),
      ).toBe(false);
    },
  );

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
            userFriendlyLabel: "Lots of trash in tree well",
            description: "trash",
            // The analyzer's single block: the store normalizes it to a map.
            translations: /** @type {any} */ ({
              language: "es",
              user_friendly_label: "Montón de basura",
              description: "basura",
            }),
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
    const writes = /** @type {any[]} */ (command.input.TransactItems).filter(
      (write) => !write.ConditionCheck,
    );
    expect(writes).toHaveLength(5);

    const assessment = writes[0].Put.Item;
    expect(assessment).toMatchObject({
      pk: "SITE#site-1",
      sk: "ASSESSMENT#asm-1",
      entityType: "ASSESSMENT",
      status: "needs_answers",
      policyVersion: activeCatalog().policyVersion,
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
      policyVersion: activeCatalog().policyVersion,
      status: "tasks_created",
      selectedRuleId: "LITTER-2",
      userFriendlyLabel: "Lots of trash in tree well",
      translations: {
        es: {
          user_friendly_label: "Montón de basura",
          description: "basura",
        },
      },
      taskIds: ["task-1"],
      resolvedToTasks: true,
    });
    // Conditions carry no index keys: GSI4/GSI5 were removed, nothing read them.
    expect(litter).not.toHaveProperty("gsi4pk");
    expect(litter).not.toHaveProperty("gsi5pk");

    const graffiti = writes[2].Put.Item;
    expect(graffiti).toMatchObject({
      sk: "ASSESSMENT#asm-1#COND#002-graffiti",
      policyVersion: activeCatalog().policyVersion,
      status: "needs_answer",
      needsAnswer: { key: "onsite" },
      resolvedToTasks: false,
    });
    expect(graffiti).not.toHaveProperty("gsi5pk");
    expect(graffiti).not.toHaveProperty("translations");

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
      canBeInProgress: true,
      primaryInProgressAgency: "Department of Public Works (DPW)",
      kind: "escalation",
      type: "city_escalation",
      status: "open",
      category: "Litter",
      severity: 3,
      userFriendlyLabel: "Lots of trash in tree well",
      translations: {
        es: {
          user_friendly_label: "Montón de basura",
          description: "basura",
        },
      },
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

  it("queues automatic 311 work atomically without waiting for external calls", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
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

    expect(send).toHaveBeenCalledTimes(3);
    expect(result.taskItems[0]).toMatchObject({
      taskId: "task-silent",
      shortId: "GUB-STJ-001",
      kind: "action",
    });
    const tx = send.mock.calls[2][0].input.TransactItems;
    expect(
      tx.some(
        /** @param {any} entry */ (entry) =>
          entry.Put?.Item?.entityType === "SF311_OUTBOX",
      ),
    ).toBe(true);
    expect(errorLog).not.toHaveBeenCalled();
    errorLog.mockRestore();
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
    });
    expect(writes).toHaveLength(2);
  });
});

describe("answerCondition", () => {
  beforeEach(() => {
    send.mockReset();
  });

  it("preserves the analyzer description after clarification, including revision retries", async () => {
    const assessmentBase = {
      pk: "SITE#site-1",
      sk: "ASSESSMENT#asm-1",
      assessmentId: "asm-1",
      status: "needs_answers",
      policyVersion: "actions-escalations-v3",
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
      policyVersion: "actions-escalations-v3",
      status: "needs_answer",
      analyzerCategory: "Graffiti",
      canonicalCategory: "Graffiti",
      severity: 2,
      userFriendlyLabel: "Tag covers most of wall",
      description: "Several spray-painted tags cover the exterior wall.",
      translations: {
        language: "fil",
        user_friendly_label: "Pinta ang mukha ng pader",
      },
      answers: {},
      taskIds: [],
      source: { artifactIds: ["art-1"] },
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
        "attribute_exists(sk) AND attribute_not_exists(supersededByAssessmentId) AND (attribute_not_exists(#revision) OR #revision = :priorRevision)",
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
    const taskWrite = finalTx.input.TransactItems.find(
      (/** @type {any} */ write) => write.Put?.Item?.entityType === "TASK",
    );
    expect(taskWrite.Put.Item.description).toBe(condition.description);
    expect(result.taskItem).toMatchObject({
      taskId: "task-2",
      shortId: "MOI-CIT-042",
      userFriendlyLabel: "Tag covers most of wall",
      description: "Several spray-painted tags cover the exterior wall.",
      translations: {
        fil: { user_friendly_label: "Pinta ang mukha ng pader" },
      },
    });
  });
});

describe("completeTaskWithAppActions", () => {
  it("replays a saved phone handoff without another write or app action", async () => {
    send.mockReset();
    const existing = {
      taskId: "phone",
      kind: "non_actionable_escalation",
      status: "in_progress",
      completionMethod: "manual",
    };
    send.mockResolvedValueOnce({ Item: existing });
    const result = await completeTaskWithAppActions({
      tableName: "table",
      siteId: "site-1",
      taskId: "phone",
      actorId: "device-1",
      completionMethod: "manual",
      env: {},
    });
    expect(result).toEqual(existing);
    expect(send).toHaveBeenCalledTimes(1);
  });

  beforeEach(() => {
    send.mockReset();
  });

  it("opens completion documentation for tasks that cannot be in progress", async () => {
    send
      .mockResolvedValueOnce({
        Item: {
          pk: "SITE#site-1",
          sk: "TASK#task-1",
          taskId: "task-1",
          status: "open",
          kind: "onsite",
          severity: 1,
          canBeInProgress: false,
          appActions: [],
        },
      })
      .mockResolvedValue({});
    const task = await completeTaskWithAppActions({
      tableName: "table",
      siteId: "site-1",
      taskId: "task-1",
      actorId: "device-1",
      completionMethod: "manual",
      env: { GNP_311_SUBMISSION_ENABLED: "false" },
    });
    const transaction = /** @type {any} */ (send.mock.calls.at(-1)?.[0]);
    expect(task.status).toBe("completed");
    expect(transaction.input.TransactItems[1].Put.Item).toMatchObject({
      updateId: task.latestUpdateId,
      type: "task_completed",
      actorId: "device-1",
      documentationState: "open_for_documentation",
    });
    expect(task.latestUpdateId).toBeTruthy();
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
    expect(finalTx.input.TransactItems[1].Put.Item).toMatchObject({
      entityType: "task_update",
      type: "task_completed",
      label: "Site marked as resolved",
      occurredAt: "2026-08-18T12:02:00.000Z",
    });
    expect(finalTx.input.TransactItems[2].Put.Item).toMatchObject({
      entityType: "task_update_pointer",
      updateId: finalTx.input.TransactItems[1].Put.Item.updateId,
    });
  });

  it.each(["We called 911", "Call SFPD"])(
    "moves a phone escalation to in progress: %s",
    async (label) => {
      send
        .mockResolvedValueOnce({
          Item: {
            pk: "SITE#site-1",
            sk: "TASK#task-1",
            taskId: "task-1",
            status: "open",
            kind: "non_actionable_escalation",
            severity: 4,
            canBeInProgress: true,
            primaryInProgressAgency: "SF Police Department (SFPD)",
            buttons: [label],
            appActions: [],
          },
        })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({});

      const task = await completeTaskWithAppActions({
        tableName: "table",
        siteId: "site-1",
        taskId: "task-1",
        completionMethod: "manual",
        actorId: "device-7",
        now: new Date("2026-10-01T18:00:00.000Z"),
      });

      expect(task).toMatchObject({
        status: "in_progress",
        inProgressAt: "2026-10-01T18:00:00.000Z",
        notifiedAt: "2026-10-01T18:00:00.000Z",
        agency: "SF Police Department (SFPD)",
        latestUpdateLabel: label,
        gsi2pk: "SITE#site-1#TASK#in_progress",
      });
      expect(task).not.toHaveProperty("completedAt");
      const writes = send.mock.calls[2][0].input.TransactItems;
      expect(writes).toHaveLength(3);
      expect(writes[1].Put.Item).toMatchObject({
        type: "escalation_action_taken",
        label,
        actorId: "device-7",
      });
      expect(writes[2].Put.Item).toMatchObject({
        entityType: "task_update_pointer",
        taskId: "task-1",
      });
    },
  );

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

  it("queues silent ticket closure in the task completion transaction", async () => {
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

      expect(task.status).toBe("completed");
      expect(task.appActionResults).toHaveLength(1);
      expect(fetchMock).not.toHaveBeenCalled();
      const tx = send.mock.calls.at(-1)?.[0].input.TransactItems;
      expect(
        tx.some(
          /** @param {any} entry */ (entry) =>
            entry.Put?.Item?.entityType === "SF311_OUTBOX",
        ),
      ).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("completes immediately even when City closure would fail", async () => {
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

      expect(task.status).toBe("completed");
      expect(task.appActionResults).toHaveLength(1);
      expect(fetchMock).not.toHaveBeenCalled();
      const tx = send.mock.calls.at(-1)?.[0].input.TransactItems;
      expect(
        tx.some(
          /** @param {any} entry */ (entry) =>
            entry.Put?.Item?.entityType === "SF311_OUTBOX",
        ),
      ).toBe(true);
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
      agency: "311",
      notifiedAt: "2026-08-18T12:02:00.000Z",
      latestUpdateLabel: "311 ticket filed",
    });
    const finalTransaction = /** @type {any} */ (send.mock.calls.at(-1)?.[0]);
    expect(finalTransaction.input.TransactItems[1].Put.Item).toMatchObject({
      type: "311_ticket_filed",
      label: "311 ticket filed",
      occurredAt: "2026-08-18T12:02:00.000Z",
      documentationState: "closed",
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

  it("retains the existing ticket while queuing closure", async () => {
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
      expect(persisted).toHaveLength(1);
      expect(persisted[0]).toMatchObject({
        code: "create_311_ticket",
        status: "submitted",
      });
      expect(fetchMock).not.toHaveBeenCalled();
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

describe("completeTaskWithAppActions with async 311 filing", () => {
  const now = new Date("2026-08-18T12:02:00.000Z");
  const env = {
    GNP_311_ASYNC_FILING: "true",
    GNP_311_SUBMISSION_ENABLED: "true",
  };
  /** @param {Record<string, unknown>} [overrides] */
  function task(overrides = {}) {
    return {
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
      ...overrides,
    };
  }
  /** @param {Record<string, unknown>} [overrides] */
  function file(overrides = {}) {
    return completeTaskWithAppActions({
      tableName: "table",
      siteId: "site-1",
      taskId: "task-1",
      completionMethod: "311_filed",
      actorId: "user-1",
      env,
      now,
      ...overrides,
    });
  }

  beforeEach(() => {
    send.mockReset();
    send.mockResolvedValue({});
    queue311Filing.mockReset();
  });

  it("hands the tap to the queue instead of filing inline", async () => {
    const existing = task();
    send.mockResolvedValueOnce({ Item: existing });
    queue311Filing.mockResolvedValueOnce({ status: "in_progress" });

    await expect(file()).resolves.toEqual({ status: "in_progress" });
    expect(queue311Filing).toHaveBeenCalledWith({
      tableName: "table",
      siteId: "site-1",
      taskId: "task-1",
      task: existing,
      filingDecision: expect.objectContaining({
        mode: "production",
        acceptedAt: now.toISOString(),
      }),
      actorId: "user-1",
      duplicateChecks: undefined,
      now,
    });
    // Read the task and Site flag; no claim, HUB call or final write.
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("keeps the in-request path while 311 submission is off", async () => {
    send.mockResolvedValueOnce({ Item: task() });

    const result = await file({
      env: {
        GNP_311_ASYNC_FILING: "true",
        GNP_311_SUBMISSION_ENABLED: "false",
      },
    });

    expect(queue311Filing).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "open",
      appActionStatus: "skipped",
    });
  });

  it("still rejects a task with no user-confirmed 311 action", async () => {
    send.mockResolvedValueOnce({ Item: task({ appActions: [] }) });

    await expect(file()).rejects.toMatchObject({
      name: "InvalidCompletionMethod",
    });
    expect(queue311Filing).not.toHaveBeenCalled();
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
          // A legacy task with no report-timeline stamp yet.
          createdAt: "2026-08-18T11:00:00.000Z",
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
      // Every full re-put re-derives the report timeline stamp, so a
      // legacy task is stamped here and a backfilled stamp is never lost.
      gsi1pk: "SITE#site-1#TASK",
      gsi1sk: "2026-08-18T11:00:00.000Z#task-1",
    });
  });

  it("accepts a concurrent terminal transition after strongly reconciling it", async () => {
    const task = {
      pk: "SITE#site-1",
      sk: "TASK#task-1",
      taskId: "task-1",
      status: "open",
      kind: "action",
      severity: 2,
      conditionId: "cond-litter",
    };
    const conflict = Object.assign(new Error("conditional conflict"), {
      name: "TransactionCanceledException",
      CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
    });
    send
      .mockResolvedValueOnce({ Items: [task] })
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({
        Responses: { table: [{ ...task, status: "completed" }] },
      });

    await expect(
      supersedeOpenTasksForCondition({
        tableName: "table",
        siteId: "site-1",
        conditionId: "cond-litter",
      }),
    ).resolves.toEqual({ supersededTaskIds: ["task-1"] });

    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[2][0]).toBeInstanceOf(BatchGetCommand);
  });

  it("retries only tasks that are still open after a conditional conflict", async () => {
    const task = {
      pk: "SITE#site-1",
      sk: "TASK#task-1",
      taskId: "task-1",
      status: "open",
      kind: "action",
      severity: 2,
      conditionId: "cond-litter",
    };
    const conflict = Object.assign(new Error("conditional conflict"), {
      name: "TransactionCanceledException",
      CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
    });
    send
      .mockResolvedValueOnce({ Items: [task] })
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({ Responses: { table: [task] } })
      .mockResolvedValueOnce({});

    await expect(
      supersedeOpenTasksForCondition({
        tableName: "table",
        siteId: "site-1",
        conditionId: "cond-litter",
      }),
    ).resolves.toEqual({ supersededTaskIds: ["task-1"] });

    expect(send).toHaveBeenCalledTimes(4);
    expect(send.mock.calls[3][0]).toBeInstanceOf(TransactWriteCommand);
  });

  it("propagates non-conditional transaction failures", async () => {
    const task = {
      pk: "SITE#site-1",
      sk: "TASK#task-1",
      taskId: "task-1",
      status: "open",
      kind: "action",
      severity: 2,
      conditionId: "cond-litter",
    };
    const capacityError = Object.assign(new Error("capacity"), {
      name: "TransactionCanceledException",
      CancellationReasons: [{ Code: "ProvisionedThroughputExceeded" }],
    });
    send
      .mockResolvedValueOnce({ Items: [task] })
      .mockRejectedValueOnce(capacityError);

    await expect(
      supersedeOpenTasksForCondition({
        tableName: "table",
        siteId: "site-1",
        conditionId: "cond-litter",
      }),
    ).rejects.toBe(capacityError);
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

describe("assessment refresh preserves unchanged conditions", () => {
  const previousCondition = {
    pk: "SITE#site-1",
    sk: "ASSESSMENT#original#COND#couch",
    assessmentId: "original",
    checkId: "check-1",
    conditionId: "couch",
    policyVersion: "actions-escalations-v3",
    analyzerCategory: "Bulky Items",
    severity: 3,
    description: "Couch on sidewalk",
    source: { artifactIds: ["photo-1"] },
    answers: { belongs_to_client: true },
    status: "tasks_created",
    resolvedToTasks: true,
    taskIds: ["existing-task"],
    needsAnswer: null,
  };
  const input = {
    siteId: "site-1",
    checkId: "check-1",
    assessmentId: "refreshed",
    previousAssessmentId: "original",
    reportedAt: "2026-09-11T12:00:00Z",
    rawAssessment: {},
    // The litter condition has been removed; the answered couch remains.
    conditions: [
      {
        conditionId: "couch",
        category: "Bulky Items",
        severity: 3,
        description: "Couch on sidewalk",
        sourceArtifactIds: ["photo-1"],
      },
    ],
  };
  beforeEach(() => send.mockReset());

  /** @param {{taskStatus?: string, checkId?: string}} [options] */
  function mockPrevious({ taskStatus = "open", checkId = "check-1" } = {}) {
    send.mockImplementation(async (command) => {
      if (command instanceof GetCommand)
        return {
          Item: {
            checkId,
            assessmentRevision: 1,
            policyVersion: "actions-escalations-v3",
            reportedAt: "2026-09-10T19:00:00Z",
          },
        };
      if (command instanceof QueryCommand)
        return { Items: [previousCondition] };
      if (command instanceof BatchGetCommand)
        return {
          Responses: {
            table: [
              {
                pk: "SITE#site-1",
                sk: "TASK#existing-task",
                taskId: "existing-task",
                conditionId: "couch",
                assessmentId: "original",
                kind: "action",
                status: taskStatus,
              },
            ],
          },
        };
      if (command instanceof UpdateCommand)
        return { Attributes: { nextTaskDisplayNumber: 2 } };
      return {};
    });
  }

  it.each(["open", "completed", "completing"])(
    "retains answers and the same %s task after deleting a sibling",
    async (taskStatus) => {
      mockPrevious({ taskStatus });
      const idFactory = vi.fn();
      const result = await storeEvaluatedAssessment(input, {
        tableName: "table",
        idFactory,
      });
      expect(result.conditionItems[0]).toMatchObject({
        assessmentId: "refreshed",
        answers: { belongs_to_client: true },
        status: "tasks_created",
        taskIds: ["existing-task"],
        needsAnswer: null,
      });
      expect(result.taskItems).toHaveLength(1);
      expect(result.taskItems[0]).toMatchObject({
        taskId: "existing-task",
        status: taskStatus,
      });
      expect(idFactory).not.toHaveBeenCalled();
      const transaction =
        send.mock.calls.find(
          ([command]) => command instanceof TransactWriteCommand,
        )?.[0].input.TransactItems ?? [];
      expect(
        transaction.filter((/** @type {any} */ entry) => entry.Put),
      ).toHaveLength(3);
      expect(transaction.at(-1)).toMatchObject({
        Update: {
          Key: { pk: "SITE#site-1", sk: "ASSESSMENT#original" },
          ConditionExpression:
            "attribute_not_exists(supersededByAssessmentId) AND (assessmentRevision = :revision OR attribute_not_exists(assessmentRevision))",
          ExpressionAttributeValues: {
            ":revision": 1,
            ":next": "refreshed",
            ":lineage": "original",
          },
        },
      });
      // A subsequent read uses the retained task IDs, rather than creating tasks again.
      send.mockImplementation(async (command) => {
        if (command instanceof GetCommand)
          return { Item: result.assessmentItem };
        if (command instanceof QueryCommand)
          return { Items: result.conditionItems };
        if (command instanceof BatchGetCommand)
          return { Responses: { table: result.taskItems } };
        return {};
      });
      const reloaded = await getAssessmentGuidance({
        tableName: "table",
        siteId: "site-1",
        assessmentId: "refreshed",
      });
      expect(reloaded.conditions[0].answers).toEqual(previousCondition.answers);
      expect(reloaded.tasks[0].taskId).toBe("existing-task");
    },
  );

  it("reevaluates changed conditions rather than carrying stale answers", async () => {
    mockPrevious();
    const result = await storeEvaluatedAssessment(
      {
        ...input,
        conditions: [
          { ...input.conditions[0], description: "Different object" },
        ],
      },
      { tableName: "table" },
    );
    expect(result.conditionItems[0].answers).toEqual({});
    expect(result.conditionItems[0].taskIds).not.toContain("existing-task");
  });

  /** Spanish map stored on the prior condition/task before the refresh. */
  const priorSpanish = {
    es: { user_friendly_label: "Sofá en la acera", description: "Sofá" },
  };
  /** Filipino map carried by the refreshed assessment. */
  const refreshedFilipino = {
    fil: {
      user_friendly_label: "Nakatagilid na sofa sa bangketa",
      description: "Nakatagilid na sofa",
    },
  };
  /** Per-locale merge of the two: the refresh adds Filipino, Spanish stays. */
  const mergedSpanishFilipino = { ...priorSpanish, ...refreshedFilipino };

  /** Read path with a translated prior condition + task for the refresh diffs. */
  function mockTranslatedPrevious() {
    mockPrevious();
    const original = send.getMockImplementation();
    send.mockImplementation(async (command) => {
      if (command instanceof QueryCommand)
        return {
          Items: [{ ...previousCondition, translations: priorSpanish }],
        };
      if (command instanceof BatchGetCommand)
        return {
          Responses: {
            table: [{ ...mockPreviousTask() }],
          },
        };
      return original?.(command);
    });
  }

  /** @returns {Record<string, unknown>} The prior stored task fixture. */
  function mockPreviousTask() {
    return {
      pk: "SITE#site-1",
      sk: "TASK#existing-task",
      taskId: "existing-task",
      conditionId: "couch",
      assessmentId: "original",
      kind: "action",
      status: "open",
      translations: priorSpanish,
    };
  }

  /**
   * Task-key Update entries in the refresh transaction (excludes the
   * predecessor supersede marker, which is always an Update too).
   * @param {any[] | undefined} tx
   * @returns {any[]}
   */
  function taskTranslationUpdates(tx) {
    return (tx ?? []).filter(
      (entry) => entry.Update?.Key?.sk === "TASK#existing-task",
    );
  }

  it("merges a refreshed translations map into a retained condition and task", async () => {
    mockTranslatedPrevious();
    const result = await storeEvaluatedAssessment(
      {
        ...input,
        conditions: [
          { ...input.conditions[0], translations: refreshedFilipino },
        ],
      },
      { tableName: "table" },
    );
    // Same English text, so the stored Spanish stays valid and Filipino joins it.
    expect(result.conditionItems[0].translations).toEqual(
      mergedSpanishFilipino,
    );
    expect(result.taskItems[0].translations).toEqual(mergedSpanishFilipino);
    const tx = send.mock.calls.find(
      ([command]) => command instanceof TransactWriteCommand,
    )?.[0].input.TransactItems;
    expect(tx).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          Update: expect.objectContaining({
            Key: { pk: "SITE#site-1", sk: "TASK#existing-task" },
            UpdateExpression: "SET translations = :translations",
            ExpressionAttributeValues: {
              ":translations": mergedSpanishFilipino,
            },
          }),
        }),
      ]),
    );
    // Changing display language must not retire the open task.
    expect(
      tx.filter(
        (/** @type {any} */ entry) =>
          entry.Put?.Item?.supersessionReason === "assessment_refreshed",
      ),
    ).toHaveLength(0);
  });

  it("keeps a retained condition's prior map when the refresh has none", async () => {
    mockTranslatedPrevious();
    const result = await storeEvaluatedAssessment(
      {
        ...input,
        conditions: [{ ...input.conditions[0], translations: undefined }],
      },
      { tableName: "table" },
    );
    expect(result.conditionItems[0].translations).toEqual(priorSpanish);
    expect(result.taskItems[0].translations).toEqual(priorSpanish);
    // Prior maps already match, so the transaction carries no task Updates.
    const tx = send.mock.calls.find(
      ([command]) => command instanceof TransactWriteCommand,
    )?.[0].input.TransactItems;
    expect(taskTranslationUpdates(tx)).toHaveLength(0);
  });

  it("applies a refreshed map to a retained condition that had none", async () => {
    mockPrevious();
    const original = send.getMockImplementation();
    send.mockImplementation(async (command) => {
      if (command instanceof BatchGetCommand)
        return {
          Responses: { table: [{ ...mockPreviousTask() }] },
        };
      return original?.(command);
    });
    const result = await storeEvaluatedAssessment(
      {
        ...input,
        conditions: [
          { ...input.conditions[0], translations: refreshedFilipino },
        ],
      },
      { tableName: "table" },
    );
    expect(result.conditionItems[0].translations).toEqual(refreshedFilipino);
    expect(result.taskItems[0].translations).toEqual(refreshedFilipino);
    const tx = send.mock.calls.find(
      ([command]) => command instanceof TransactWriteCommand,
    )?.[0].input.TransactItems;
    expect(taskTranslationUpdates(tx)).toHaveLength(1);
  });

  it("mirrors a translated map onto a retained task that had none", async () => {
    mockPrevious();
    const original = send.getMockImplementation();
    send.mockImplementation(async (command) => {
      if (command instanceof BatchGetCommand)
        return {
          Responses: {
            table: [
              {
                ...mockPreviousTask(),
                translations: undefined,
              },
            ],
          },
        };
      return original?.(command);
    });
    const result = await storeEvaluatedAssessment(
      {
        ...input,
        conditions: [
          { ...input.conditions[0], translations: refreshedFilipino },
        ],
      },
      { tableName: "table" },
    );
    expect(result.conditionItems[0].translations).toEqual(refreshedFilipino);
    expect(result.taskItems[0].translations).toEqual(refreshedFilipino);
    const tx = send.mock.calls.find(
      ([command]) => command instanceof TransactWriteCommand,
    )?.[0].input.TransactItems;
    expect(tx).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          Update: expect.objectContaining({
            Key: { pk: "SITE#site-1", sk: "TASK#existing-task" },
            UpdateExpression: "SET translations = :translations",
          }),
        }),
      ]),
    );
  });

  it("pins refreshed assessments and condition evaluation to the original report time", async () => {
    mockPrevious();
    const result = await storeEvaluatedAssessment(input, {
      tableName: "table",
    });

    expect(result.assessmentItem.reportedAt).toBe("2026-09-10T19:00:00Z");
    expect(result.assessmentItem.gsi1sk).toContain("2026-09-10T19:00:00Z");
    // A retained condition's pinned time was only observable through its GSI4
    // sort key, which no longer exists; the assessment assertions cover the pin.
  });

  it("does not reuse answers from different evidence", async () => {
    mockPrevious();
    const result = await storeEvaluatedAssessment(
      {
        ...input,
        conditions: [
          { ...input.conditions[0], sourceArtifactIds: ["different-photo"] },
        ],
      },
      { tableName: "table" },
    );
    expect(result.conditionItems[0].answers).toEqual({});
  });

  it("rejects a predecessor from another check", async () => {
    mockPrevious({ checkId: "other-check" });
    await expect(
      storeEvaluatedAssessment(input, { tableName: "table" }),
    ).rejects.toMatchObject({ name: "InvalidAssessmentRevision" });
    expect(
      send.mock.calls.some(
        ([command]) => command instanceof TransactWriteCommand,
      ),
    ).toBe(false);
  });
  it("rejects a refresh from an already replaced predecessor before writing", async () => {
    mockPrevious();
    const original = send.getMockImplementation();
    send.mockImplementation(async (command) =>
      command instanceof GetCommand
        ? {
            Item: {
              checkId: "check-1",
              assessmentRevision: 1,
              supersededByAssessmentId: "newer",
            },
          }
        : original?.(command),
    );
    await expect(
      storeEvaluatedAssessment(input, { tableName: "table" }),
    ).rejects.toMatchObject({ name: "AssessmentRevisionConflict" });
    expect(
      send.mock.calls.some(
        ([command]) => command instanceof TransactWriteCommand,
      ),
    ).toBe(false);
  });

  it("rejects answers to a replaced assessment without minting a task", async () => {
    send.mockResolvedValueOnce({ Item: { supersededByAssessmentId: "newer" } });
    send.mockResolvedValueOnce({ Item: { status: "needs_answer" } });
    await expect(
      answerCondition({
        tableName: "table",
        siteId: "site-1",
        assessmentId: "original",
        conditionId: "couch",
        answers: { belongs_to_client: true },
      }),
    ).rejects.toMatchObject({ name: "AssessmentRevisionConflict" });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])(
    "retires changed or removed sibling tasks atomically (removed: %s)",
    async (removed) => {
      mockPrevious();
      await storeEvaluatedAssessment(
        {
          ...input,
          conditions: removed
            ? []
            : [{ ...input.conditions[0], description: "A different couch" }],
        },
        { tableName: "table" },
      );
      const tx = send.mock.calls.find(
        ([command]) => command instanceof TransactWriteCommand,
      )?.[0].input.TransactItems;
      expect(tx).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            Put: expect.objectContaining({
              Item: expect.objectContaining({
                entityType: "ASSESSMENT",
                assessmentId: "refreshed",
              }),
            }),
          }),
          expect.objectContaining({
            Put: expect.objectContaining({
              Item: expect.objectContaining({
                taskId: "existing-task",
                status: "superseded",
                gsi2pk: "SITE#site-1#TASK#superseded",
              }),
              ConditionExpression:
                "#status = :open AND attribute_not_exists(updatedAt)",
            }),
          }),
        ]),
      );
    },
  );

  it("preserves completed history and refuses to replace a completing task", async () => {
    mockPrevious({ taskStatus: "completed" });
    await storeEvaluatedAssessment(
      { ...input, conditions: [] },
      { tableName: "table" },
    );
    const tx = send.mock.calls.find(
      ([command]) => command instanceof TransactWriteCommand,
    )?.[0].input.TransactItems;
    expect(
      tx.some(
        (/** @type {any} */ entry) =>
          entry.Put?.Item.taskId === "existing-task",
      ),
    ).toBe(false);
    send.mockReset();
    mockPrevious({ taskStatus: "completing" });
    await expect(
      storeEvaluatedAssessment(
        { ...input, conditions: [] },
        { tableName: "table" },
      ),
    ).rejects.toMatchObject({ name: "TaskTransitionConflict" });
    expect(
      send.mock.calls.some(
        ([command]) => command instanceof TransactWriteCommand,
      ),
    ).toBe(false);
  });

  it.each([true, false])(
    "requires explicit stable identity to retain artifact-less answers (%s)",
    async (explicitConditionId) => {
      mockPrevious();
      const original = send.getMockImplementation();
      send.mockImplementation(async (command) =>
        command instanceof QueryCommand
          ? {
              Items: [
                { ...previousCondition, source: {}, explicitConditionId },
              ],
            }
          : original?.(command),
      );
      const result = await storeEvaluatedAssessment(
        {
          ...input,
          conditions: [
            { ...input.conditions[0], sourceArtifactIds: undefined },
          ],
        },
        { tableName: "table" },
      );
      expect(result.conditionItems[0].answers).toEqual(
        explicitConditionId ? previousCondition.answers : {},
      );
      expect(
        result.taskItems.some((task) => task.taskId === "existing-task"),
      ).toBe(explicitConditionId);
    },
  );

  it("classifies a failed conditional publication as retryable without running task actions", async () => {
    mockPrevious();
    const original = send.getMockImplementation();
    send.mockImplementation(async (command) => {
      if (command instanceof TransactWriteCommand)
        throw Object.assign(new Error("race"), {
          name: "TransactionCanceledException",
          CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
        });
      return original?.(command);
    });
    await expect(
      storeEvaluatedAssessment(input, { tableName: "table" }),
    ).rejects.toMatchObject({ name: "AssessmentRevisionConflict" });
    expect(
      send.mock.calls.filter(
        ([command]) => command instanceof TransactWriteCommand,
      ),
    ).toHaveLength(1);
  });
});

it("atomically rejects an answer when another device confirms dismissal", async () => {
  send.mockReset();
  send.mockResolvedValueOnce({
    Item: {
      assessmentId: "a",
      checkId: "check",
      policyVersion: "actions-escalations-v3",
    },
  });
  send.mockResolvedValueOnce({
    Item: {
      conditionId: "c",
      status: "needs_answer",
      analyzerCategory: "Unrecognized",
      policyVersion: "actions-escalations-v3",
      source: { artifactIds: ["artifact"] },
    },
  });
  send.mockImplementationOnce(async (command) => {
    const tx = command.input.TransactItems;
    expect(tx.at(-1).ConditionCheck).toMatchObject({
      Key: { pk: "SITE#site", sk: "ISSUE_DELETION#check:artifact:c" },
      ConditionExpression:
        "attribute_not_exists(deletedAt) AND attribute_not_exists(dismissedAt)",
    });
    throw Object.assign(new Error("dismissal won"), {
      name: "TransactionCanceledException",
      CancellationReasons: tx.map(
        (/** @type {any} */ _, /** @type {number} */ i) => ({
          Code: i === tx.length - 1 ? "ConditionalCheckFailed" : "None",
        }),
      ),
    });
  });
  await expect(
    answerCondition({
      tableName: "table",
      siteId: "site",
      assessmentId: "a",
      conditionId: "c",
      answers: {},
    }),
  ).rejects.toMatchObject({ name: "ConditionDismissed" });
  expect(send).toHaveBeenCalledTimes(3);
});
