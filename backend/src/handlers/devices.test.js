import { PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Document Client so the handlers' writes hit a spy, not AWS.
const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../db.js", () => ({ ddb: { send } }));

const { registerDevice, refreshDeviceToken } = await import("./devices.js");

const SITE_CODE_ITEM = {
  pk: "SITE_CODE#123456",
  sk: "#META",
  active: true,
  providerSiteId: "provider-1",
  siteId: "site-1",
  siteName: "City Hall",
};

/** @param {string} secret */
const withSecret = (secret) => {
  process.env.DEVICE_TOKEN_SECRET = secret;
  process.env.DYNAMO_TABLE = "gnp-test-app";
};

/**
 * Build a proxy event with a JSON body.
 * @param {unknown} body
 * @param {Record<string, string>} [headers]
 * @returns {{ headers: Record<string, string>, body: string }}
 */
const event = (body, headers = {}) => ({
  headers,
  body: JSON.stringify(body),
});

/**
 * @param {unknown} body
 * @param {Record<string, string>} [headers]
 * @returns {Promise<any>} the handler's proxy result
 */
const callRegister = (body, headers) =>
  /** @type {Promise<any>} */ (
    /** @type {any} */ (
      registerDevice(
        /** @type {any} */ (event(body, headers)),
        /** @type {any} */ ({}),
        () => {},
      )
    )
  );

/**
 * @param {unknown} body
 * @returns {Promise<any>}
 */
const callRefresh = (body) =>
  /** @type {Promise<any>} */ (
    /** @type {any} */ (
      refreshDeviceToken(
        /** @type {any} */ (event(body)),
        /** @type {any} */ ({}),
        () => {},
      )
    )
  );

/**
 * Read back the DeviceItem the handler wrote (the PutCommand input).
 * @returns {any} the DEVICE# item, or undefined
 */
function putItem() {
  const put = send.mock.calls
    .map(([cmd]) => cmd)
    .find(
      (cmd) => cmd instanceof PutCommand && cmd.input.Item?.type === "device",
    );
  return /** @type {any} */ (put)?.input.Item;
}

beforeEach(() => {
  send.mockReset();
  withSecret("test-secret-0123456789abcdef");
});

describe("registerDevice", () => {
  it("400s without a code", async () => {
    const res = await callRegister({});
    expect(res.statusCode).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  it("401s an inactive/unknown code", async () => {
    send.mockResolvedValueOnce({ Item: { active: false } });
    const res = await callRegister({ code: "000000" });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toBe("invalid_site_code");
  });

  it("creates the DEVICE# item keyed to the site from the code, mints a session", async () => {
    send
      .mockResolvedValueOnce({ Item: SITE_CODE_ITEM }) // site-code lookup
      .mockResolvedValueOnce({}) // GetCommand (known-device check) → none
      .mockResolvedValueOnce({}) // PutItem DEVICE#
      .mockResolvedValueOnce({}) // UpdateItem (session stamp)
      // lib/principal.js contract: claims resolve to SITE#site-1 keys
      .mockResolvedValue({});

    const res = await callRegister({ code: "123-456", label: "Tablet 2" });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.deviceId).toBeTruthy();
    expect(body.site).toEqual({ siteId: "site-1", name: "City Hall" });
    expect(body.refreshToken).toBeTruthy();
    expect(body.tokenGeneration).toBe(1);

    // The DEVICE# item is pinned to the CODE's site — never a body field.
    const item = putItem();
    expect(item.pk).toBe("SITE#site-1");
    expect(item.sk).toBe(`DEVICE#${body.deviceId}`);
    expect(item.tokenGeneration).toBe(1);

    // Access token claims carry the Cognito-shaped claim the handlers read.
    const claims = JSON.parse(
      Buffer.from(body.token.split(".")[1], "base64").toString("utf8"),
    );
    expect(claims["custom:siteId"]).toBe("site-1");
    expect(claims.sub).toBe(body.deviceId);
    expect(claims.ver).toBe(1);
    expect(claims.typ).toBe("access");

    // The refresh jti persisted matches the minted refresh token.
    const refreshClaims = JSON.parse(
      Buffer.from(body.refreshToken.split(".")[1], "base64").toString("utf8"),
    );
    const update = send.mock.calls
      .map(([cmd]) => cmd)
      .find((cmd) => cmd instanceof UpdateCommand);
    expect(
      /** @type {any} */ (update)?.input.ExpressionAttributeValues[":jti"],
    ).toBe(refreshClaims.jti);
  });

  it("is idempotent for a known deviceId: bumps generation, keeps registration", async () => {
    send
      .mockResolvedValueOnce({ Item: SITE_CODE_ITEM }) // site-code lookup
      .mockResolvedValueOnce({
        Item: {
          deviceId: "dev-x",
          siteId: "site-1",
          label: "Front desk",
          registeredAt: "2026-01-01T00:00:00.000Z",
          tokenGeneration: 4,
        },
      }) // GetCommand known-device
      .mockResolvedValueOnce({}) // PutItem
      .mockResolvedValueOnce({}); // UpdateItem

    const res = await callRegister({ code: "123456", deviceId: "dev-x" });

    expect(res.statusCode).toBe(201);
    const item = putItem();
    expect(item.deviceId).toBe("dev-x");
    // Re-registration keeps the ORIGINAL registration timestamp…
    expect(item.registeredAt).toBe("2026-01-01T00:00:00.000Z");
    // …and advances the session generation (old tokens die).
    expect(item.tokenGeneration).toBe(5);
    expect(JSON.parse(res.body).tokenGeneration).toBe(5);
  });
});

describe("refreshDeviceToken", () => {
  /**
   * Mint a real refresh token and stub the DEVICE# item it validates against.
   * @param {{ generation?: number }} [opts]
   * @returns {Promise<string>} the minted refresh token
   */
  async function setupRefresh({ generation = 2 } = {}) {
    const { mintRefreshToken } = await import("../lib/device-token.js");
    const { token, jti } = await mintRefreshToken(
      { siteId: "site-1", deviceId: "dev-1", tokenGeneration: generation },
      { now: 1000, expiresIn: 365 * 24 * 3600 },
    );
    send.mockReset();
    withSecret("test-secret-0123456789abcdef");
    send
      .mockResolvedValueOnce({
        Item: {
          deviceId: "dev-1",
          siteId: "site-1",
          siteName: "City Hall",
          tokenGeneration: generation,
          refreshJti: jti,
        },
      })
      .mockResolvedValueOnce({}); // UpdateItem (rotation)
    return token;
  }

  it("400s without a refresh token", async () => {
    const res = await callRefresh({});
    expect(res.statusCode).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  it("401s a non-refresh access token", async () => {
    const { mintAccessToken } = await import("../lib/device-token.js");
    const { token } = await mintAccessToken(
      { siteId: "site-1", deviceId: "dev-1", tokenGeneration: 1 },
      { now: 1000 },
    );
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2000 * 1000));
    try {
      const res = await callRefresh({ refreshToken: token });
      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.body).reason).toBe("not_a_refresh_token");
    } finally {
      vi.useRealTimers();
    }
  });

  it("401s when the device's generation moved (revoked)", async () => {
    const { mintRefreshToken } = await import("../lib/device-token.js");
    const { token } = await mintRefreshToken(
      { siteId: "site-1", deviceId: "dev-1", tokenGeneration: 2 },
      { now: 1000, expiresIn: 365 * 24 * 3600 },
    );
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2000 * 1000));
    try {
      send.mockResolvedValueOnce({
        Item: { tokenGeneration: 3, refreshJti: "whatever" },
      });
      const res = await callRefresh({ refreshToken: token });
      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.body).reason).toBe("revoked_or_replayed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("401s a replayed refresh token (jti superseded)", async () => {
    const { mintRefreshToken } = await import("../lib/device-token.js");
    const { token, jti } = await mintRefreshToken(
      { siteId: "site-1", deviceId: "dev-1", tokenGeneration: 2 },
      { now: 1000, expiresIn: 365 * 24 * 3600 },
    );
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2000 * 1000));
    try {
      send.mockResolvedValueOnce({
        Item: { tokenGeneration: 2, refreshJti: `old-${jti}` },
      });
      const res = await callRefresh({ refreshToken: token });
      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.body).reason).toBe("revoked_or_replayed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("rotates: bumps generation, stores the NEW jti, returns a fresh pair", async () => {
    const oldToken = await setupRefresh({ generation: 2 });
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2000 * 1000));
    try {
      const res = await callRefresh({ refreshToken: oldToken });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.deviceId).toBe("dev-1");
      expect(body.tokenGeneration).toBe(3);

      // Old refresh token no longer matches the stored jti (single-use).
      const oldJti = JSON.parse(
        Buffer.from(oldToken.split(".")[1], "base64").toString("utf8"),
      ).jti;
      const newJti = JSON.parse(
        Buffer.from(body.refreshToken.split(".")[1], "base64").toString("utf8"),
      ).jti;
      expect(newJti).not.toBe(oldJti);
      const update = send.mock.calls
        .map(([cmd]) => cmd)
        .find((cmd) => cmd instanceof UpdateCommand);
      expect(
        /** @type {any} */ (update)?.input.ExpressionAttributeValues[":jti"],
      ).toBe(newJti);
      expect(
        /** @type {any} */ (update)?.input.ExpressionAttributeValues[":g"],
      ).toBe(3);

      // The new access token is verifiable + carries the rotated generation.
      const { verifyDeviceToken } = await import("../lib/device-token.js");
      const claims = await verifyDeviceToken(body.token);
      expect(claims.ver).toBe(3);
      expect(claims.typ).toBe("access");
    } finally {
      vi.useRealTimers();
    }
  });

  it("expired refresh token → 401 expired", async () => {
    const { mintRefreshToken } = await import("../lib/device-token.js");
    const { token } = await mintRefreshToken(
      { siteId: "site-1", deviceId: "dev-1", tokenGeneration: 1 },
      { now: 1000, expiresIn: 60 },
    );
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2000 * 1000));
    try {
      const res = await callRefresh({ refreshToken: token });
      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.body).reason).toBe("expired");
    } finally {
      vi.useRealTimers();
    }
  });
});
