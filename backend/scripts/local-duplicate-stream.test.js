import { describe, it, expect, vi } from "vitest";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { createLocalDuplicateStream } from "./lib/local-duplicate-stream.mjs";

describe("local duplicate stream bridge", () => {
  it("delivers inserts and old/new updates, ignores unrelated items and unchanged scans", async () => {
    const dispatch = vi.fn().mockResolvedValue({ batchItemFailures: [] });
    const scan = createLocalDuplicateStream(dispatch);
    const item = {
      pk: "SITE#one",
      sk: "CHECK#c#ANALYSIS#a",
      status: "analyzing",
    };
    await scan([item, { pk: "SITE#one", sk: "OTHER#x" }]);
    await scan([item]);
    await scan([{ ...item, status: "analyzed" }]);
    expect(dispatch).toHaveBeenCalledTimes(2);
    const record = dispatch.mock.calls[1][0].Records[0];
    expect(record.eventName).toBe("MODIFY");
    expect(unmarshall(record.dynamodb.OldImage)).toEqual(item);
    expect(unmarshall(record.dynamodb.NewImage).status).toBe("analyzed");
  });
  it("retries reported failures without losing the previous image", async () => {
    const dispatch = vi
      .fn()
      .mockResolvedValueOnce({ batchItemFailures: [{}] })
      .mockResolvedValue({ batchItemFailures: [] });
    const scan = createLocalDuplicateStream(dispatch);
    const item = { pk: "SITE#one", sk: "TASK#t" };
    await scan([item]);
    await scan([item]);
    await scan([item]);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls[1][0].Records[0].eventName).toBe("INSERT");
  });
});
