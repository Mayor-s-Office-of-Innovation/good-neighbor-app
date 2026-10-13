import { describe, expect, it, vi } from "vitest";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  checkCompletionRecord,
  completionDay,
  recentCompletionCounts,
} from "./check-completions.js";

describe("completion records", () => {
  it("uses Pacific completion date, including midnight and DST", () => {
    expect(completionDay("2026-10-13T06:59:59Z")).toBe("2026-10-12");
    expect(completionDay("2026-10-13T07:00:00Z")).toBe("2026-10-13");
    expect(completionDay("2026-11-02T07:59:59Z")).toBe("2026-11-01");
    expect(completionDay("2026-11-02T08:00:00Z")).toBe("2026-11-02");
    expect(
      checkCompletionRecord("site", "check", "2026-10-13T07:00:00Z"),
    ).toEqual({
      pk: "SITE#site",
      sk: "CHECK_COMPLETION#2026-10-13#2026-10-13T07:00:00.000Z#check",
      checkId: "check",
      completedAt: "2026-10-13T07:00:00.000Z",
    });
  });
  it("strongly reads only five days, including all pages and every device", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Items: [
          { checkId: "a", completedAt: "2026-10-13T18:00:00.000Z" },
          { checkId: "current", completedAt: "2026-10-13T18:00:00.000Z" },
          { checkId: "future", completedAt: "2026-10-13T20:00:00.000Z" },
          {
            checkId: "old-start",
            startedAt: "2026-09-01T12:00:00Z",
            completedAt: "2026-10-13T06:59:59.000Z",
          },
        ],
        LastEvaluatedKey: { pk: "SITE#site", sk: "cursor" },
      })
      .mockResolvedValueOnce({
        Items: [
          { checkId: "b", completedAt: "2026-10-13T19:00:00.000Z" },
          { checkId: "d4", completedAt: "2026-10-09T18:00:00.000Z" },
        ],
      });
    expect(
      await recentCompletionCounts(
        { send },
        "table",
        "site",
        "2026-10-13T19:00:00.000Z",
        "current",
      ),
    ).toEqual([2, 1, 0, 0, 1]);
    expect(send.mock.calls[0][0]).toBeInstanceOf(QueryCommand);
    for (const [command] of send.mock.calls) {
      expect(command.input.ConsistentRead).toBe(true);
      expect(command.input.IndexName).toBeUndefined();
      expect(command.input.ExpressionAttributeValues).toEqual({
        ":pk": "SITE#site",
        ":from": "CHECK_COMPLETION#2026-10-09#",
        ":to": "CHECK_COMPLETION#2026-10-13#2026-10-13T19:00:00.000Z#\uffff",
      });
    }
    expect(send.mock.calls[1][0].input.ExclusiveStartKey).toEqual({
      pk: "SITE#site",
      sk: "cursor",
    });
  });
});
