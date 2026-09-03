import {
  BatchGetCommand,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../db.js", () => ({ ddb: { send } }));

const {
  cannotDoTask,
  completeTask,
  evaluateAssessment,
  getGuidance,
  submitConditionAnswers,
} = await import("./guidance.js");

/**
 * @param {object} opts
 * @param {Record<string, string>} [opts.pathParameters]
 * @param {unknown} [opts.body]
 * @returns {any}
 */
const event = ({ pathParameters, body } = {}) => ({
  pathParameters,
  requestContext: {
    authorizer: { jwt: { claims: { "custom:siteId": "site-1" } } },
  },
  body: body === undefined ? undefined : JSON.stringify(body),
});

/**
 * @param {any} handler
 * @param {any} ev
 * @returns {Promise<any>}
 */
const invoke = (handler, ev) =>
  /** @type {any} */ (handler(ev, /** @type {any} */ ({}), () => {}));

/**
 * @param {{ body?: string }} res
 * @returns {any}
 */
const parse = (res) => JSON.parse(res.body ?? "{}");

describe("guidance handlers", () => {
  beforeEach(() => {
    send.mockReset();
    process.env.S3_UPLOAD_BUCKET = "bucket";
    process.env.SQS_QUEUE_URL = "queue";
    process.env.DYNAMO_TABLE = "table";
    delete process.env.GNP_311_SUBMISSION_ENABLED;
  });

  it("evaluates an analyzer-style assessment and persists guidance records", async () => {
    send.mockResolvedValueOnce({});

    const res = await invoke(
      evaluateAssessment,
      event({
        body: {
          assessmentId: "asm-1",
          checkId: "chk-1",
          assessment: {
            metadata: {
              reported_at: "2026-08-18T12:00:00.000Z",
              latitude: 37.7,
              longitude: -122.4,
              position_descriptor: "front",
            },
            general_conditions: { label: "Poor", description: "x" },
            identified_conditions_of_concern: [
              { category: "Litter", severity: 3, description: "trash" },
            ],
          },
        },
      }),
    );

    expect(res.statusCode).toBe(201);
    const command = send.mock.calls[0][0];
    expect(command).toBeInstanceOf(TransactWriteCommand);
    const writes = /** @type {any[]} */ (command.input.TransactItems);
    expect(writes[0].Put.Item).toMatchObject({
      pk: "SITE#site-1",
      sk: "ASSESSMENT#asm-1",
      checkId: "chk-1",
      grade: "Poor",
      reportedAt: "2026-08-18T12:00:00.000Z",
    });
    expect(writes[1].Put.Item).toMatchObject({
      sk: "ASSESSMENT#asm-1#COND#001-litter",
      source: {
        latitude: 37.7,
        longitude: -122.4,
        positionDescriptor: "front",
      },
    });
    expect(writes[2].Put.Item.ruleId).toBe("LITTER-2");
    expect(parse(res).tasks).toHaveLength(1);
  });

  it("preserves top-level grade from explicit check-completion assessments", async () => {
    send.mockResolvedValueOnce({});

    const res = await invoke(
      evaluateAssessment,
      event({
        body: {
          assessmentId: "chk-1",
          checkId: "chk-1",
          reportedAt: "2026-08-18T12:00:00.000Z",
          grade: "Poor",
          conditions: [{ category: "Litter", severity: 3 }],
        },
      }),
    );

    expect(res.statusCode).toBe(201);
    const writes = /** @type {any[]} */ (
      send.mock.calls[0][0].input.TransactItems
    );
    expect(writes[0].Put.Item).toMatchObject({
      assessmentId: "chk-1",
      checkId: "chk-1",
      grade: "Poor",
    });
  });

  it("returns existing guidance on idempotent evaluate replay", async () => {
    send.mockRejectedValueOnce(
      Object.assign(new Error("cancelled"), {
        name: "TransactionCanceledException",
      }),
    );
    send.mockResolvedValueOnce({ Item: { assessmentId: "asm-1" } });
    send.mockResolvedValueOnce({ Items: [{ conditionId: "c1", taskIds: [] }] });

    const res = await invoke(
      evaluateAssessment,
      event({
        body: {
          assessmentId: "asm-1",
          reportedAt: "2026-08-18T12:00:00.000Z",
          conditions: [{ category: "Litter", severity: 3 }],
        },
      }),
    );

    expect(res.statusCode).toBe(200);
    expect(send.mock.calls[1][0]).toBeInstanceOf(GetCommand);
    expect(send.mock.calls[2][0]).toBeInstanceOf(QueryCommand);
    expect(parse(res)).toMatchObject({
      assessment: { assessmentId: "asm-1" },
      conditions: [{ conditionId: "c1" }],
      tasks: [],
    });
  });

  it("does not treat a canceled evaluation as idempotent without stored guidance", async () => {
    send.mockRejectedValueOnce(
      Object.assign(new Error("cancelled"), {
        name: "TransactionCanceledException",
      }),
    );
    send.mockResolvedValueOnce({});
    send.mockResolvedValueOnce({ Items: [] });

    const res = await invoke(
      evaluateAssessment,
      event({
        body: {
          assessmentId: "asm-1",
          reportedAt: "2026-08-18T12:00:00.000Z",
          conditions: [{ category: "Litter", severity: 3 }],
        },
      }),
    );

    expect(res.statusCode).toBe(409);
    expect(parse(res)).toEqual({
      error: "Assessment evaluation was not stored",
    });
  });

  it("rejects assessments that exceed the transaction budget", async () => {
    const res = await invoke(
      evaluateAssessment,
      event({
        body: {
          assessmentId: "asm-1",
          reportedAt: "2026-08-18T12:00:00.000Z",
          conditions: Array.from({ length: 50 }, (_, index) => ({
            category: "Litter",
            severity: index % 6,
          })),
        },
      }),
    );

    expect(res.statusCode).toBe(400);
    expect(parse(res).error).toContain("Too many conditions");
    expect(send).not.toHaveBeenCalled();
  });

  it("gets assessment guidance with condition tasks", async () => {
    send.mockResolvedValueOnce({ Item: { assessmentId: "asm-1" } });
    send.mockResolvedValueOnce({
      Items: [{ conditionId: "c1", taskIds: ["task-1"] }],
    });
    send.mockResolvedValueOnce({
      Responses: { table: [{ taskId: "task-1" }] },
    });

    const res = await invoke(
      getGuidance,
      event({ pathParameters: { assessmentId: "asm-1" } }),
    );

    expect(res.statusCode).toBe(200);
    expect(send.mock.calls[0][0]).toBeInstanceOf(GetCommand);
    expect(send.mock.calls[1][0]).toBeInstanceOf(QueryCommand);
    expect(send.mock.calls[0][0].input.ConsistentRead).toBe(true);
    expect(send.mock.calls[1][0].input.ConsistentRead).toBe(true);
    expect(send.mock.calls[2][0]).toBeInstanceOf(BatchGetCommand);
    expect(parse(res)).toMatchObject({
      assessment: { assessmentId: "asm-1" },
      tasks: [{ taskId: "task-1" }],
    });
  });

  it("submits condition answers and creates the resolved task", async () => {
    send.mockResolvedValueOnce({
      Item: {
        pk: "SITE#site-1",
        sk: "ASSESSMENT#asm-1",
        assessmentId: "asm-1",
        status: "needs_answers",
        policyVersion: "actions-escalations-v2",
        summary: {
          totalConditions: 1,
          conditionsNeedAnswer: 1,
          conditionsResolvedToTasks: 0,
          openTaskCount: 0,
          actionCount: 0,
          escalationCount: 0,
          emergencyCount: 0,
          manualReviewCount: 0,
        },
      },
    });
    send.mockResolvedValueOnce({
      Item: {
        pk: "SITE#site-1",
        sk: "ASSESSMENT#asm-1#COND#cond-1",
        conditionId: "cond-1",
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
      },
    });
    send.mockResolvedValueOnce({});

    const res = await invoke(
      submitConditionAnswers,
      event({
        pathParameters: { assessmentId: "asm-1", conditionId: "cond-1" },
        body: { answers: { onsite: false } },
      }),
    );

    expect(res.statusCode).toBe(200);
    const tx = send.mock.calls[2][0];
    expect(tx).toBeInstanceOf(TransactWriteCommand);
    const assessment = tx.input.TransactItems[0].Put.Item;
    expect(assessment).toMatchObject({
      status: "tasks_created",
      summary: {
        conditionsNeedAnswer: 0,
        conditionsResolvedToTasks: 1,
        openTaskCount: 1,
        escalationCount: 1,
      },
    });
    const condition = tx.input.TransactItems[1].Put.Item;
    expect(condition).toMatchObject({
      status: "tasks_created",
      selectedRuleId: "GRAFFITI-2",
      answers: { onsite: false },
      resolvedToTasks: true,
    });
    expect(condition).not.toHaveProperty("gsi5pk");
    expect(tx.input.TransactItems[2].Put.Item).toMatchObject({
      ruleId: "GRAFFITI-2",
      conditionId: "cond-1",
      kind: "escalation",
    });
  });

  it("records cannot-do on a task", async () => {
    send.mockResolvedValueOnce({
      Item: {
        pk: "SITE#site-1",
        sk: "TASK#task-1",
        taskId: "task-1",
        status: "open",
        kind: "action",
        severity: 2,
        cannotDoReasons: ["It doesn't feel safe"],
      },
    });
    send.mockResolvedValueOnce({});

    const res = await invoke(
      cannotDoTask,
      event({
        pathParameters: { taskId: "task-1" },
        body: { reason: "It doesn't feel safe", note: "dark outside" },
      }),
    );

    expect(res.statusCode).toBe(200);
    const tx = send.mock.calls[1][0];
    expect(tx.input.TransactItems[0].Put.Item).toMatchObject({
      status: "cannot_do",
      cannotDo: { reason: "It doesn't feel safe", note: "dark outside" },
      gsi2pk: "SITE#site-1#TASK#cannot_do",
    });
  });

  it("completes a task and records app action results", async () => {
    process.env.GNP_311_SUBMISSION_ENABLED = "false";
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

    const res = await invoke(
      completeTask,
      event({
        pathParameters: { taskId: "task-1" },
        body: { completionMethod: "button" },
      }),
    );

    expect(res.statusCode).toBe(200);
    const tx = send.mock.calls[2][0];
    expect(tx.input.TransactItems[0].Put.Item).toMatchObject({
      status: "completed",
      completionMethod: "button",
      appActionStatus: "skipped",
      gsi2pk: "SITE#site-1#TASK#completed",
      appActionResults: [
        {
          code: "create_311_ticket",
          status: "skipped",
          reason: "feature_disabled",
        },
      ],
    });
  });

  it("reports an active task completion lease as in progress", async () => {
    send.mockResolvedValueOnce({
      Item: {
        pk: "SITE#site-1",
        sk: "TASK#task-1",
        taskId: "task-1",
        status: "completing",
        completionLeaseExpiresAt: "2999-08-18T12:03:00.000Z",
      },
    });

    const res = await invoke(
      completeTask,
      event({
        pathParameters: { taskId: "task-1" },
        body: { completionMethod: "button" },
      }),
    );

    expect(res.statusCode).toBe(409);
    expect(parse(res)).toEqual({
      error: "Task completion already in progress",
    });
  });
});
