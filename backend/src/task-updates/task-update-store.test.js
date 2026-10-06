import { GetCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../db.js", () => ({ ddb: { send } }));

const {
  claimTaskResolution,
  readTimeline,
  readTaskUpdateMediaRegistration,
  readUpdateById,
  readUpdatePointer,
  releaseTaskResolution,
} = await import("./task-update-store.js");

describe("task update store", () => {
  beforeEach(() => send.mockReset());

  it("returns a bounded page and round-trips its cursor", async () => {
    const lastKey = {
      pk: "SITE#site-1",
      sk: "TASK#task-1#UPDATE#2026-09-30T12:00:00Z#update-1",
    };
    send.mockResolvedValueOnce({
      Items: [{ updateId: "update-2" }],
      LastEvaluatedKey: lastKey,
    });

    const first = await readTimeline("tasks", "site-1", "task-1");
    if (!first) throw new Error("Expected a valid timeline page");
    expect(first.items).toEqual([{ updateId: "update-2" }]);
    expect(first.nextToken).toBeTruthy();

    send.mockResolvedValueOnce({ Items: [] });
    await readTimeline("tasks", "site-1", "task-1", {
      cursor: String(first.nextToken),
    });
    expect(send.mock.calls[1][0]).toBeInstanceOf(QueryCommand);
    expect(send.mock.calls[1][0].input.ExclusiveStartKey).toEqual(lastKey);
  });

  it("resolves a new update through its direct pointer", async () => {
    send
      .mockResolvedValueOnce({
        Item: {
          updateSk: "TASK#task-1#UPDATE#2026-09-30T12:00:00Z#update-1",
        },
      })
      .mockResolvedValueOnce({ Item: { updateId: "update-1" } });

    await expect(
      readUpdateById("tasks", "site-1", "task-1", "update-1"),
    ).resolves.toEqual({ updateId: "update-1" });
    expect(send.mock.calls[0][0]).toBeInstanceOf(GetCommand);
    expect(send.mock.calls[1][0]).toBeInstanceOf(GetCommand);
  });

  it("paginates legacy update lookups until it finds a match", async () => {
    send
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        Items: [],
        LastEvaluatedKey: {
          pk: "SITE#site-1",
          sk: "TASK#task-1#UPDATE#cursor",
        },
      })
      .mockResolvedValueOnce({ Items: [{ updateId: "legacy-update" }] });

    await expect(
      readUpdateById("tasks", "site-1", "task-1", "legacy-update"),
    ).resolves.toEqual({ updateId: "legacy-update" });
    expect(send.mock.calls[2][0].input.ExclusiveStartKey).toEqual({
      pk: "SITE#site-1",
      sk: "TASK#task-1#UPDATE#cursor",
    });
  });

  it("does not scan history when a direct pointer is absent", async () => {
    send.mockResolvedValueOnce({});

    await expect(
      readUpdatePointer("tasks", "site-1", "task-1", "new-update"),
    ).resolves.toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBeInstanceOf(GetCommand);
  });

  it("consistently reads both task-media idempotency records", async () => {
    send
      .mockResolvedValueOnce({ Item: { artifactId: "photo-1" } })
      .mockResolvedValueOnce({
        Item: { mediaSk: "TASK#task-1#MEDIA#photo-1" },
      });

    await expect(
      readTaskUpdateMediaRegistration({
        tableName: "tasks",
        siteId: "site-1",
        checkId: "check-1",
        taskId: "task-1",
        artifactId: "photo-1",
      }),
    ).resolves.toEqual({
      media: { artifactId: "photo-1" },
      pointer: { mediaSk: "TASK#task-1#MEDIA#photo-1" },
    });
    expect(send.mock.calls[0][0].input).toMatchObject({
      Key: { pk: "SITE#site-1", sk: "TASK#task-1#MEDIA#photo-1" },
      ConsistentRead: true,
    });
    expect(send.mock.calls[1][0].input).toMatchObject({
      Key: {
        pk: "SITE#site-1",
        sk: "CHECK#check-1#UPDATE_MEDIA#photo-1",
      },
      ConsistentRead: true,
    });
  });

  it("claims resolution before a non-idempotent external close", async () => {
    send.mockResolvedValueOnce({ Attributes: { status: "resolving" } });

    await expect(
      claimTaskResolution({
        tableName: "tasks",
        siteId: "site-1",
        task: {
          taskId: "task-1",
          status: "in_progress",
          updatedAt: "2026-10-01T12:00:00.000Z",
          kind: "escalation",
          severity: 3,
        },
        updateId: "update-1",
        now: "2026-10-01T12:05:00.000Z",
        leaseExpiresAt: "2026-10-01T12:10:00.000Z",
      }),
    ).resolves.toEqual({ status: "resolving" });

    const command = send.mock.calls[0][0];
    expect(command).toBeInstanceOf(UpdateCommand);
    expect(command.input.ConditionExpression).toContain(
      "#status = :inProgress AND updatedAt = :priorUpdatedAt",
    );
    expect(command.input.ConditionExpression).toContain(
      "#status = :resolving AND resolutionLeaseExpiresAt <= :now",
    );
    expect(command.input.ExpressionAttributeValues).toMatchObject({
      ":updateId": "update-1",
      ":lease": "2026-10-01T12:10:00.000Z",
    });
  });

  it("returns an incomplete resolution to the in-progress worklist", async () => {
    send.mockResolvedValueOnce({ Attributes: { status: "in_progress" } });

    await expect(
      releaseTaskResolution({
        tableName: "tasks",
        siteId: "site-1",
        taskId: "task-1",
        task: { kind: "escalation", severity: 3 },
        leaseExpiresAt: "2026-10-01T12:10:00.000Z",
        appActionResults: [{ code: "close_311_ticket", status: "partial" }],
        appActionStatus: "partial",
        now: "2026-10-01T12:05:00.000Z",
      }),
    ).resolves.toEqual({ status: "in_progress" });

    const command = send.mock.calls[0][0];
    expect(command).toBeInstanceOf(UpdateCommand);
    expect(command.input.ConditionExpression).toBe(
      "#status = :resolving AND resolutionLeaseExpiresAt = :lease",
    );
    expect(command.input.UpdateExpression).toContain(
      "REMOVE resolutionUpdateId, resolutionStartedAt, resolutionLeaseExpiresAt",
    );
  });
});
