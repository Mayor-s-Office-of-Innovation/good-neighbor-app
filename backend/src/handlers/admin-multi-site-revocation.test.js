import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { ddbSend } = vi.hoisted(() => ({
  ddbSend: vi.fn(),
}));
vi.mock("../db.js", () => ({ ddb: { send: ddbSend } }));

const { previewEmergencySiteRevocation, startEmergencySiteRevocation } =
  await import("./admin-multi-site-revocation.js");

beforeEach(() => {
  ddbSend.mockReset();
  vi.stubEnv("DYNAMO_TABLE", "gnp-test-app");
  vi.stubEnv("SQS_QUEUE_URL", "https://sqs.example/revocations");
  vi.stubEnv("S3_UPLOAD_BUCKET", "uploads");
});

describe("emergency multi-Site revocation", () => {
  it("previews every active binding and returns the typed phrase", async () => {
    mockTwoSitePreview();

    const response = await call(
      previewEmergencySiteRevocation,
      event({ siteIds: ["site-1", "site-2"] }),
    );

    expect(response.statusCode).toBe(200);
    expect(ddbSend.mock.calls[0][0]).toBeInstanceOf(GetCommand);
    expect(ddbSend.mock.calls[1][0]).toBeInstanceOf(QueryCommand);
    expect(JSON.parse(String(response.body))).toEqual({
      confirmation: "REVOKE 2 SITES",
      sites: [
        {
          siteId: "site-1",
          siteName: "Site One",
          bindings: [
            {
              bindingId: "binding-1",
              label: "Tablet one",
              accessLevel: "general",
              status: "active",
            },
          ],
        },
        {
          siteId: "site-2",
          siteName: "Site Two",
          bindings: [],
        },
      ],
    });
  });

  it("invalidates all Site generations before queuing reconciliation", async () => {
    mockTwoSitePreview();
    ddbSend.mockResolvedValueOnce({});

    const response = await call(
      startEmergencySiteRevocation,
      event({
        siteIds: ["site-1", "site-2"],
        confirmation: "REVOKE 2 SITES",
      }),
    );

    expect(response.statusCode).toBe(202);
    const transaction = ddbSend.mock.calls[6][0];
    expect(transaction).toBeInstanceOf(TransactWriteCommand);
    expect(transaction.input.TransactItems).toHaveLength(9);
    expect(transaction.input.TransactItems[0].Update.Key).toEqual({
      pk: "SITE#site-1",
      sk: "#META",
    });
    expect(
      transaction.input.TransactItems[0].Update.ExpressionAttributeValues,
    ).toMatchObject({ ":current": 3, ":next": 4 });
    expect(transaction.input.TransactItems[4].Update.Key).toEqual({
      pk: "SITE#site-2",
      sk: "#META",
    });
    expect(transaction.input.TransactItems[3].Put.Item).toMatchObject({
      entityType: "REVOCATION_OUTBOX",
      siteId: "site-1",
      status: "pending",
    });
    expect(transaction.input.TransactItems[8].Put.Item).toMatchObject({
      status: "applying",
      queuedSiteCount: 2,
    });
    expect(ddbSend).toHaveBeenCalledTimes(7);
    expect(JSON.parse(String(response.body))).toMatchObject({
      status: "applying",
      affectedSiteCount: 2,
      queuedSiteCount: 2,
      enqueueFailedCount: 0,
    });
  });

  it("rejects fewer than two Sites", async () => {
    const response = await call(
      previewEmergencySiteRevocation,
      event({ siteIds: ["site-1"] }),
    );
    expect(response.statusCode).toBe(400);
    expect(ddbSend).not.toHaveBeenCalled();
  });
});

function mockTwoSitePreview() {
  ddbSend
    .mockResolvedValueOnce({
      Item: {
        siteId: "site-1",
        name: "Site One",
        status: "active",
        siteCredentialGeneration: 3,
      },
    })
    .mockResolvedValueOnce({
      Items: [
        {
          bindingId: "binding-1",
          label: "Tablet one",
          accessLevel: "general",
          status: "active",
        },
      ],
    })
    .mockResolvedValueOnce({ Items: [] })
    .mockResolvedValueOnce({
      Item: {
        siteId: "site-2",
        name: "Site Two",
        status: "active",
        siteCredentialGeneration: 7,
      },
    })
    .mockResolvedValueOnce({ Items: [] })
    .mockResolvedValueOnce({ Items: [] });
}

/** @param {Record<string, unknown>} body */
function event(body) {
  return /** @type {any} */ ({
    body: JSON.stringify(body),
    requestContext: {
      authorizer: {
        jwt: {
          claims: { "cognito:groups": "central-admin", sub: "admin-1" },
        },
      },
    },
  });
}

/** @param {import("aws-lambda").APIGatewayProxyHandlerV2} handler @param {any} request */
async function call(handler, request) {
  return /** @type {any} */ (
    await handler(request, /** @type {any} */ ({}), () => {})
  );
}
