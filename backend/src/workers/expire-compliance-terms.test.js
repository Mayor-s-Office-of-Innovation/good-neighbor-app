import { beforeEach, it, expect, vi } from "vitest";
import { QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
const { send, close } = vi.hoisted(() => ({ send: vi.fn(), close: vi.fn() }));
vi.mock("../db.js", () => ({ ddb: { send } }));
vi.mock("../domain/end-compliance-terms.js", () => ({
  closeComplianceTerms: close,
}));
import { expireComplianceTerms } from "./expire-compliance-terms.js";
const term = {
  pk: "SITE#one",
  termsVersionId: "v1",
  status: "active",
  expiresOnExclusive: "2026-10-22",
  gsi3pk: "COMPLIANCE_TERMS#OPEN",
  gsi3sk: "2026-10-22#one#v1",
};
beforeEach(() => {
  vi.stubEnv("DYNAMO_TABLE", "test");
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-23T06:59:00Z"));
  send.mockReset();
  close.mockReset().mockResolvedValue(undefined);
});
it("queries the GSI3 expiry partition up to the Pacific day and paginates, skipping superseded requirements", async () => {
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
  const query = send.mock.calls[0][0];
  expect(query).toBeInstanceOf(QueryCommand);
  expect(query.input).toMatchObject({
    IndexName: "GSI3",
    KeyConditionExpression: "gsi3pk = :open AND gsi3sk < :tomorrow",
    ExpressionAttributeValues: {
      ":open": "COMPLIANCE_TERMS#OPEN",
      ":tomorrow": "2026-10-23",
    },
  });
  expect(send.mock.calls.some(([c]) => c instanceof ScanCommand)).toBe(false);
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
it("skips versions the eventually consistent index still lists after they ended, were cancelled, or expire later", async () => {
  send.mockResolvedValueOnce({
    Items: [
      { ...term, endedAt: "2026-10-22T10:00:00Z" },
      { ...term, termsVersionId: "v2", status: "cancelled" },
      { ...term, termsVersionId: "v4", expiresOnExclusive: "2026-10-23" },
    ],
  });
  await expireComplianceTerms();
  expect(send).toHaveBeenCalledTimes(1);
  expect(close).not.toHaveBeenCalled();
  vi.useRealTimers();
});
it("retries optimistic conflicts on the next sweep but surfaces service failures", async () => {
  send.mockImplementation(async (c) =>
    c instanceof QueryCommand
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
