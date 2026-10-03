import { createHmac } from "node:crypto";
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

/**
 * Sign the pre-access-level claim shape used by already-deployed sessions.
 * @param {Record<string, unknown>} claims
 * @returns {string}
 */
function legacyToken(claims) {
  /** @param {unknown} value @returns {string} */
  const encode = (value) =>
    Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode(claims);
  const signature = createHmac("sha256", "test-secret-0123456789abcdef")
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

describe("mint + verify round-trip", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("round-trips an access token's claims", async () => {
    const { token, expiresIn } = await mintAccessToken(
      { siteId: "site-1", deviceId: "dev-1", tokenGeneration: 3 },
      { now: at(1000) },
    );
    expect(expiresIn).toBe(15 * 60);

    const claims = await verifyDeviceToken(token, { now: at(1000) + 500 });
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

  it("treats a signed legacy token without accessLevel as general", async () => {
    const token = legacyToken({
      sub: "dev-1",
      "custom:siteId": "site-1",
      ver: 2,
      typ: "access",
      iat: at(1000),
      exp: at(3000),
    });

    const claims = await verifyDeviceToken(token, { now: at(2000) });

    expect(claims.accessLevel).toBe("general");
  });

  it("reads legacy admin claims as canonical manager access", async () => {
    const token = legacyToken({
      sub: "dev-1",
      "custom:siteId": "site-1",
      ver: 2,
      typ: "access",
      accessLevel: "admin",
      iat: at(1000),
      exp: at(3000),
    });
    await expect(
      verifyDeviceToken(token, { now: at(2000) }),
    ).resolves.toMatchObject({
      accessLevel: "manager",
    });
  });

  it.each([null, "", "owner"])(
    "rejects an explicit invalid access level: %j",
    async (accessLevel) => {
      const token = legacyToken({
        sub: "dev-1",
        "custom:siteId": "site-1",
        ver: 2,
        typ: "access",
        accessLevel,
        iat: at(1000),
        exp: at(3000),
      });

      await expect(
        verifyDeviceToken(token, { now: at(2000) }),
      ).rejects.toMatchObject({ code: "malformed" });
    },
  );

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
