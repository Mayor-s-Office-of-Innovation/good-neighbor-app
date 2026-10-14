import { describe, expect, it, vi } from "vitest";
import {
  GetCommand,
  ScanCommand,
  TransactWriteCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import { backfillCheckCompletions } from "./backfill-check-completions.js";
import { COMPLETION_MIGRATION_KEY } from "./check-completions.js";
const header = {
  pk: "SITE#site",
  sk: "CHECK#old",
  checkId: "old",
  completedAt: "2026-10-13T19:00:00.000Z",
};
describe("completion backfill", () => {
  it("defaults to dry run, reads every page, and skips problem reports/children", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Items: [
          header,
          { ...header, flowType: "single-problem" },
          { ...header, sk: "CHECK#old#ART#photo" },
        ],
        LastEvaluatedKey: { pk: "SITE#site", sk: "cursor" },
      })
      .mockResolvedValueOnce({ Items: [] });
    expect(await backfillCheckCompletions({ send }, "table")).toEqual({
      eligible: 1,
      written: 0,
      skipped: 0,
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(
      send.mock.calls.every(([command]) => command instanceof ScanCommand),
    ).toBe(true);
    expect(send.mock.calls[1][0].input.ExclusiveStartKey).toEqual({
      pk: "SITE#site",
      sk: "cursor",
    });
  });
  it("checks the immutable header and writes readiness only after successful migration", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Items: [header] })
      .mockResolvedValue({});
    expect(await backfillCheckCompletions({ send }, "table", true)).toEqual({
      eligible: 1,
      written: 1,
      skipped: 0,
    });
    expect(send.mock.calls[0][0]).toBeInstanceOf(GetCommand);
    expect(send.mock.calls[0][0].input).toMatchObject({
      Key: { pk: "SYSTEM#MIGRATIONS", sk: "CHECK_COMPLETIONS_V1" },
      ConsistentRead: true,
    });
    const transaction = send.mock.calls[2][0];
    expect(transaction).toBeInstanceOf(TransactWriteCommand);
    expect(transaction.input.TransactItems[0].ConditionCheck).toMatchObject({
      Key: { pk: "SITE#site", sk: "CHECK#old" },
      ExpressionAttributeValues: {
        ":completed": "completed",
        ":at": header.completedAt,
      },
    });
    expect(transaction.input.TransactItems[1].Put).toMatchObject({
      ConditionExpression: "attribute_not_exists(sk)",
      Item: {
        pk: "SITE#site",
        checkId: "old",
        completedAt: header.completedAt,
      },
    });
    expect(send.mock.calls[3][0]).toBeInstanceOf(PutCommand);
    expect(send.mock.calls[3][0].input.Item).toMatchObject({
      pk: "SYSTEM#MIGRATIONS",
      sk: "CHECK_COMPLETIONS_V1",
      status: "ready",
    });
  });
  it("skips existing markers on rerun without overwriting them", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Items: [header] })
      .mockRejectedValueOnce({
        name: "TransactionCanceledException",
        CancellationReasons: [
          { Code: "None" },
          { Code: "ConditionalCheckFailed" },
        ],
      })
      .mockResolvedValue({});
    expect(await backfillCheckCompletions({ send }, "table", true)).toEqual({
      eligible: 1,
      written: 0,
      skipped: 1,
    });
  });
  it("does not enable incomplete history after a failed page or transaction", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Items: [header] })
      .mockRejectedValueOnce(new Error("unavailable"));
    await expect(
      backfillCheckCompletions({ send }, "table", true),
    ).rejects.toThrow("unavailable");
    expect(
      send.mock.calls.some(([command]) => command instanceof PutCommand),
    ).toBe(false);
  });
  it("returns before scanning when an applied migration is already ready", async () => {
    const send = vi.fn().mockResolvedValueOnce({
      Item: { ...COMPLETION_MIGRATION_KEY, status: "ready" },
    });

    expect(await backfillCheckCompletions({ send }, "table", true)).toEqual({
      eligible: 0,
      written: 0,
      skipped: 0,
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBeInstanceOf(GetCommand);
    expect(send.mock.calls[0][0].input.ConsistentRead).toBe(true);
  });
});
