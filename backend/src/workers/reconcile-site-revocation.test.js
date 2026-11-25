import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../db.js", () => ({ ddb: { send } }));
// Pending-invitation cancellation has its own tests (pending-site-grants.test.js).
const { cancelPendingSiteGrants } = vi.hoisted(() => ({
  cancelPendingSiteGrants: vi.fn(),
}));
vi.mock("../lib/pending-site-grants.js", () => ({ cancelPendingSiteGrants }));

const { handler } = await import("./reconcile-site-revocation.js");

beforeEach(() => {
  cancelPendingSiteGrants
    .mockReset()
    .mockResolvedValue({ cancelledCount: 0, failedCount: 0 });
  send.mockReset();
  vi.stubEnv("DYNAMO_TABLE", "gnp-test-app");
});

describe("emergency Site revocation reconciliation", () => {
  it("revokes canonical projections and records an idempotent Site result", async () => {
    send
      .mockResolvedValueOnce({
        Items: [
          {
            pk: "SITE#site-1",
            sk: "DEVICE_BINDING#binding-1",
            siteId: "site-1",
            bindingId: "binding-1",
            physicalDeviceId: "physical-1",
            status: "active",
            tokenGeneration: 4,
          },
        ],
      })
      .mockResolvedValueOnce({
        Items: [{ sk: "DEVICE#binding-1", bindingId: "binding-1" }],
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        Item: {
          queuedSiteCount: 1,
          completedSiteCount: 1,
          partialSiteCount: 0,
          enqueueFailedCount: 0,
        },
      })
      .mockResolvedValueOnce({});

    await handler(event(), /** @type {any} */ ({}), () => {});

    expect(cancelPendingSiteGrants).toHaveBeenCalledWith(
      expect.any(String),
      "site-1",
      expect.objectContaining({
        actor: "admin-1",
        operationId: "operation-1",
        // Only invitations issued before the revocation started.
        cutoff: "2026-10-03T12:00:00.000Z",
      }),
    );
    expect(send.mock.calls[0][0]).toBeInstanceOf(QueryCommand);
    const bindingTransaction = send.mock.calls[2][0];
    expect(bindingTransaction).toBeInstanceOf(TransactWriteCommand);
    expect(bindingTransaction.input.TransactItems).toHaveLength(3);
    expect(
      bindingTransaction.input.TransactItems[0].Update
        .ExpressionAttributeValues,
    ).toMatchObject({ ":next": 5 });
    const outcomeTransaction = send.mock.calls[3][0];
    expect(outcomeTransaction).toBeInstanceOf(TransactWriteCommand);
    expect(outcomeTransaction.input.TransactItems[0].Put.Item).toMatchObject({
      pk: "REVOCATION_OPERATION#operation-1",
      sk: "SITE#site-1",
      status: "complete",
      reconciledCount: 1,
      failedCount: 0,
    });
    expect(outcomeTransaction.input.TransactItems[2].Update.Key).toEqual({
      pk: "SITE#site-1",
      sk: "REVOCATION_OPERATION#2026-10-03T12:00:00.000Z#operation-1",
    });
    expect(send.mock.calls[4][0]).toBeInstanceOf(GetCommand);
    expect(send.mock.calls[5][0]).toBeInstanceOf(UpdateCommand);
    expect(send.mock.calls[5][0].input.ExpressionAttributeValues).toMatchObject(
      { ":status": "complete" },
    );
  });

  it("treats an already-revoked canonical binding as a successful retry", async () => {
    const conflict = new Error("conflict");
    conflict.name = "TransactionCanceledException";
    send
      .mockResolvedValueOnce({
        Items: [
          {
            pk: "SITE#site-1",
            sk: "DEVICE_BINDING#binding-1",
            siteId: "site-1",
            bindingId: "binding-1",
            physicalDeviceId: "physical-1",
            status: "active",
            tokenGeneration: 4,
          },
        ],
      })
      .mockResolvedValueOnce({
        Items: [{ sk: "DEVICE#binding-1", bindingId: "binding-1" }],
      })
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({ Item: { status: "revoked" } })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Item: { queuedSiteCount: 1 } });

    await expect(
      handler(event(), /** @type {any} */ ({}), () => {}),
    ).resolves.toBeUndefined();

    expect(send.mock.calls[3][0]).toBeInstanceOf(GetCommand);
    expect(send.mock.calls[4][0]).toBeInstanceOf(TransactWriteCommand);
  });

  it("throws transient device-write failures so SQS can retry", async () => {
    send
      .mockResolvedValueOnce({
        Items: [
          {
            pk: "SITE#site-1",
            sk: "DEVICE_BINDING#binding-1",
            siteId: "site-1",
            bindingId: "binding-1",
            physicalDeviceId: "physical-1",
            status: "active",
          },
        ],
      })
      .mockResolvedValueOnce({ Items: [] })
      .mockRejectedValueOnce(new Error("temporary DynamoDB failure"));

    await expect(
      handler(event(), /** @type {any} */ ({}), () => {}),
    ).rejects.toThrow("Failed to reconcile 1 device records");

    expect(send).toHaveBeenCalledTimes(3);
  });

  it("throws when pending invitations can't all be cancelled so SQS retries", async () => {
    send
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({ Items: [] });
    cancelPendingSiteGrants.mockResolvedValueOnce({
      cancelledCount: 1,
      failedCount: 1,
    });
    await expect(
      handler(event(), /** @type {any} */ ({}), () => {}),
    ).rejects.toThrow("Failed to cancel 1 pending invitations");
  });

  it("still finalizes after an idempotent Site-result conflict", async () => {
    const conflict = new Error("already recorded");
    conflict.name = "TransactionCanceledException";
    send
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({ Items: [] })
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({
        Item: {
          queuedSiteCount: 1,
          completedSiteCount: 1,
          partialSiteCount: 0,
          enqueueFailedCount: 0,
        },
      })
      .mockResolvedValueOnce({});

    await handler(event(), /** @type {any} */ ({}), () => {});

    expect(send.mock.calls[3][0]).toBeInstanceOf(GetCommand);
    expect(send.mock.calls[4][0]).toBeInstanceOf(UpdateCommand);
    expect(send.mock.calls[4][0].input.ExpressionAttributeValues).toMatchObject(
      { ":status": "complete" },
    );
  });
});

function event() {
  return /** @type {any} */ ({
    Records: [
      {
        body: JSON.stringify({
          type: "reconcile_site_revocation",
          operationId: "operation-1",
          operationPk: "REVOCATION_OPERATION#operation-1",
          siteId: "site-1",
          startedAt: "2026-10-03T12:00:00.000Z",
          actor: "admin-1",
        }),
      },
    ],
  });
}
