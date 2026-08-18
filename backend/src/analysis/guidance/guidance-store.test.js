import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../../db.js", () => ({ ddb: { send } }));

const { storeEvaluatedAssessment } = await import("./guidance-store.js");

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
