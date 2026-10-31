import { beforeEach, expect, it, vi } from "vitest";
import {
  GetCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
const send = vi.hoisted(() => vi.fn());
vi.mock("../db.js", () => ({ ddb: { send } }));
import {
  claimAnalysis,
  publishAnalysis,
  releaseAnalysis,
  restartAnalysis,
  recoveryConflict,
} from "./artifact-recovery.js";
const msg = {
  siteId: "site",
  checkId: "check",
  artifactId: "artifact",
  analysisGeneration: "generation-1",
};
const conflict = () =>
  Object.assign(new Error("conditional"), {
    name: "ConditionalCheckFailedException",
  });
beforeEach(() => send.mockReset().mockResolvedValue({}));
it("claims a generation with a bounded lease before work", async () => {
  expect(await claimAnalysis("table", msg)).toBe(true);
  const command = send.mock.calls[0][0];
  expect(command).toBeInstanceOf(UpdateCommand);
  expect(command.input.ConditionExpression).toContain(
    "analysisGeneration = :generation",
  );
  expect(command.input.ExpressionAttributeValues[":lease"]).toBeGreaterThan(
    Date.now() + 300_000,
  );
});
it("suppresses a competing or stale worker but propagates storage failures", async () => {
  send.mockRejectedValueOnce(conflict());
  expect(await claimAnalysis("table", msg)).toBe(false);
  send.mockRejectedValueOnce(new Error("unavailable"));
  await expect(claimAnalysis("table", msg)).rejects.toThrow("unavailable");
});
it("publishes lifecycle and result atomically with a generation fence", async () => {
  await publishAnalysis(
    "table",
    msg,
    { pk: "synthetic", sk: "analysis", status: "analyzed" },
    "succeeded",
  );
  const command = send.mock.calls[0][0];
  expect(command).toBeInstanceOf(TransactWriteCommand);
  expect(command.input.TransactItems[0].Update.ConditionExpression).toContain(
    "analysisGeneration = :generation",
  );
  expect(command.input.TransactItems[1].Put.Item.analysisGeneration).toBe(
    "generation-1",
  );
});
it("releases transient failures without reviving a different generation", async () => {
  await releaseAnalysis("table", msg);
  expect(send.mock.calls[0][0].input.ConditionExpression).toContain(
    "analysisGeneration = :generation",
  );
});
it("allows only exhausted jobs to start a new generation", async () => {
  expect(
    await restartAnalysis(
      "table",
      { pk: "synthetic", sk: "artifact" },
      "restart-1",
      "generation-1",
    ),
  ).toBe(true);
  expect(send.mock.calls[0][0].input.ConditionExpression).toContain(
    "analysisStatus = :exhausted",
  );
});
it("accepts a lost-response replay only for the exact restart identity", async () => {
  send
    .mockRejectedValueOnce(conflict())
    .mockResolvedValueOnce({ Item: { analysisGeneration: "restart-1" } });
  expect(await restartAnalysis("table", {}, "restart-1", "generation-1")).toBe(
    true,
  );
  expect(send.mock.calls[1][0]).toBeInstanceOf(GetCommand);
  send
    .mockRejectedValueOnce(conflict())
    .mockResolvedValueOnce({ Item: { analysisGeneration: "restart-2" } });
  expect(await restartAnalysis("table", {}, "restart-1", "generation-1")).toBe(
    false,
  );
});
it("does not disguise transaction throttling as a stale result", () => {
  expect(
    recoveryConflict(
      Object.assign(new Error("throttled"), {
        name: "TransactionCanceledException",
        CancellationReasons: [{ Code: "ProvisionedThroughputExceeded" }],
      }),
    ),
  ).toBe(false);
});
