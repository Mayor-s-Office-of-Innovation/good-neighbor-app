import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../db.js", () => ({ ddb: { send } }));

const { handler } = await import("./reconcile-site-revocation.js");

beforeEach(() => {
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
