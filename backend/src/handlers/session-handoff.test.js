import { createHash } from "node:crypto";
import { TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../db.js", () => ({ ddb: { send } }));

const { issueSessionHandoff, redeemSessionHandoff, handoffStartUrl } =
  await import("./session-handoff.js");
const { verifyDeviceToken } = await import("../lib/device-token.js");

const TOKEN = "handoff-secret-token";
const TOKEN_HASH = createHash("sha256").update(TOKEN).digest("hex");
const NOW_SECONDS = Math.floor(Date.now() / 1000);

beforeEach(() => {
  send.mockReset();
  vi.stubEnv("DYNAMO_TABLE", "gnp-test-app");
  vi.stubEnv("DEVICE_TOKEN_SECRET", "test-device-secret-at-least-32-bytes");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("issueSessionHandoff", () => {
  it("refuses a device that is missing or not live", async () => {
    send.mockResolvedValueOnce({ Item: undefined });
    const missing = await call(issueSessionHandoff, authorizedEvent());
    expect(missing.statusCode).toBe(401);
    expect(send).toHaveBeenCalledTimes(1);

    send.mockReset();
    send.mockResolvedValueOnce({ Item: legacyDevice({ status: "revoked" }) });
    const revoked = await call(issueSessionHandoff, authorizedEvent());
    expect(revoked.statusCode).toBe(401);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("mints a pending grant for the calling device and pins it on the record", async () => {
    send
      .mockResolvedValueOnce({ Item: legacyDevice() })
      .mockResolvedValueOnce({});

    const response = await call(issueSessionHandoff, authorizedEvent());

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(String(response.body));
    expect(body.grantId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(body.startUrl).toBe(handoffStartUrl(body.grantId, body.token));
    expect(body.startUrl.startsWith("/#handoff_grant=")).toBe(true);

    expect(send).toHaveBeenCalledTimes(2);
    const transact = send.mock.calls[1][0];
    expect(transact).toBeInstanceOf(TransactWriteCommand);
    const [putGrant, updateDevice, audit] = transact.input.TransactItems;
    const grant = putGrant.Put.Item;
    expect(grant.pk).toBe(`SESSION_HANDOFF#${body.grantId}`);
    expect(grant.status).toBe("pending");
    expect(grant.siteId).toBe("site-1");
    expect(grant.deviceId).toBe("device-1");
    expect(grant.tokenHash).toBe(
      createHash("sha256").update(body.token).digest("hex"),
    );
    expect(grant).not.toHaveProperty("token");
    expect(grant).not.toHaveProperty("accessLevel");
    // Numeric epoch seconds so the table TTL reclaims it.
    expect(typeof grant.expiresAt).toBe("number");
    expect(grant.expiresAt).toBeGreaterThan(NOW_SECONDS + 6 * 24 * 60 * 60);
    expect(updateDevice.Update.Key).toEqual({
      pk: "SITE#site-1",
      sk: "DEVICE#device-1",
    });
    expect(updateDevice.Update.ConditionExpression).toContain(
      "attribute_not_exists(#status)",
    );
    expect(audit.Put.Item.eventType).toBe("session_handoff_issued");
  });

  it("supersedes the previous pending grant before issuing a new one", async () => {
    send
      .mockResolvedValueOnce({
        Item: legacyDevice({ handoffGrantId: "old-grant" }),
      })
      .mockRejectedValueOnce(
        Object.assign(new Error("gone"), {
          name: "ConditionalCheckFailedException",
        }),
      )
      .mockResolvedValueOnce({});

    const response = await call(issueSessionHandoff, authorizedEvent());

    expect(response.statusCode).toBe(200);
    const supersede = send.mock.calls[1][0];
    expect(supersede).toBeInstanceOf(UpdateCommand);
    expect(supersede.input.Key).toEqual({
      pk: "SESSION_HANDOFF#old-grant",
      sk: "#META",
    });
    expect(supersede.input.ConditionExpression).toContain("#status = :pending");
    expect(send.mock.calls[2][0]).toBeInstanceOf(TransactWriteCommand);
  });
});

describe("redeemSessionHandoff", () => {
  it("rejects a malformed body or missing fields without touching the table", async () => {
    const malformed = await call(redeemSessionHandoff, {
      body: "{not json",
      requestContext: {},
    });
    expect(malformed.statusCode).toBe(400);
    const empty = await call(redeemSessionHandoff, openEvent({}));
    expect(empty.statusCode).toBe(401);
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects an unknown grant, a wrong token, an expired grant, and a replay the same way", async () => {
    const cases = [
      { Item: undefined },
      { Item: pendingGrant({ tokenHash: "00".repeat(32) }) },
      { Item: pendingGrant({ expiresAt: NOW_SECONDS - 1 }) },
      { Item: pendingGrant({ status: "redeemed" }) },
    ];
    for (const grantRead of cases) {
      send.mockReset();
      send.mockResolvedValueOnce(grantRead);
      const response = await call(
        redeemSessionHandoff,
        openEvent({ grantId: "grant-1", token: TOKEN }),
      );
      expect(response.statusCode).toBe(401);
      expect(JSON.parse(String(response.body))).toEqual({
        error: "invalid_handoff_grant",
      });
      // Nothing past the grant read: no device lookup, no write.
      expect(send).toHaveBeenCalledTimes(1);
    }
  });

  it("re-mints the session on a legacy setup-code device and consumes the grant atomically", async () => {
    send
      .mockResolvedValueOnce({ Item: pendingGrant() })
      .mockResolvedValueOnce({ Item: legacyDevice({ tokenGeneration: 4 }) })
      .mockResolvedValueOnce({ Item: activeSite() })
      .mockResolvedValueOnce({});

    const response = await call(
      redeemSessionHandoff,
      openEvent({ grantId: "grant-1", token: TOKEN }),
    );

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(String(response.body));
    expect(body).toMatchObject({
      deviceId: "device-1",
      site: { siteId: "site-1", name: "Mission Street Center" },
      accessLevel: "general",
      tokenGeneration: 5,
    });
    expect(body).not.toHaveProperty("bindingId");
    const access = await verifyDeviceToken(body.token);
    expect(access).toMatchObject({
      typ: "access",
      sub: "device-1",
      siteId: "site-1",
      ver: 5,
    });
    const refresh = await verifyDeviceToken(body.refreshToken);
    expect(refresh.typ).toBe("refresh");

    const transact = send.mock.calls[3][0];
    expect(transact).toBeInstanceOf(TransactWriteCommand);
    const items = transact.input.TransactItems;
    expect(items).toHaveLength(3);
    const [rotate, consume, audit] = items;
    expect(rotate.Update.Key).toEqual({
      pk: "SITE#site-1",
      sk: "DEVICE#device-1",
    });
    expect(rotate.Update.ConditionExpression).toContain(
      "attribute_not_exists(#status)",
    );
    expect(rotate.Update.ExpressionAttributeValues[":current"]).toBe(4);
    expect(rotate.Update.ExpressionAttributeValues[":next"]).toBe(5);
    expect(rotate.Update.ExpressionAttributeValues[":jti"]).toBe(refresh.jti);
    expect(rotate.Update.UpdateExpression).toContain("REMOVE handoffGrantId");
    expect(consume.Update.Key).toEqual({
      pk: "SESSION_HANDOFF#grant-1",
      sk: "#META",
    });
    expect(consume.Update.ConditionExpression).toBe(
      "#status = :pending AND expiresAt > :nowSeconds",
    );
    expect(audit.Put.Item).toMatchObject({
      eventType: "session_handed_off",
      previousTokenGeneration: 4,
      tokenGeneration: 5,
    });
  });

  it("rotates the canonical binding alongside a binding-backed device", async () => {
    send
      .mockResolvedValueOnce({ Item: pendingGrant({ bindingId: "binding-1" }) })
      .mockResolvedValueOnce({ Item: boundDevice() })
      .mockResolvedValueOnce({ Item: binding() })
      .mockResolvedValueOnce({ Item: activeSite() })
      .mockResolvedValueOnce({ Item: { status: "active", generation: 1 } })
      .mockResolvedValueOnce({});

    const response = await call(
      redeemSessionHandoff,
      openEvent({ grantId: "grant-1", token: TOKEN }),
    );

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(String(response.body))).toMatchObject({
      deviceId: "binding-1",
      bindingId: "binding-1",
      physicalDeviceId: "physical-1",
      accessLevel: "manager",
      tokenGeneration: 2,
    });
    const items = send.mock.calls[5][0].input.TransactItems;
    expect(items).toHaveLength(4);
    expect(items[0].Update.Key.sk).toBe("DEVICE#binding-1");
    expect(items[1].Update.Key.sk).toBe("DEVICE_BINDING#binding-1");
  });

  it("refuses when the device, its binding, or its site is no longer live", async () => {
    // Revoked device.
    send
      .mockResolvedValueOnce({ Item: pendingGrant() })
      .mockResolvedValueOnce({ Item: legacyDevice({ status: "revoked" }) })
      .mockResolvedValueOnce({ Item: activeSite() });
    expect(
      (
        await call(
          redeemSessionHandoff,
          openEvent({ grantId: "grant-1", token: TOKEN }),
        )
      ).statusCode,
    ).toBe(401);
    expect(
      send.mock.calls.some((c) => c[0] instanceof TransactWriteCommand),
    ).toBe(false);

    // Inactive site.
    send.mockReset();
    send
      .mockResolvedValueOnce({ Item: pendingGrant() })
      .mockResolvedValueOnce({ Item: legacyDevice() })
      .mockResolvedValueOnce({ Item: activeSite({ status: "inactive" }) });
    expect(
      (
        await call(
          redeemSessionHandoff,
          openEvent({ grantId: "grant-1", token: TOKEN }),
        )
      ).statusCode,
    ).toBe(401);

    // Site credential generation moved on.
    send.mockReset();
    send
      .mockResolvedValueOnce({ Item: pendingGrant() })
      .mockResolvedValueOnce({ Item: legacyDevice() })
      .mockResolvedValueOnce({
        Item: activeSite({ siteCredentialGeneration: 1 }),
      });
    expect(
      (
        await call(
          redeemSessionHandoff,
          openEvent({ grantId: "grant-1", token: TOKEN }),
        )
      ).statusCode,
    ).toBe(401);

    // Binding revoked while the compatibility row still looks fine.
    send.mockReset();
    send
      .mockResolvedValueOnce({ Item: pendingGrant({ bindingId: "binding-1" }) })
      .mockResolvedValueOnce({ Item: boundDevice() })
      .mockResolvedValueOnce({ Item: binding({ status: "revoked" }) });
    expect(
      (
        await call(
          redeemSessionHandoff,
          openEvent({ grantId: "grant-1", token: TOKEN }),
        )
      ).statusCode,
    ).toBe(401);
  });

  it("fails closed when the transaction loses a race", async () => {
    send
      .mockResolvedValueOnce({ Item: pendingGrant() })
      .mockResolvedValueOnce({ Item: legacyDevice() })
      .mockResolvedValueOnce({ Item: activeSite() })
      .mockRejectedValueOnce(
        Object.assign(new Error("cancelled"), {
          name: "TransactionCanceledException",
        }),
      );

    const response = await call(
      redeemSessionHandoff,
      openEvent({ grantId: "grant-1", token: TOKEN }),
    );

    expect(response.statusCode).toBe(401);
    expect(JSON.parse(String(response.body))).toEqual({
      error: "invalid_handoff_grant",
    });
  });
});

/** @param {Record<string, any>} [overrides] */
function pendingGrant(overrides = {}) {
  return {
    pk: "SESSION_HANDOFF#grant-1",
    sk: "#META",
    type: "sessionHandoffGrant",
    grantId: "grant-1",
    siteId: "site-1",
    deviceId: overrides.bindingId ? "binding-1" : "device-1",
    tokenHash: TOKEN_HASH,
    status: "pending",
    expiresAt: NOW_SECONDS + 3600,
    ...overrides,
  };
}

/** @param {Record<string, any>} [overrides] */
function legacyDevice(overrides = {}) {
  return {
    pk: "SITE#site-1",
    sk: "DEVICE#device-1",
    type: "device",
    deviceId: "device-1",
    siteId: "site-1",
    siteName: "Mission Street Center",
    accessLevel: "general",
    tokenGeneration: 1,
    refreshJti: "jti-1",
    lastSeenAt: new Date().toISOString(),
    ...overrides,
  };
}

/** @param {Record<string, any>} [overrides] */
function boundDevice(overrides = {}) {
  return {
    pk: "SITE#site-1",
    sk: "DEVICE#binding-1",
    type: "device",
    deviceId: "binding-1",
    bindingId: "binding-1",
    physicalDeviceId: "physical-1",
    siteId: "site-1",
    siteName: "Mission Street Center",
    accessLevel: "manager",
    membershipId: "membership-1",
    membershipGeneration: 1,
    siteCredentialGeneration: 0,
    status: "active",
    tokenGeneration: 1,
    refreshJti: "jti-1",
    lastSeenAt: new Date().toISOString(),
    inactivityLimitDays: 60,
    ...overrides,
  };
}

/** @param {Record<string, any>} [overrides] */
function binding(overrides = {}) {
  return {
    pk: "SITE#site-1",
    sk: "DEVICE_BINDING#binding-1",
    type: "deviceBinding",
    bindingId: "binding-1",
    physicalDeviceId: "physical-1",
    siteId: "site-1",
    accessLevel: "manager",
    status: "active",
    tokenGeneration: 1,
    refreshJti: "jti-1",
    lastSeenAt: new Date().toISOString(),
    inactivityLimitDays: 60,
    ...overrides,
  };
}

/** @param {Record<string, any>} [overrides] */
function activeSite(overrides = {}) {
  return {
    pk: "SITE#site-1",
    sk: "#META",
    siteId: "site-1",
    name: "Mission Street Center",
    status: "active",
    siteCredentialGeneration: 0,
    ...overrides,
  };
}

function authorizedEvent() {
  return {
    body: undefined,
    requestContext: {
      authorizer: {
        jwt: { claims: { "custom:siteId": "site-1", sub: "device-1" } },
      },
    },
  };
}

/** @param {Record<string, unknown>} body */
function openEvent(body) {
  return { body: JSON.stringify(body), requestContext: {}, headers: {} };
}

/**
 * @param {any} handler
 * @param {any} request
 * @returns {Promise<import("aws-lambda").APIGatewayProxyStructuredResultV2>}
 */
async function call(handler, request) {
  return /** @type {import("aws-lambda").APIGatewayProxyStructuredResultV2} */ (
    await handler(request, /** @type {any} */ ({}), () => {})
  );
}
