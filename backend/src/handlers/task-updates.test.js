import {
  GetCommand,
  PutCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../db.js", () => ({ ddb: { send } }));

const { registerTaskUpdateMedia, startTaskProgress } = await import(
  "./task-updates.js"
);

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
    const [eventPut, taskPut] = transaction.input.TransactItems;
    expect(eventPut.Put.Item).toMatchObject({
      type: "escalation_action_taken",
      label: "Called non-emergency line",
      agency: "SFPD",
      actorId: "device-1",
    });
    expect(taskPut.Put.Item).toMatchObject({
      status: "in_progress",
      latestUpdateLabel: "Called non-emergency line",
      gsi2pk: "SITE#site-1#TASK#in_progress",
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
      registerTaskUpdateMedia(event({
          checkId: "check-1",
          artifactId: "photo-1",
          s3Key: "checks/site-1/check-1/photo-1",
          contentType: "image/jpeg",
        }))
    );

    expect(response.statusCode).toBe(201);
    expect(send.mock.calls[1][0]).toBeInstanceOf(PutCommand);
    expect(send.mock.calls[1][0].input.Item).toMatchObject({
      purpose: "task_update",
      taskId: "task-1",
      artifactId: "photo-1",
    });
    expect(send).toHaveBeenCalledTimes(2);
  });
});
