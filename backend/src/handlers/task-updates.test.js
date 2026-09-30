import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../db.js", () => ({ ddb: { send } }));

const {
  createTaskUpdate,
  getTaskUpdates,
  registerTaskUpdateMedia,
  startTaskProgress,
} = await import("./task-updates.js");

/** @param {Record<string, unknown>} body @param {Record<string, string>} [pathParameters] */
function event(body, pathParameters = { taskId: "task-1" }) {
  return /** @type {any} */ ({
    pathParameters,
    body: JSON.stringify(body),
    headers: { "idempotency-key": "request-1" },
    requestContext: {
      authorizer: {
        jwt: { claims: { "custom:siteId": "site-1", sub: "device-1" } },
      },
    },
  });
}

describe("task update handlers", () => {
  beforeEach(() => {
    send.mockReset();
    process.env.DYNAMO_TABLE = "tasks";
    process.env.S3_UPLOAD_BUCKET = "uploads";
    process.env.SQS_QUEUE_URL = "analysis";
  });

  it("moves a qualifying action to in progress and appends its event atomically", async () => {
    send
      .mockResolvedValueOnce({
        Item: {
          pk: "SITE#site-1",
          sk: "TASK#task-1",
          taskId: "task-1",
          status: "open",
          kind: "non_actionable_escalation",
          severity: 2,
          buttons: ["We called SFPD non-emergency"],
          createdAt: "2026-09-29T20:00:00.000Z",
        },
      })
      .mockResolvedValueOnce({});

    const response = await /** @type {any} */ (
      startTaskProgress(event({ actionLabel: "We called SFPD non-emergency" }))
    );

    expect(response.statusCode).toBe(200);
    expect(send.mock.calls[0][0]).toBeInstanceOf(GetCommand);
    const transaction = send.mock.calls[1][0];
    expect(transaction).toBeInstanceOf(TransactWriteCommand);
    const [eventPut, pointerPut, taskUpdate] = transaction.input.TransactItems;
    expect(eventPut.Put.Item).toMatchObject({
      type: "escalation_action_taken",
      label: "Called non-emergency line",
      agency: "SFPD",
      actorId: "device-1",
    });
    expect(pointerPut.Put.Item).toMatchObject({
      entityType: "task_update_pointer",
      updateId: "request-1",
      updateSk: eventPut.Put.Item.sk,
    });
    expect(taskUpdate.Update).toMatchObject({
      Key: { pk: "SITE#site-1", sk: "TASK#task-1" },
      ConditionExpression: "#status = :open",
    });
    expect(taskUpdate.Update.ExpressionAttributeValues).toMatchObject({
      ":inProgress": "in_progress",
      ":label": "Called non-emergency line",
      ":gsi2pk": "SITE#site-1#TASK#in_progress",
    });
  });

  it("registers update media without enqueuing analysis", async () => {
    send
      .mockResolvedValueOnce({
        Item: {
          taskId: "task-1",
          status: "in_progress",
          checkId: "check-1",
        },
      })
      .mockResolvedValueOnce({});

    const response = await /** @type {any} */ (
      registerTaskUpdateMedia(
        event({
          checkId: "check-1",
          artifactId: "photo-1",
          s3Key: "checks/site-1/check-1/photo-1",
          contentType: "image/jpeg",
        }),
      )
    );

    expect(response.statusCode).toBe(201);
    expect(send.mock.calls[1][0]).toBeInstanceOf(TransactWriteCommand);
    const [mediaPut, pointerPut] = send.mock.calls[1][0].input.TransactItems;
    expect(mediaPut.Put.Item).toMatchObject({
      sk: "TASK#task-1#MEDIA#photo-1",
      purpose: "task_update",
      taskId: "task-1",
      artifactId: "photo-1",
    });
    expect(pointerPut.Put.Item).toMatchObject({
      sk: "CHECK#check-1#UPDATE_MEDIA#photo-1",
      mediaSk: "TASK#task-1#MEDIA#photo-1",
    });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("reads a bounded timeline without sealing open documentation events", async () => {
    const openUpdate = {
      updateId: "update-1",
      documentationState: "open_for_documentation",
    };
    send
      .mockResolvedValueOnce({
        Item: { taskId: "task-1", status: "in_progress" },
      })
      .mockResolvedValueOnce({
        Items: [openUpdate],
        LastEvaluatedKey: {
          pk: "SITE#site-1",
          sk: "TASK#task-1#UPDATE#2026-09-30T12:00:00Z#update-1",
        },
      })
      .mockResolvedValueOnce({ Item: { flowType: "perimeter" } });

    const response = await /** @type {any} */ (getTaskUpdates(event({})));
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(body.updates).toEqual([openUpdate]);
    expect(body.nextToken).toBeTruthy();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0].input.Limit).toBe(50);
  });

  it.each([
    ["additional_action_resolved", "completed", "Resolved"],
    ["additional_action_still_present", "in_progress", "Still present"],
  ])(
    "records %s before opening its documentation step",
    async (type, status, latestUpdateLabel) => {
      send
        .mockResolvedValueOnce({
          Item: {
            pk: "SITE#site-1",
            sk: "TASK#task-1",
            taskId: "task-1",
            status: "in_progress",
            kind: "non_actionable_escalation",
            severity: 2,
            updatedAt: "2026-09-30T16:00:00.000Z",
          },
        })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({});

      const response = await /** @type {any} */ (
        createTaskUpdate(event({ type, text: "Power washed the sidewalk." }))
      );

      expect(response.statusCode).toBe(201);
      expect(send.mock.calls[1][0]).toBeInstanceOf(GetCommand);
      const transaction = send.mock.calls[2][0];
      expect(transaction).toBeInstanceOf(TransactWriteCommand);
      const [eventPut, pointerPut, taskPut] = transaction.input.TransactItems;
      expect(eventPut.Put.Item).toMatchObject({
        type,
        label: "Additional action taken",
        text: "Power washed the sidewalk.",
        documentationState: "open_for_documentation",
      });
      expect(taskPut.Put.Item).toMatchObject({ status, latestUpdateLabel });
      expect(pointerPut.Put.Item.updateSk).toBe(eventPut.Put.Item.sk);
      if (status === "completed")
        expect(taskPut.Put.Item).toMatchObject({
          completionMethod: "site_team_resolved",
        });
    },
  );

  it("scans legacy history only after a conflicting pointerless retry", async () => {
    const conflict = new Error("conflict");
    conflict.name = "TransactionCanceledException";
    const legacy = {
      updateId: "request-1",
      type: "note_photo_update",
      documentationState: "closed",
    };
    send
      .mockResolvedValueOnce({
        Item: {
          taskId: "task-1",
          status: "in_progress",
          updatedAt: "2026-09-30T16:00:00.000Z",
        },
      })
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({ Items: [legacy] });

    const response = await /** @type {any} */ (
      createTaskUpdate(
        event({
          type: "note_photo_update",
          notes: ["Still there"],
          photoKeys: [],
        }),
      )
    );

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).update).toEqual(legacy);
    expect(send.mock.calls[3][0].input.FilterExpression).toBe(
      "updateId = :updateId",
    );
  });
});
