import { beforeEach, describe, expect, it, vi } from "vitest";

// Test fixture, not a secret — the local/CI token-signing key for unit tests.
process.env.DEVICE_TOKEN_SECRET = "test-secret-0123456789abcdef"; // gitleaks:allow

const {
  mintAccessToken,
  mintRefreshToken,
  verifyDeviceToken,
  DeviceTokenError,
} = await import("./device-token.js");

/**
 * @param {number} seconds epoch seconds
 * @returns {number} epoch milliseconds
 */
const at = (seconds) => seconds * 1000;

describe("mint + verify round-trip", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("round-trips an access token's claims", async () => {
    const { token, expiresIn } = await mintAccessToken(
      { siteId: "site-1", deviceId: "dev-1", tokenGeneration: 3 },
      { now: at(1000) },
    );
    expect(expiresIn).toBe(30 * 24 * 60 * 60);

    const claims = await verifyDeviceToken(token, { now: at(2000) });
    expect(claims.sub).toBe("dev-1");
    expect(claims.siteId).toBe("site-1");
    expect(claims.ver).toBe(3);
    expect(claims.typ).toBe("access");
    expect(claims.exp).toBe(at(1000) + expiresIn);
  });

  it("round-trips a refresh token with a jti", async () => {
    const { token, jti } = await mintRefreshToken(
      { siteId: "site-1", deviceId: "dev-1", tokenGeneration: 1 },
      { now: at(1000) },
    );
    expect(jti).toMatch(/^[A-Za-z0-9_-]+$/);

    const claims = await verifyDeviceToken(token, { now: at(2000) });
    expect(claims.typ).toBe("refresh");
    expect(claims.jti).toBe(jti);
  });

  it("rejects a token after expiry", async () => {
    const { token } = await mintAccessToken(
      { siteId: "s", deviceId: "d", tokenGeneration: 1 },
      { now: at(1000), expiresIn: 60 },
    );
    await expect(
      verifyDeviceToken(token, { now: at(1061) }),
    ).rejects.toMatchObject({ code: "expired" });
  });

  it("rejects a signature minted with a different secret", async () => {
    const { token } = await mintAccessToken(
      { siteId: "s", deviceId: "d", tokenGeneration: 1 },
      { now: at(1000), secret: "other-secret" },
    );
    await expect(verifyDeviceToken(token)).rejects.toMatchObject({
      code: "bad_signature",
    });
  });

  it("rejects tampered payloads (claim edits fail the signature)", async () => {
    const { token } = await mintAccessToken(
      { siteId: "site-a", deviceId: "d", tokenGeneration: 1 },
      { now: at(1000) },
    );
    const [h, , s] = token.split(".");
    const forgedPayload = Buffer.from(
      JSON.stringify({
        sub: "d",
        "custom:siteId": "site-b",
        ver: 1,
        typ: "access",
        iat: 1000,
        exp: 2000,
      }),
    )
      .toString("base64")
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");
    await expect(
      verifyDeviceToken(`${h}.${forgedPayload}.${s}`),
    ).rejects.toMatchObject({ code: "bad_signature" });
  });

  it("rejects malformed tokens without throwing raw errors", async () => {
    await expect(verifyDeviceToken("garbage")).rejects.toBeInstanceOf(
      DeviceTokenError,
    );
    await expect(verifyDeviceToken("a.b.c")).rejects.toMatchObject({
      code: "malformed",
    });
  });

  it("throws typed not_configured when no secret source exists", async () => {
    const env = { ...process.env };
    delete process.env.DEVICE_TOKEN_SECRET;
    delete process.env.DEVICE_TOKEN_SECRET_SECRET_ARN;
    try {
      await expect(
        mintAccessToken({ siteId: "s", deviceId: "d", tokenGeneration: 1 }),
      ).rejects.toThrow(/No device token secret configured/);
    } finally {
      process.env.DEVICE_TOKEN_SECRET = env.DEVICE_TOKEN_SECRET;
    }
  });
});
