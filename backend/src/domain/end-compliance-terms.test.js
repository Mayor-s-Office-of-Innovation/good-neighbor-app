import { beforeEach, it, expect, vi } from "vitest";
const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../db.js", () => ({ ddb: { send } }));
import { closeComplianceTerms } from "./end-compliance-terms.js";
beforeEach(() => {
  send.mockReset().mockResolvedValue({});
  vi.stubEnv("DYNAMO_TABLE", "test");
  vi.stubEnv("SETUP_CODE_EMAIL_SUBJECT_PREFIX", "");
});
it("atomically archives, audits, and queues a single end notice using the original To/CC", async () => {
  const email = {
    to: "original@example.org",
    cc: ["other@example.org", "provider@example.org", "generator@example.org"],
  };
  await closeComplianceTerms(
    {
      siteId: "one",
      name: "Main",
      address: "1 Main St",
      complianceLetters: { current: { s3Key: "pdf" }, past: [] },
    },
    { pk: "SITE#one", sk: "COMPLIANCE_TERMS#v1", termsVersionId: "v1", email },
    "2026-10-23",
    "2026-10-23T10:00:00Z",
    "actor",
  );
  const items = send.mock.calls[0][0].input.TransactItems;
  expect(items[0].Put).toMatchObject({
    ConditionExpression: "attribute_not_exists(pk)",
    Item: {
      sk: "LETTER_JOB#ended-v1",
      entityType: "COMPLIANCE_LETTER_OUTBOX",
      noticeOnly: true,
      email: { ...email, subject: "Perimeter check requirement ended" },
    },
  });
  expect(items[0].Put.Item.email.text).toBe(
    "To the team at Main:\n\nThe perimeter check requirement for your site at 1 Main St has been ended. You are no longer required to conduct perimeter checks. Please contact your program manager if you have any concerns or questions.\n\nThank you for your participation in the Good Neighbor Policy.\n\n- The Good Neighbor Policy compliance team",
  );
  expect(items[1].Update.ConditionExpression).toContain(
    "attribute_not_exists(endedAt)",
  );
  // The closed version leaves the GSI3 expiry partition the sweep queries.
  expect(items[1].Update.UpdateExpression).toContain("REMOVE gsi3pk, gsi3sk");
  expect(items[2].Update.ConditionExpression).toContain(
    "latestComplianceTermsVersionId = :version",
  );
  expect(items[2].Update.ExpressionAttributeValues[":letters"]).toEqual({
    current: null,
    past: [{ s3Key: "pdf" }],
  });
});
