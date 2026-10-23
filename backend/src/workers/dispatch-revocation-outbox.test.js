import { SendMessageCommand } from "@aws-sdk/client-sqs";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { ddbSend, sqsSend } = vi.hoisted(() => ({
  ddbSend: vi.fn(),
  sqsSend: vi.fn(),
}));
vi.mock("../db.js", () => ({ ddb: { send: ddbSend } }));
vi.mock("@aws-sdk/client-sqs", async (importOriginal) => {
  const actual = /** @type {any} */ (await importOriginal());
  return {
    ...actual,
    SQSClient: class {
      send = sqsSend;
    },
  };
});

const { handler } = await import("./dispatch-revocation-outbox.js");

beforeEach(() => {
  ddbSend.mockReset();
  sqsSend.mockReset().mockResolvedValue({});
  vi.stubEnv("DYNAMO_TABLE", "gnp-test-app");
  vi.stubEnv("SQS_QUEUE_URL", "https://sqs.example/revocations");
  vi.stubEnv("S3_UPLOAD_BUCKET", "uploads");
});

describe("revocation outbox dispatch", () => {
  it("sends a pending insert and marks it dispatched", async () => {
    ddbSend
      .mockResolvedValueOnce({ Item: { status: "pending" } })
      .mockResolvedValueOnce({});

    await handler(event(), /** @type {any} */ ({}), () => {});

    expect(ddbSend.mock.calls[0][0]).toBeInstanceOf(GetCommand);
    expect(sqsSend.mock.calls[0][0]).toBeInstanceOf(SendMessageCommand);
    expect(
      JSON.parse(sqsSend.mock.calls[0][0].input.MessageBody),
    ).toMatchObject({
      type: "reconcile_site_revocation",
      operationId: "operation-1",
      siteId: "site-1",
    });
    expect(ddbSend.mock.calls[1][0]).toBeInstanceOf(UpdateCommand);
  });

  it("does not resend an outbox entry already marked dispatched", async () => {
    ddbSend.mockResolvedValueOnce({ Item: { status: "dispatched" } });

    await handler(event(), /** @type {any} */ ({}), () => {});

    expect(sqsSend).not.toHaveBeenCalled();
    expect(ddbSend).toHaveBeenCalledTimes(1);
  });

  it("dispatches a compliance-letter outbox entry", async () => {
    ddbSend
      .mockResolvedValueOnce({ Item: { status: "pending" } })
      .mockResolvedValueOnce({});
    await handler(
      event({
        pk: "SITE#site-1",
        sk: "LETTER_JOB#now#job-1",
        entityType: "COMPLIANCE_LETTER_OUTBOX",
        status: "pending",
        siteId: "site-1",
      }),
      /** @type {any} */ ({}),
      () => {},
    );
    expect(JSON.parse(sqsSend.mock.calls[0][0].input.MessageBody)).toEqual({
      type: "generate_compliance_letter",
      siteId: "site-1",
      jobPk: "SITE#site-1",
      jobSk: "LETTER_JOB#now#job-1",
      previousLetters: [],
    });
  });
});

/** @param {Record<string, unknown>} [item] */
function event(item) {
  return /** @type {any} */ ({
    Records: [
      {
        eventName: "INSERT",
        dynamodb: {
          NewImage: marshall(
            item || {
              pk: "REVOCATION_OPERATION#operation-1",
              sk: "OUTBOX#site-1",
              entityType: "REVOCATION_OUTBOX",
              status: "pending",
              operationId: "operation-1",
              operationPk: "REVOCATION_OPERATION#operation-1",
              siteId: "site-1",
              startedAt: "2026-10-03T12:00:00.000Z",
              actor: "admin-1",
            },
          ),
        },
      },
    ],
  });
}
