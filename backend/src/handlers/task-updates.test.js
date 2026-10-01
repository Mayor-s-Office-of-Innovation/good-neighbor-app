import {
  GetCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../db.js", () => ({ ddb: { send } }));

const { createTaskUpdate, getTaskUpdates, registerTaskUpdateMedia } =
  await import("./task-updates.js");

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

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.GNP_311_SUBMISSION_ENABLED;
    delete process.env.SF311_UPDATESR_URL;
    delete process.env.SF311_CREATESR_URL;
    delete process.env.SF311_AGENCY_LOOKUP_URL;
    delete process.env.SF311_BASIC_AUTH_USER;
    delete process.env.SF311_BASIC_AUTH_PASS;
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

  it("claims a silent-ticket resolution before calling the non-idempotent 311 API", async () => {
    process.env.GNP_311_SUBMISSION_ENABLED = "true";
    process.env.SF311_UPDATESR_URL = "https://hub.example.test/updatesr";
    process.env.SF311_CREATESR_URL = "https://hub.example.test/createsr";
    process.env.SF311_AGENCY_LOOKUP_URL = "https://hub.example.test/lookup";
    process.env.SF311_BASIC_AUTH_USER = "user";
    process.env.SF311_BASIC_AUTH_PASS = "pass";
    /** @type {string[]} */
    const order = [];
    send
      .mockImplementationOnce(async () => ({
        Item: {
          taskId: "task-1",
          status: "in_progress",
          kind: "non_actionable_escalation",
          severity: 4,
          inProgressAt: "2026-10-01T16:00:00.000Z",
          updatedAt: "2026-10-01T16:00:00.000Z",
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
                  },
                ],
              },
            },
          ],
        },
      }))
      .mockImplementationOnce(async () => ({}))
      .mockImplementationOnce(async () => {
        order.push("claim");
        return { Attributes: { status: "resolving" } };
      })
      .mockImplementationOnce(async () => {
        order.push("checkpoint");
        return {};
      })
      .mockImplementationOnce(async () => ({}));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        order.push("311");
        return new Response(
          JSON.stringify({ UpdateID: 4321, return_code: 0 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    const response = await /** @type {any} */ (
      createTaskUpdate(
        event({
          type: "additional_action_resolved",
          text: "The issue is resolved.",
        }),
      )
    );

    expect(order, response.body).toEqual(["claim", "311", "checkpoint"]);
    expect(response.statusCode, response.body).toBe(201);
    const finalWrite = send.mock.calls[4][0].input.TransactItems[2].Put;
    expect(finalWrite.ConditionExpression).toBe(
      "#status = :expected AND #lease = :lease",
    );
    expect(finalWrite.ExpressionAttributeValues[":expected"]).toBe("resolving");
  });

  it("returns a failed silent-ticket closure to in progress for retry", async () => {
    process.env.GNP_311_SUBMISSION_ENABLED = "true";
    process.env.SF311_UPDATESR_URL = "https://hub.example.test/updatesr";
    process.env.SF311_CREATESR_URL = "https://hub.example.test/createsr";
    process.env.SF311_AGENCY_LOOKUP_URL = "https://hub.example.test/lookup";
    process.env.SF311_BASIC_AUTH_USER = "user";
    process.env.SF311_BASIC_AUTH_PASS = "pass";
    send
      .mockResolvedValueOnce({
        Item: {
          taskId: "task-1",
          status: "in_progress",
          kind: "non_actionable_escalation",
          severity: 4,
          inProgressAt: "2026-10-01T16:00:00.000Z",
          updatedAt: "2026-10-01T16:00:00.000Z",
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
                  },
                ],
              },
            },
          ],
        },
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Attributes: { status: "resolving" } })
      .mockResolvedValueOnce({ Attributes: { status: "in_progress" } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Promise.resolve(new Response("service unavailable", { status: 503 })),
      ),
    );

    const response = await /** @type {any} */ (
      createTaskUpdate(
        event({
          type: "additional_action_resolved",
          text: "The issue is resolved.",
        }),
      )
    );

    expect(response.statusCode).toBe(502);
    expect(JSON.parse(response.body)).toMatchObject({
      error: "311 ticket closure incomplete",
      retryable: true,
      task: { status: "in_progress" },
    });
    expect(send.mock.calls[3][0]).toBeInstanceOf(UpdateCommand);
    expect(send.mock.calls[3][0].input.UpdateExpression).toContain(
      "#status = :inProgress",
    );
  });

  it("does not call 311 when another resolution request wins the claim", async () => {
    process.env.GNP_311_SUBMISSION_ENABLED = "true";
    const conflict = new Error("claim lost");
    conflict.name = "ConditionalCheckFailedException";
    send
      .mockResolvedValueOnce({
        Item: {
          taskId: "task-1",
          status: "in_progress",
          kind: "non_actionable_escalation",
          severity: 4,
          inProgressAt: "2026-10-01T16:00:00.000Z",
          updatedAt: "2026-10-01T16:00:00.000Z",
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
                  },
                ],
              },
            },
          ],
        },
      })
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(conflict);
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);

    const response = await /** @type {any} */ (
      createTaskUpdate(
        event({
          type: "additional_action_resolved",
          text: "The issue is resolved.",
        }),
      )
    );

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body)).toEqual({
      error: "Task resolution in progress",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
