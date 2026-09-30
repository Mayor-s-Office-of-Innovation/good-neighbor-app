import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../db.js", () => ({ ddb: { send } }));

const { readTimeline, readUpdateById, readUpdatePointer } = await import(
  "./task-update-store.js"
);

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
});
