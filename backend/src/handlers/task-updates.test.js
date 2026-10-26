import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { send, headObject, setObjectTags } = vi.hoisted(() => ({
  send: vi.fn(),
  headObject: vi.fn(),
  setObjectTags: vi.fn(),
}));
vi.mock("../db.js", () => ({ ddb: { send } }));
vi.mock("../s3.js", () => ({ headObject, setObjectTags }));

const {
  createTaskUpdate,
  getTaskUpdates,
  registerTaskUpdateMedia,
  documentTaskUpdate,
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
    headObject.mockReset().mockResolvedValue({
      contentType: "image/jpeg",
      contentLength: 1024,
      metadata: { "declared-bytes": "1024" },
    });
    setObjectTags.mockReset().mockResolvedValue({});
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
    delete process.env.SF311_LATEST_UPDATES_URL;
    delete process.env.SF311_BASIC_AUTH_USER;
    delete process.env.SF311_BASIC_AUTH_PASS;
  });

  it.each([
    [false, true],
    [false, false],
    [true, true],
    [true, false],
  ])(
    "handles documentation replay (race: %s, identical: %s)",
    async (race, identical) => {
      const closed = {
        pk: "SITE#site-1",
        sk: "event-1",
        actorId: "device-1",
        documentationState: "closed",
        notes: ["Saved note"],
        photoKeys: ["photo-1"],
      };
      send
        .mockResolvedValueOnce({ Item: { updateSk: "event-1" } })
        .mockResolvedValueOnce({
          Item: {
            ...closed,
            documentationState: race ? "open_for_documentation" : "closed",
          },
        });
      if (race)
        send
          .mockRejectedValueOnce(
            Object.assign(new Error("race"), {
              name: "TransactionCanceledException",
            }),
          )
          .mockResolvedValueOnce({ Item: { updateSk: "event-1" } })
          .mockResolvedValueOnce({ Item: closed });
      const response = await documentTaskUpdate(
        event(
          {
            notes: [identical ? "Saved note" : "Different note"],
            photoKeys: ["photo-1"],
          },
          { taskId: "task-1", updateId: "update-1" },
        ),
      );
      expect(response.statusCode).toBe(identical ? 200 : 409);
      if (!identical)
        expect(JSON.parse(response.body).code).toBe("DocumentationConflict");
      expect(
        send.mock.calls.filter(
          ([command]) => command instanceof TransactWriteCommand,
        ),
      ).toHaveLength(race ? 1 : 0);
    },
  );

  it("treats a retry of a skipped event as success but rejects new content", async () => {
    const closed = {
      actorId: "device-1",
      documentationState: "closed",
      notes: [],
      photoKeys: [],
    };
    for (const notes of [[], ["New note"]]) {
      send
        .mockResolvedValueOnce({ Item: { updateSk: "event-1" } })
        .mockResolvedValueOnce({ Item: closed });
      const response = await documentTaskUpdate(
        event(
          { notes, photoKeys: [] },
          { taskId: "task-1", updateId: "update-1" },
        ),
      );
      expect(response.statusCode).toBe(notes.length ? 409 : 200);
    }
  });

  it.each(["completed", "in_progress", "missing", "deleted"])(
    "reports photo availability from the actual check: %s",
    async (status) => {
      send
        .mockResolvedValueOnce({
          Item: { taskId: "task-1", checkId: "check-1", status: "completed" },
        })
        .mockResolvedValueOnce({ Items: [] })
        .mockResolvedValueOnce({
          Item: status === "missing" ? undefined : { status },
        });
      const response = await getTaskUpdates(event({}));
      expect(JSON.parse(response.body).task.canUploadPhotos).toBe(
        ["completed", "in_progress"].includes(status),
      );
    },
  );

  it.each([true, false])(
    "persists completion documentation (skip: %s)",
    async (skip) => {
      const update = {
        pk: "SITE#site-1",
        sk: "TASKUPDATE#task-1#now#update-1",
        taskId: "task-1",
        updateId: "update-1",
        actorId: "device-1",
        type: "task_completed",
        documentationState: "open_for_documentation",
      };
      send
        .mockResolvedValueOnce({ Item: { updateSk: update.sk } })
        .mockResolvedValueOnce({ Item: update })
        .mockResolvedValueOnce({});
      const body = {
        notes: skip ? [] : ["Area cleaned"],
        photoKeys: skip ? [] : ["photo-1"],
      };
      const response = await documentTaskUpdate(
        event(body, { taskId: "task-1", updateId: "update-1" }),
      );
      expect(response.statusCode).toBe(200);
      const transaction = /** @type {any} */ (send.mock.calls.at(-1)?.[0]);
      expect(transaction.input.TransactItems[0].Put.Item).toMatchObject({
        ...update,
        ...body,
        documentationState: "closed",
      });
    },
  );

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
          contentLength: 1024,
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
      contentLength: 1024,
    });
    expect(pointerPut.Put.Item).toMatchObject({
      sk: "CHECK#check-1#UPDATE_MEDIA#photo-1",
      mediaSk: "TASK#task-1#MEDIA#photo-1",
    });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("accepts an exact retry after a conditional media conflict", async () => {
    const conflict = new Error("conflict");
    conflict.name = "TransactionCanceledException";
    send
      .mockResolvedValueOnce({
        Item: { taskId: "task-1", status: "in_progress", checkId: "check-1" },
      })
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({
        Item: {
          pk: "SITE#site-1",
          sk: "TASK#task-1#MEDIA#photo-1",
          taskId: "task-1",
          checkId: "check-1",
          artifactId: "photo-1",
          s3Key: "checks/site-1/check-1/photo-1",
          contentType: "image/jpeg",
          contentLength: 1024,
        },
      })
      .mockResolvedValueOnce({
        Item: {
          taskId: "task-1",
          checkId: "check-1",
          artifactId: "photo-1",
          mediaSk: "TASK#task-1#MEDIA#photo-1",
        },
      });

    const response = await /** @type {any} */ (
      registerTaskUpdateMedia(
        event({
          checkId: "check-1",
          artifactId: "photo-1",
          s3Key: "checks/site-1/check-1/photo-1",
          contentType: "image/jpeg",
          contentLength: 1024,
        }),
      )
    );

    expect(response.statusCode).toBe(200);
    expect(setObjectTags).toHaveBeenCalledWith(
      expect.objectContaining({ tags: { state: "registered" } }),
    );
  });

  it("rejects a media conflict whose stored registration differs", async () => {
    const conflict = new Error("conflict");
    conflict.name = "ConditionalCheckFailedException";
    send
      .mockResolvedValueOnce({
        Item: { taskId: "task-1", status: "in_progress", checkId: "check-1" },
      })
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({
        Item: {
          sk: "TASK#task-1#MEDIA#photo-1",
          taskId: "task-1",
          checkId: "check-1",
          artifactId: "photo-1",
          s3Key: "checks/site-1/check-1/different-photo",
          contentType: "image/jpeg",
          contentLength: 1024,
        },
      })
      .mockResolvedValueOnce({
        Item: {
          taskId: "task-1",
          checkId: "check-1",
          artifactId: "photo-1",
          mediaSk: "TASK#task-1#MEDIA#photo-1",
        },
      });

    const response = await /** @type {any} */ (
      registerTaskUpdateMedia(
        event({
          checkId: "check-1",
          artifactId: "photo-1",
          s3Key: "checks/site-1/check-1/photo-1",
          contentType: "image/jpeg",
          contentLength: 1024,
        }),
      )
    );

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body)).toEqual({
      error: "task_update_media_conflict",
    });
    expect(setObjectTags).not.toHaveBeenCalled();
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

  it("retries a progress update from fresh state when filing finishes between read and write", async () => {
    const task = {
      pk: "SITE#site-1",
      sk: "TASK#task-1",
      taskId: "task-1",
      status: "in_progress",
      updatedAt: "2026-09-30T16:00:00.000Z",
      appActionResults: [],
    };
    const results = [
      {
        code: "create_311_ticket",
        status: "submitted",
        payload: { tickets: [{ srNum: "123", responsibleAgency: "76" }] },
      },
    ];
    send
      .mockResolvedValueOnce({ Item: task })
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(
        Object.assign(new Error("integration changed"), {
          name: "TransactionCanceledException",
        }),
      )
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({ Item: { ...task, appActionResults: results } })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});
    const response = await createTaskUpdate(
      event({ type: "additional_action_still_present", text: "Swept" }),
    );
    expect(response.statusCode).toBe(201);
    const writes = send.mock.calls
      .map(([cmd]) => cmd)
      .filter((cmd) => cmd instanceof TransactWriteCommand);
    const first = /** @type {any} */ (
      writes[0].input.TransactItems?.at(-1)?.Put
    );
    const retry = /** @type {any} */ (
      writes[1].input.TransactItems?.at(-1)?.Put
    );
    expect(first.ConditionExpression).toContain(
      "appActionResults = :priorResults",
    );
    expect(first.ExpressionAttributeValues[":priorResults"]).toEqual([]);
    expect(retry.Item.appActionResults).toEqual(results);
    expect(retry.ExpressionAttributeValues[":priorResults"]).toEqual(results);
  });

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

  it.each(["in_progress", "resolving"])(
    "queues silent closure without waiting for City when resolving %s",
    async (status) => {
      process.env.GNP_311_SUBMISSION_ENABLED = "true";
      send
        .mockResolvedValueOnce({
          Item: {
            taskId: "task-1",
            status,
            kind: "non_actionable_escalation",
            severity: 4,
            updatedAt: "2026-10-01T16:00:00.000Z",
            inProgressAt: "2026-10-01T16:00:00.000Z",
            resolutionLeaseExpiresAt: "2020-01-01T00:00:00.000Z",
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
        .mockResolvedValue({});
      const fetch = vi.fn(() => new Promise(() => {}));
      vi.stubGlobal("fetch", fetch);
      const response = await /** @type {any} */ (
        createTaskUpdate(
          event({ type: "additional_action_resolved", text: "Resolved." }),
        )
      );
      expect(response.statusCode, response.body).toBe(201);
      expect(fetch).not.toHaveBeenCalled();
      const writes = send.mock.calls[2][0].input.TransactItems;
      expect(
        writes.some(
          (/** @type {any} */ row) =>
            row.Put?.Item.entityType === "SF311_OUTBOX",
        ),
      ).toBe(true);
      const taskWrite = writes.find(
        (/** @type {any} */ row) => row.Put?.Item.status === "completed",
      ).Put;
      expect(taskWrite.ExpressionAttributeValues[":expected"]).toBe(status);
      expect(taskWrite.Item.appActionResults[0].payload.tickets[0].srNum).toBe(
        "2000008106",
      );
    },
  );
});
