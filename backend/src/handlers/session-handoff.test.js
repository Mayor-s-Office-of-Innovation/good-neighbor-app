import { createHash } from "node:crypto";
import { TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../db.js", () => ({ ddb: { send } }));

const {
  issueSessionHandoff,
  redeemSessionHandoff,
  retireSessionHandoff,
  handoffStartUrl,
} = await import("./session-handoff.js");
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
      .mockResolvedValueOnce({
        Item: legacyDevice({ handoffGrantId: undefined }),
      })
      .mockResolvedValueOnce({});

    const response = await call(issueSessionHandoff, authorizedEvent());

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(String(response.body));
    expect(body.grantId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(body.startUrl).toBe(handoffStartUrl(body.grantId, body.token));
    expect(body.startUrl.startsWith("/#handoff_grant=")).toBe(true);
    expect(response.headers?.["set-cookie"]).toContain(
      `${body.grantId}.${body.token}`,
    );
    expect(response.headers?.["set-cookie"]).toMatch(
      /Secure; HttpOnly; SameSite=Strict/,
    );
    expect(response.headers?.["set-cookie"]).toContain(
      "Path=/app/v1/session-handoff",
    );

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
    // First grant for this device: the pointer must not exist yet.
    expect(updateDevice.Update.ConditionExpression).toContain(
      "attribute_not_exists(#status)",
    );
    expect(updateDevice.Update.ConditionExpression).toContain(
      "attribute_not_exists(handoffGrantId)",
    );
    expect(audit.Put.Item.eventType).toBe("session_handoff_issued");
  });

  it("restores a cached pending cookie without invalidating the installed grant", async () => {
    send.mockResolvedValueOnce({ Item: legacyDevice() }).mockResolvedValueOnce({
      Item: pendingGrant({ expiresAt: NOW_SECONDS + 3 * 86400 }),
    });
    const response = await call(issueSessionHandoff, {
      ...authorizedEvent(),
      body: JSON.stringify({ grantId: "grant-1", token: TOKEN }),
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(String(response.body)).grantId).toBe("grant-1");
    expect(response.headers?.["set-cookie"]).toContain(`grant-1.${TOKEN}`);
    expect(send).toHaveBeenCalledTimes(2);
    expect(
      send.mock.calls.every(
        ([command]) => !(command instanceof TransactWriteCommand),
      ),
    ).toBe(true);
  });

  it("replaces the previous pointer only from the value it read", async () => {
    send
      .mockResolvedValueOnce({
        Item: legacyDevice({ handoffGrantId: "old-grant" }),
      })
      .mockResolvedValueOnce({});

    const response = await call(issueSessionHandoff, authorizedEvent());

    expect(response.statusCode).toBe(200);
    expect(send).toHaveBeenCalledTimes(2);
    const [, updateDevice, audit] = send.mock.calls[1][0].input.TransactItems;
    expect(updateDevice.Update.ConditionExpression).toContain(
      "handoffGrantId = :previous",
    );
    expect(updateDevice.Update.ExpressionAttributeValues[":previous"]).toBe(
      "old-grant",
    );
    expect(audit.Put.Item.supersededGrantId).toBe("old-grant");
  });

  it("fails closed when a concurrent issue moved the pointer first", async () => {
    send.mockResolvedValueOnce({ Item: legacyDevice() }).mockRejectedValueOnce(
      Object.assign(new Error("cancelled"), {
        name: "TransactionCanceledException",
      }),
    );
    const response = await call(issueSessionHandoff, authorizedEvent());
    expect(response.statusCode).toBe(401);
  });
});

describe("redeemSessionHandoff", () => {
  const redeem = () =>
    call(redeemSessionHandoff, openEvent({ grantId: "grant-1", token: TOKEN }));

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
      const response = await redeem();
      expect(response.statusCode).toBe(401);
      expect(JSON.parse(String(response.body))).toEqual({
        error: "invalid_handoff_grant",
      });
      // Nothing past the grant read: no device lookup, no write.
      expect(send).toHaveBeenCalledTimes(1);
    }
  });

  it("creates an independent legacy session and consumes the grant without rotating Safari", async () => {
    send
      .mockResolvedValueOnce({ Item: pendingGrant() })
      .mockResolvedValueOnce({ Item: legacyDevice({ tokenGeneration: 4 }) })
      .mockResolvedValueOnce({ Item: activeSite() })
      .mockResolvedValueOnce({});

    const response = await redeem();

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(String(response.body));
    expect(body.deviceId).toBe("device-1");
    expect(body).toMatchObject({
      site: { siteId: "site-1", name: "Mission Street Center" },
      accessLevel: "general",
      tokenGeneration: 1,
    });
    expect(body).not.toHaveProperty("bindingId");
    const access = await verifyDeviceToken(body.token);
    expect(access).toMatchObject({
      typ: "access",
      sub: "device-1",
      siteId: "site-1",
      ver: 1,
      sid: expect.any(String),
    });
    const refresh = await verifyDeviceToken(body.refreshToken);
    const [write, consume, audit] = send.mock.calls[3][0].input.TransactItems;
    expect(write.Update.Key.sk).toBe("DEVICE#device-1");
    expect(write.Update.UpdateExpression).not.toContain("SET tokenGeneration");
    expect(write.Update.UpdateExpression).toContain("REMOVE handoffGrantId");
    expect(
      write.Update.ExpressionAttributeValues[":sessions"][String(access.sid)],
    ).toMatchObject({
      kind: "home_screen",
      tokenGeneration: 1,
      refreshJti: refresh.jti,
    });
    expect(write.Update.ExpressionAttributeValues[":deviceGeneration"]).toBe(4);
    expect(consume.Update.Key.pk).toBe("SESSION_HANDOFF#grant-1");
    expect(audit.Put.Item).toMatchObject({
      eventType: "session_handed_off",
      deviceId: "device-1",
      sessionId: access.sid,
    });
    expect(response.headers?.["set-cookie"]).toContain("Max-Age=0");
  });

  it("adds a session without creating another canonical binding or physical device", async () => {
    const expires = "2027-01-01T00:00:00.000Z";
    send
      .mockResolvedValueOnce({ Item: pendingGrant({ bindingId: "binding-1" }) })
      .mockResolvedValueOnce({
        Item: boundDevice({ absoluteExpiresAt: expires }),
      })
      .mockResolvedValueOnce({ Item: binding({ absoluteExpiresAt: expires }) })
      .mockResolvedValueOnce({ Item: activeSite() })
      .mockResolvedValueOnce({ Item: { status: "active", generation: 1 } })
      .mockResolvedValueOnce({});
    const response = await redeem();
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(String(response.body))).toMatchObject({
      deviceId: "binding-1",
      bindingId: "binding-1",
      physicalDeviceId: "physical-1",
      accessLevel: "manager",
      tokenGeneration: 1,
      absoluteExpiresAt: expires,
    });
    /** @type {any[]} */
    const items = send.mock.calls[5][0].input.TransactItems;
    expect(items).toHaveLength(4);
    expect(items[0].Update.Key.sk).toBe("DEVICE#binding-1");
    expect(items[1].ConditionCheck.Key.sk).toBe("DEVICE_BINDING#binding-1");
    expect(
      items.filter((item) => item.Put).map((item) => item.Put.Item.type),
    ).toEqual(["siteAuditEvent"]);
  });

  it("redeems from the installation cookie with no launch URL credentials", async () => {
    send
      .mockResolvedValueOnce({ Item: pendingGrant() })
      .mockResolvedValueOnce({ Item: legacyDevice() })
      .mockResolvedValueOnce({ Item: activeSite() })
      .mockResolvedValueOnce({});
    const response = await call(redeemSessionHandoff, {
      ...openEvent({}),
      cookies: [`__Secure-gnp-handoff=grant-1.${TOKEN}`],
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers?.["set-cookie"]).toContain("Max-Age=0");
  });

  it("refuses a grant the device no longer points at", async () => {
    send
      .mockResolvedValueOnce({ Item: pendingGrant() })
      .mockResolvedValueOnce({
        Item: legacyDevice({ handoffGrantId: "newer-grant" }),
      })
      .mockResolvedValueOnce({ Item: activeSite() });
    expect((await redeem()).statusCode).toBe(401);
    expect(
      send.mock.calls.some((c) => c[0] instanceof TransactWriteCommand),
    ).toBe(false);
  });

  it("refuses when the device, its binding, or its site is no longer live", async () => {
    // Revoked device.
    send
      .mockResolvedValueOnce({ Item: pendingGrant() })
      .mockResolvedValueOnce({ Item: legacyDevice({ status: "revoked" }) })
      .mockResolvedValueOnce({ Item: activeSite() });
    expect((await redeem()).statusCode).toBe(401);
    expect(
      send.mock.calls.some((c) => c[0] instanceof TransactWriteCommand),
    ).toBe(false);

    // Inactive site.
    send.mockReset();
    send
      .mockResolvedValueOnce({ Item: pendingGrant() })
      .mockResolvedValueOnce({ Item: legacyDevice() })
      .mockResolvedValueOnce({ Item: activeSite({ status: "inactive" }) });
    expect((await redeem()).statusCode).toBe(401);

    // Site credential generation moved on.
    send.mockReset();
    send
      .mockResolvedValueOnce({ Item: pendingGrant() })
      .mockResolvedValueOnce({ Item: legacyDevice() })
      .mockResolvedValueOnce({
        Item: activeSite({ siteCredentialGeneration: 1 }),
      });
    expect((await redeem()).statusCode).toBe(401);

    // Binding revoked while the compatibility row still looks fine.
    send.mockReset();
    send
      .mockResolvedValueOnce({ Item: pendingGrant({ bindingId: "binding-1" }) })
      .mockResolvedValueOnce({ Item: boundDevice() })
      .mockResolvedValueOnce({ Item: binding({ status: "revoked" }) })
      .mockResolvedValueOnce({ Item: activeSite() });
    expect((await redeem()).statusCode).toBe(401);
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

    const response = await redeem();

    expect(response.statusCode).toBe(401);
    expect(JSON.parse(String(response.body))).toEqual({
      error: "invalid_handoff_grant",
    });
  });
});

describe("retireSessionHandoff", () => {
  it("answers retired:false when the device has no pending grant", async () => {
    send.mockResolvedValueOnce({
      Item: legacyDevice({ handoffGrantId: undefined }),
    });
    const response = await call(retireSessionHandoff, authorizedEvent());
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(String(response.body))).toEqual({ retired: false });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("drops the pointer from the value it read and marks the grant retired", async () => {
    send
      .mockResolvedValueOnce({ Item: legacyDevice() })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    const response = await call(retireSessionHandoff, authorizedEvent());

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(String(response.body))).toEqual({ retired: true });
    const transact = send.mock.calls[1][0];
    expect(transact).toBeInstanceOf(TransactWriteCommand);
    const [drop, audit] = transact.input.TransactItems;
    expect(drop.Update.Key).toEqual({
      pk: "SITE#site-1",
      sk: "DEVICE#device-1",
    });
    expect(drop.Update.UpdateExpression).toBe("REMOVE handoffGrantId");
    expect(drop.Update.ConditionExpression).toBe("handoffGrantId = :grantId");
    expect(drop.Update.ExpressionAttributeValues[":grantId"]).toBe("grant-1");
    expect(audit.Put.Item.eventType).toBe("session_handoff_retired");
    const grantUpdate = send.mock.calls[2][0];
    expect(grantUpdate).toBeInstanceOf(UpdateCommand);
    expect(grantUpdate.input.Key).toEqual({
      pk: "SESSION_HANDOFF#grant-1",
      sk: "#META",
    });
    expect(grantUpdate.input.ConditionExpression).toContain(
      "#status = :pending",
    );
  });

  it("tolerates a grant row that is already redeemed or reclaimed", async () => {
    send
      .mockResolvedValueOnce({ Item: legacyDevice() })
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(
        Object.assign(new Error("gone"), {
          name: "ConditionalCheckFailedException",
        }),
      );
    const response = await call(retireSessionHandoff, authorizedEvent());
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(String(response.body))).toEqual({ retired: true });
  });

  it("answers retired:false when the pointer moved meanwhile", async () => {
    send.mockResolvedValueOnce({ Item: legacyDevice() }).mockRejectedValueOnce(
      Object.assign(new Error("cancelled"), {
        name: "TransactionCanceledException",
      }),
    );
    const response = await call(retireSessionHandoff, authorizedEvent());
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(String(response.body))).toEqual({ retired: false });
    expect(send).toHaveBeenCalledTimes(2);
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
    handoffGrantId: "grant-1",
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
    handoffGrantId: "grant-1",
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
