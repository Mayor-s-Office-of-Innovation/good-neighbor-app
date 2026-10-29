import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  send,
  headObject,
  setObjectTags,
  storeTaskPhotoDisplay,
  getObjectBytes,
  downscaleImage,
  storeThumbnail,
  recordThumbnail,
} = vi.hoisted(() => ({
  send: vi.fn(),
  headObject: vi.fn(),
  setObjectTags: vi.fn(),
  storeTaskPhotoDisplay: vi.fn(),
  getObjectBytes: vi.fn(),
  downscaleImage: vi.fn(),
  storeThumbnail: vi.fn(),
  recordThumbnail: vi.fn(),
}));
vi.mock("../media/task-photo.js", async (importOriginal) => ({
  ...(await importOriginal()),
  storeTaskPhotoDisplay,
}));
vi.mock("../db.js", () => ({ ddb: { send } }));
vi.mock("../s3.js", () => ({ headObject, setObjectTags, getObjectBytes }));
vi.mock("../media/downscale.js", () => ({ downscaleImage }));
vi.mock("../media/thumbnail.js", () => ({ storeThumbnail, recordThumbnail }));

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
    storeTaskPhotoDisplay
      .mockReset()
      .mockImplementation(async ({ key, contentType }) =>
        contentType === "image/jpeg" ? undefined : `${key}.display.jpg`,
      );
    send.mockReset();
    headObject.mockReset().mockResolvedValue({
      contentType: "image/jpeg",
      contentLength: 1024,
      metadata: { "declared-bytes": "1024" },
    });
    setObjectTags.mockReset().mockResolvedValue({});
    getObjectBytes.mockReset().mockResolvedValue({
      bytes: Buffer.from("original"),
      contentType: "image/jpeg",
    });
    downscaleImage.mockReset().mockResolvedValue({
      bytes: Buffer.from("normalized"),
      contentType: "image/jpeg",
    });
    storeThumbnail
      .mockReset()
      .mockImplementation(async ({ s3Key }) => `${s3Key}.thumb.webp`);
    recordThumbnail.mockReset().mockResolvedValue({});
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
    "note",
    "photo",
    "empty",
    "foreign-photo",
    "already-saved",
    "expired-only",
  ])("handles shared resolution proof: %s", async (kind) => {
    const task = {
      pk: "SITE#site-1",
      sk: "TASK#task-1",
      taskId: "task-1",
      checkId: "check-1",
      status: kind === "expired-only" ? "open" : "completed",
      completionMethod: "site_team_resolved",
      createdAt: "2020-01-01",
      completedAt: "2020-01-02",
      updatedAt: "2020-01-02",
      actorId: "another-session",
      proofAddedAt: kind === "already-saved" ? "2020-01-03" : null,
    };
    send.mockImplementation(async (command) => {
      if (command instanceof GetCommand && command.input.Key?.sk === task.sk)
        return { Item: task };
      if (
        command instanceof GetCommand &&
        command.input.Key?.sk.includes("MEDIA") &&
        kind === "photo"
      )
        return { Item: { taskId: "task-1", artifactId: "photo" } };
      return {};
    });
    const response = await createTaskUpdate(
      event({
        type: "resolution_proof",
        notes: kind === "empty" || kind.includes("photo") ? [] : ["Cleaned"],
        photoKeys: kind.includes("photo") ? ["photo"] : [],
      }),
    );
    const expected = ["note", "photo"].includes(kind)
      ? 201
      : ["empty", "foreign-photo"].includes(kind)
        ? 400
        : 409;
    expect(response.statusCode).toBe(expected);
    const writes = send.mock.calls.filter(
      ([command]) => command instanceof TransactWriteCommand,
    );
    expect(writes).toHaveLength(expected === 201 ? 1 : 0);
    if (expected === 201) {
      const body = JSON.parse(response.body);
      expect(body.task.status).toBe("completed");
      expect(body.task.completedAt).toBe("2020-01-02");
      expect(body.task.proofAddedAt).toBeTruthy();
      expect(body.update.actorId).toBe("device-1");
      expect(writes[0][0].input.TransactItems).toHaveLength(3);
      expect(
        writes[0][0].input.TransactItems.at(-1).Put.ConditionExpression,
      ).toContain("attribute_not_exists(proofAddedAt)");
    }
  });

  it("does not overwrite proof saved by another session during a race", async () => {
    let committed = false;
    send.mockImplementation(async (command) => {
      if (
        command instanceof GetCommand &&
        command.input.Key?.sk === "TASK#task-1"
      )
        return {
          Item: {
            taskId: "task-1",
            status: "completed",
            completionMethod: "site_team_resolved",
            updatedAt: committed ? "new" : "old",
            proofAddedAt: committed ? "2026-10-28" : null,
          },
        };
      if (command instanceof TransactWriteCommand) {
        committed = true;
        throw Object.assign(new Error("conflict"), {
          name: "TransactionCanceledException",
        });
      }
      return {};
    });
    const response = await createTaskUpdate(
      event({ type: "resolution_proof", notes: ["My result"], photoKeys: [] }),
    );
    expect(response.statusCode).toBe(409);
    const writes = send.mock.calls.filter(
      ([command]) => command instanceof TransactWriteCommand,
    );
    expect(writes).toHaveLength(1);
    expect(
      writes[0][0].input.TransactItems.at(-1).Put.ConditionExpression,
    ).toContain("updatedAt = :prior");
  });

  it.each(["missing", "closed", "in_progress"])(
    "publishes and enforces ticket eligibility: %s",
    async (scenario) => {
      const task = {
        taskId: "task-1",
        status: scenario === "in_progress" ? "in_progress" : "completed",
        completionMethod: "311_filed",
        appActionResults:
          scenario === "missing"
            ? []
            : [
                {
                  code: "create_311_ticket",
                  payload: { tickets: [{ srNum: "123" }] },
                },
                {
                  code: "close_311_ticket",
                  payload: { closures: [{ srNum: "123", status: "closed" }] },
                },
              ],
      };
      send
        .mockResolvedValueOnce({ Item: task })
        .mockResolvedValueOnce({ Items: [] });
      const detail = JSON.parse((await getTaskUpdates(event({}))).body);
      expect(detail.task.canUpdate).toBe(scenario === "in_progress");
      expect(detail.task.canRequestCityHelp).toBe(false);
      send
        .mockReset()
        .mockResolvedValue({})
        .mockResolvedValueOnce({ Item: task });
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      const response = await createTaskUpdate(
        event({
          type: "note_photo_update",
          notes: ["Local update"],
          photoKeys: [],
        }),
      );
      expect(response.statusCode).toBe(scenario === "in_progress" ? 201 : 409);
      expect(fetch).not.toHaveBeenCalled();
      expect(
        send.mock.calls.some(
          ([command]) => command instanceof TransactWriteCommand,
        ),
      ).toBe(scenario === "in_progress");
    },
  );

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

  it.each(["image/jpeg", "image/heic", "image/heif"])(
    "registers %s update media without enqueuing analysis",
    async (contentType) => {
      headObject.mockResolvedValue({
        contentType,
        contentLength: 1024,
        metadata: { "declared-bytes": "1024" },
      });
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
            contentType,
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
      expect(mediaPut.Put.Item.displayS3Key).toBe(
        contentType === "image/jpeg"
          ? undefined
          : "checks/site-1/check-1/photo-1.display.jpg",
      );
      expect(pointerPut.Put.Item).toMatchObject({
        sk: "CHECK#check-1#UPDATE_MEDIA#photo-1",
        mediaSk: "TASK#task-1#MEDIA#photo-1",
      });
      expect(send).toHaveBeenCalledTimes(2);
    },
  );

  it("returns registration without waiting for thumbnail work", async () => {
    getObjectBytes.mockImplementation(() => new Promise(() => {}));
    send
      .mockResolvedValueOnce({
        Item: { taskId: "task-1", status: "in_progress", checkId: "check-1" },
      })
      .mockResolvedValueOnce({});
    const response = await registerTaskUpdateMedia(
      event({
        checkId: "check-1",
        artifactId: "photo-1",
        s3Key: "checks/site-1/check-1/photo-1",
        contentType: "image/jpeg",
        contentLength: 1024,
      }),
    );
    expect(response.statusCode).toBe(201);
    expect(getObjectBytes).not.toHaveBeenCalled();
    expect(storeThumbnail).not.toHaveBeenCalled();
  });

  it("does not redo the thumbnail on an exact retry that already has one", async () => {
    const conflict = new Error("conflict");
    conflict.name = "TransactionCanceledException";
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
          s3Key: "checks/site-1/check-1/photo-1",
          contentType: "image/jpeg",
          contentLength: 1024,
          thumbS3Key: "checks/site-1/check-1/photo-1.thumb.webp",
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
    expect(getObjectBytes).not.toHaveBeenCalled();
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
  it.each(["completing", "completed"])(
    "updates a recoverable %s filing without resubmitting tickets",
    async (status) => {
      const results = [
        {
          code: "create_311_ticket",
          status: "failed",
          reason: "fanout_incomplete",
          payload: {
            tickets: [{ srNum: "existing-1" }, { srNum: "existing-2" }],
          },
        },
      ];
      const task = {
        pk: "SITE#site-1",
        sk: "TASK#task-1",
        taskId: "task-1",
        status,
        updatedAt: "2026-10-26T19:41:25Z",
        completionLeaseExpiresAt: "2020-01-01T00:00:00Z",
        completionMethod: "311_filed",
        completedAt: "2026-10-26T19:41:25Z",
        resolvedAt: "2026-10-26T19:41:25Z",
        appActionStatus: "failed",
        appActionResults: results,
      };
      send
        .mockResolvedValueOnce({ Item: task })
        .mockResolvedValueOnce({})
        .mockResolvedValue({});
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      const response = await createTaskUpdate(
        event({
          type: "note_photo_update",
          notes: ["Still present"],
          photoKeys: [],
          cityHelpNeeded: true,
        }),
      );
      expect(response.statusCode, response.body).toBe(201);
      expect(fetch).not.toHaveBeenCalled();
      const transaction = send.mock.calls.find(
        ([command]) => command instanceof TransactWriteCommand,
      )?.[0].input;
      const write = transaction.TransactItems.find(
        (/** @type {any} */ row) => row.Put?.Item.sk === "TASK#task-1",
      ).Put;
      expect(write.Item).toMatchObject({
        status: "in_progress",
        appActionStatus: "failed",
        appActionResults: results,
      });
      expect(write.Item).not.toHaveProperty("resolvedAt");
      expect(write.Item).not.toHaveProperty("completedAt");
      expect(write.Item).not.toHaveProperty("completionLeaseExpiresAt");
      expect(write.ConditionExpression).toContain("updatedAt = :prior");
      expect(write.ConditionExpression).toContain(
        "appActionResults = :priorResults",
      );
      if (status === "completing")
        expect(write.ConditionExpression).toContain("#lease = :lease");
      expect(
        transaction.TransactItems.some(
          (/** @type {any} */ row) =>
            row.Put?.Item.entityType === "SF311_OUTBOX",
        ),
      ).toBe(false);
      expect(JSON.parse(response.body).task.canUpdate).toBe(true);
    },
  );

  it("rejects recovery when another worker has renewed the completion lease", async () => {
    const expired = {
      taskId: "task-1",
      status: "completing",
      completionLeaseExpiresAt: "2020-01-01T00:00:00Z",
      updatedAt: "old",
      appActionResults: [
        {
          code: "create_311_ticket",
          payload: { tickets: [{ srNum: "existing" }] },
        },
      ],
    };
    send
      .mockResolvedValueOnce({ Item: expired })
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(
        Object.assign(new Error("race"), {
          name: "TransactionCanceledException",
        }),
      )
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({
        Item: { ...expired, completionLeaseExpiresAt: "2099-01-01T00:00:00Z" },
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Items: [] });
    const response = await createTaskUpdate(
      event({
        type: "note_photo_update",
        notes: ["Still present"],
        photoKeys: [],
        cityHelpNeeded: true,
      }),
    );
    expect(response.statusCode).toBe(409);
    expect(
      send.mock.calls.filter(
        ([command]) => command instanceof TransactWriteCommand,
      ),
    ).toHaveLength(1);
  });
});

it("does not register proof media when conversion fails", async () => {
  const { InvalidTaskPhoto } = await import("../media/task-photo.js");
  process.env.DYNAMO_TABLE = "tasks";
  process.env.S3_UPLOAD_BUCKET = "uploads";
  send.mockReset().mockResolvedValue({
    Item: { taskId: "task-1", status: "completed", checkId: "check-1" },
  });
  headObject.mockResolvedValue({
    contentType: "image/heic",
    contentLength: 1024,
    metadata: { "declared-bytes": "1024" },
  });
  storeTaskPhotoDisplay.mockRejectedValue(new InvalidTaskPhoto("bad image"));
  const response = await registerTaskUpdateMedia(
    event({
      artifactId: "photo-1",
      checkId: "check-1",
      s3Key: "checks/site-1/check-1/photo-1",
      contentType: "image/heic",
      contentLength: 1024,
    }),
  );
  expect(response.statusCode).toBe(422);
  expect(
    send.mock.calls.some(
      ([command]) => command instanceof TransactWriteCommand,
    ),
  ).toBe(false);
});
