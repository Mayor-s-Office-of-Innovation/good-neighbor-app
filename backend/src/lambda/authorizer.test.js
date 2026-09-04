import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Document Client so the authorizer's device lookup hits a spy.
const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../db.js", () => ({ ddb: { send } }));

// Test fixture, not a secret — the local/CI token-signing key for unit tests.
process.env.DEVICE_TOKEN_SECRET = "test-secret-0123456789abcdef"; // gitleaks:allow
process.env.DYNAMO_TABLE = "gnp-test-app";

const { handler } = await import("./authorizer.js");
const { mintAccessToken, mintRefreshToken } = await import(
  "../lib/device-token.js"
);

/**
 * @param {string} [authorization] full header value
 * @returns {{ headers: Record<string, string> }} the authorizer event
 */
const event = (authorization) => ({
  headers: authorization ? { authorization } : {},
});

/**
 * @param {any} e
 * @returns {Promise<any>}
 */
const invoke = (e) => handler(e);

beforeEach(() => {
  send.mockReset();
});

describe("authorizer", () => {
  it("denies a missing token", async () => {
    const res = await invoke(event());
    expect(res.isAuthorized).toBe(false);
    expect(res.context.reason).toBe("missing_token");
    expect(send).not.toHaveBeenCalled();
  });

  it("denies a bad signature", async () => {
    const { token } = await mintAccessToken(
      { siteId: "s", deviceId: "d", tokenGeneration: 1 },
      { now: 1000, secret: "other-secret" },
    );
    const res = await invoke(event(`Bearer ${token}`));
    expect(res.isAuthorized).toBe(false);
    expect(res.context.reason).toBe("bad_signature");
  });

  it("denies an expired token", async () => {
    const { token } = await mintAccessToken(
      { siteId: "s", deviceId: "d", tokenGeneration: 1 },
      { now: 1000, expiresIn: 60 },
    );
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2000 * 1000));
    try {
      const res = await invoke(event(`Bearer ${token}`));
      expect(res.isAuthorized).toBe(false);
      expect(res.context.reason).toBe("expired");
    } finally {
      vi.useRealTimers();
    }
  });

  it("denies a refresh token used as an access token", async () => {
    const { token } = await mintRefreshToken(
      { siteId: "s", deviceId: "d", tokenGeneration: 1 },
      { now: 1000, expiresIn: 365 * 24 * 3600 },
    );
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2000 * 1000));
    try {
      const res = await invoke(event(`Bearer ${token}`));
      expect(res.isAuthorized).toBe(false);
      expect(res.context.reason).toBe("not_an_access_token");
    } finally {
      vi.useRealTimers();
    }
  });

  it("denies a revoked device (generation bumped after mint)", async () => {
    const { token } = await mintAccessToken(
      { siteId: "site-1", deviceId: "dev-1", tokenGeneration: 1 },
      { now: 1000 },
    );
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2000 * 1000));
    try {
      send.mockResolvedValueOnce({ Item: { tokenGeneration: 2 } }); // revoked
      const res = await invoke(event(`Bearer ${token}`));
      expect(res.isAuthorized).toBe(false);
      expect(res.context.reason).toBe("revoked");
    } finally {
      vi.useRealTimers();
    }
  });

  it("denies a deleted device", async () => {
    const { token } = await mintAccessToken(
      { siteId: "site-1", deviceId: "dev-1", tokenGeneration: 1 },
      { now: 1000 },
    );
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2000 * 1000));
    try {
      send.mockResolvedValueOnce({}); // no Item
      const res = await invoke(event(`Bearer ${token}`));
      expect(res.isAuthorized).toBe(false);
      expect(res.context.reason).toBe("revoked");
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows a valid token and injects the flat REQUEST-authorizer claims", async () => {
    const { token } = await mintAccessToken(
      { siteId: "site-1", deviceId: "dev-1", tokenGeneration: 7 },
      { now: 1000 },
    );
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2000 * 1000));
    try {
      send.mockResolvedValueOnce({ Item: { tokenGeneration: 7 } });

      const res = await invoke(event(`Bearer ${token}`));

      expect(res.isAuthorized).toBe(true);
      // REQUEST-authorizer context: FLAT string-valued keys only (API Gateway
      // flattens context to $context.authorizer.<key>; nested objects and the
      // `claims` placeholder are reserved for JWT authorizers). The
      // "claims.<claim>" keys mirror what lib/principal.js reads.
      expect(res.context).toEqual({
        "claims.sub": "dev-1",
        "claims.custom:siteId": "site-1",
        "claims.ver": 7,
      });
      // The device lookup is pinned to the token's own partition.
      const cmd = send.mock.calls[0][0];
      expect(cmd).toBeInstanceOf(GetCommand);
      expect(cmd.input.Key).toEqual({ pk: "SITE#site-1", sk: "DEVICE#dev-1" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("derives siteId from the claims, never the request (negative test core)", async () => {
    // Token minted for site-A: the lookup key MUST be SITE#site-a, and a site-B
    // device item would never even be consulted.
    const { token } = await mintAccessToken(
      { siteId: "site-a", deviceId: "dev-a", tokenGeneration: 1 },
      { now: 1000 },
    );
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2000 * 1000));
    try {
      send.mockResolvedValueOnce({ Item: { tokenGeneration: 1 } });
      const res = await invoke(event(`Bearer ${token}`));
      expect(res.isAuthorized).toBe(true);
      expect(res.context["claims.custom:siteId"]).toBe("site-a");
      expect(send.mock.calls[0][0].input.Key.pk).toBe("SITE#site-a");
    } finally {
      vi.useRealTimers();
    }
  });
});
