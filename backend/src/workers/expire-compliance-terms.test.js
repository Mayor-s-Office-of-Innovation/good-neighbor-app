import { beforeEach, it, expect, vi } from "vitest";
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
const { send, close } = vi.hoisted(() => ({ send: vi.fn(), close: vi.fn() }));
vi.mock("../db.js", () => ({ ddb: { send } }));
vi.mock("../domain/end-compliance-terms.js", () => ({
  closeComplianceTerms: close,
}));
import { expireComplianceTerms } from "./expire-compliance-terms.js";
const term = {
  pk: "SITE#one",
  termsVersionId: "v1",
  expiresOnExclusive: "2026-10-22",
};
beforeEach(() => {
  vi.stubEnv("DYNAMO_TABLE", "test");
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-23T06:59:00Z"));
  send.mockReset();
  close.mockReset().mockResolvedValue(undefined);
});
it("uses the Pacific day and paginates, skipping superseded requirements", async () => {
  send
    .mockResolvedValueOnce({
      Items: [term],
      LastEvaluatedKey: { pk: "next", sk: "next" },
    })
    .mockResolvedValueOnce({ Item: { latestComplianceTermsVersionId: "v2" } })
    .mockResolvedValueOnce({ Items: [{ ...term, termsVersionId: "v3" }] })
    .mockResolvedValueOnce({
      Item: { siteId: "one", latestComplianceTermsVersionId: "v3" },
    });
  await expireComplianceTerms();
  expect(send.mock.calls[0][0]).toBeInstanceOf(ScanCommand);
  expect(send.mock.calls[0][0].input.ExpressionAttributeValues[":today"]).toBe(
    "2026-10-22",
  );
  expect(send.mock.calls[2][0].input.ExclusiveStartKey).toEqual({
    pk: "next",
    sk: "next",
  });
  expect(close).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledWith(
    expect.objectContaining({ siteId: "one" }),
    expect.objectContaining({ termsVersionId: "v3" }),
    "2026-10-22",
    expect.any(String),
    "scheduled-expiry",
  );
  vi.useRealTimers();
});
it("retries optimistic conflicts on the next sweep but surfaces service failures", async () => {
  send.mockImplementation(async (c) =>
    c instanceof ScanCommand
      ? { Items: [term] }
      : { Item: { latestComplianceTermsVersionId: "v1" } },
  );
  close.mockRejectedValueOnce(
    Object.assign(new Error("conflict"), {
      name: "TransactionCanceledException",
    }),
  );
  await expireComplianceTerms();
  close.mockRejectedValueOnce(new Error("unavailable"));
  await expect(expireComplianceTerms()).rejects.toThrow("unavailable");
  vi.useRealTimers();
});
