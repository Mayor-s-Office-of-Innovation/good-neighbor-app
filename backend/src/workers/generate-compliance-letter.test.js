import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { send, putObject } = vi.hoisted(() => ({
  send: vi.fn(),
  putObject: vi.fn(),
}));
vi.mock("../db.js", () => ({ ddb: { send } }));
vi.mock("../s3.js", () => ({ putObject }));

const { handler } = await import("./generate-compliance-letter.js");

beforeEach(() => {
  send.mockReset();
  putObject.mockReset().mockResolvedValue({});
  vi.stubEnv("DYNAMO_TABLE", "gnp-test-app");
  vi.stubEnv("S3_UPLOAD_BUCKET", "gnp-test-uploads");
  vi.stubEnv("S3_COMPLIANCE_LETTER_BUCKET", "gnp-test-compliance-letters");
  vi.stubEnv("SQS_QUEUE_URL", "queue");
});

describe("generate compliance letter worker", () => {
  it("stores the PDF and advances the current Site letter", async () => {
    send
      .mockResolvedValueOnce({
        Item: {
          status: "dispatched",
          termsSk: "COMPLIANCE_TERMS#2026-10-08#v1",
        },
      })
      .mockResolvedValueOnce({
        Item: {
          termsVersionId: "v1",
          effectiveStart: "2026-10-08",
          requiredChecksPerDay: 3,
          reasons: ["2"],
          letterInputs: {
            confirmedOn: "2026-10-08",
            siteName: "Site One",
            siteManagerFirstName: "Sam",
            siteManagerName: "Sam Lee",
            siteAddress: "1 Main St",
            departmentName: "DPH",
            programManagerName: "Rob Hoffman",
            programManagerPhone: "415-555-0100",
            programManagerEmail: "rob@sfgov.org",
          },
        },
      })
      .mockResolvedValueOnce({ Item: { latestComplianceTermsVersionId: "v1" } })
      .mockResolvedValueOnce({
        Item: {
          latestComplianceTermsVersionId: "v1",
          complianceLetters: {
            current: { termsVersionId: "old", s3Key: "old.pdf" },
            past: [],
          },
        },
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    await handler(event(), /** @type {any} */ ({}), () => {});

    expect(send.mock.calls[0][0]).toBeInstanceOf(GetCommand);
    expect(putObject).toHaveBeenCalledWith(
      expect.objectContaining({
        bucket: "gnp-test-compliance-letters",
        key: "compliance-letters/site-1/v1.pdf",
        contentType: "application/pdf",
        body: expect.any(Buffer),
      }),
    );
    expect(putObject).toHaveBeenCalledWith(
      expect.objectContaining({
        bucket: "gnp-test-compliance-letters",
        key: "compliance-letters/site-1/v1-preview.svg",
        contentType: "image/svg+xml",
        body: expect.any(Buffer),
      }),
    );
    expect(send.mock.calls[4][0]).toBeInstanceOf(UpdateCommand);
    expect(send.mock.calls[4][0].input.ConditionExpression).toBe(
      "latestComplianceTermsVersionId = :version AND complianceLetters = :observedLetters",
    );
    expect(send.mock.calls[4][0].input.ExpressionAttributeValues).toMatchObject(
      {
        ":letters": {
          current: { termsVersionId: "v1" },
          past: [{ termsVersionId: "old", s3Key: "old.pdf" }],
        },
      },
    );
  });

  it("re-reads and preserves letter history after a concurrent update", async () => {
    const conflict = new Error("changed");
    conflict.name = "ConditionalCheckFailedException";
    send
      .mockResolvedValueOnce({
        Item: {
          status: "dispatched",
          termsSk: "COMPLIANCE_TERMS#2026-10-08#v1",
        },
      })
      .mockResolvedValueOnce({ Item: term() })
      .mockResolvedValueOnce({ Item: { latestComplianceTermsVersionId: "v1" } })
      .mockResolvedValueOnce({
        Item: {
          latestComplianceTermsVersionId: "v1",
          complianceLetters: { current: { termsVersionId: "old" }, past: [] },
        },
      })
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({
        Item: {
          latestComplianceTermsVersionId: "v1",
          complianceLetters: {
            current: { termsVersionId: "newer" },
            past: [{ termsVersionId: "old" }],
          },
        },
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    await handler(event(), /** @type {any} */ ({}), () => {});

    expect(send.mock.calls[6][0].input.ExpressionAttributeValues).toMatchObject(
      {
        ":letters": {
          past: [{ termsVersionId: "newer" }, { termsVersionId: "old" }],
        },
      },
    );
  });
});

function term() {
  return {
    termsVersionId: "v1",
    effectiveStart: "2026-10-08",
    requiredChecksPerDay: 3,
    reasons: ["2"],
    letterInputs: {
      confirmedOn: "2026-10-08",
      siteName: "Site One",
      siteManagerFirstName: "Sam",
      siteManagerName: "Sam Lee",
      siteAddress: "1 Main St",
      departmentName: "DPH",
      programManagerName: "Rob Hoffman",
      programManagerPhone: "415-555-0100",
      programManagerEmail: "rob@sfgov.org",
    },
  };
}

function event() {
  return /** @type {any} */ ({
    Records: [
      {
        body: JSON.stringify({
          type: "generate_compliance_letter",
          siteId: "site-1",
          jobPk: "SITE#site-1",
          jobSk: "LETTER_JOB#now#job-1",
          previousLetters: [],
        }),
      },
    ],
  });
}
