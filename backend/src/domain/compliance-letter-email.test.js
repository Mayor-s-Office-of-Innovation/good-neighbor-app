import { it, expect, vi } from "vitest";
const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../db.js", () => ({ ddb: { send } }));
import { complianceLetterEmail } from "./compliance-letter-email.js";
it("snapshots the selected manager, sender, and active provider managers across pages without duplicates", async () => {
  vi.stubEnv("DYNAMO_TABLE", "test");
  send
    .mockResolvedValueOnce({
      Items: [
        { status: "active", email: "SENDER@example.org" },
        { status: "inactive", email: "inactive@example.org" },
      ],
      LastEvaluatedKey: { pk: "provider", sk: "last" },
    })
    .mockResolvedValueOnce({
      Items: [
        { status: "active", email: "provider@example.org" },
        { status: "active", email: "site@example.org" },
      ],
    });
  const email = await complianceLetterEmail(
    { providerId: "provider", name: "Main" },
    { email: "site@example.org", firstName: "Sam" },
    { email: "sender@example.org", firstName: "Pat", lastName: "Lee" },
    "DPH",
  );
  expect(email.to).toBe("site@example.org");
  expect(email.cc).toEqual(["sender@example.org", "provider@example.org"]);
  expect(email.text).toContain("Dear Sam,");
  expect(email.text).toContain("Pat Lee at San Francisco's DPH");
  expect(send).toHaveBeenCalledTimes(2);
});
