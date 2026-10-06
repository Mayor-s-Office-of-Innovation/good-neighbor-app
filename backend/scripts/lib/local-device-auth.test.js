import { beforeEach, describe, expect, it, vi } from "vitest";

import { resolveDeviceClaims } from "./local-device-auth.mjs";

beforeEach(() => {
  process.env.DEVICE_TOKEN_SECRET = "local-test-secret";
});

describe("resolveDeviceClaims", () => {
  it("keeps requests without a Bearer token on the local debug posture", async () => {
    const authorize = vi.fn();

    await expect(resolveDeviceClaims({}, authorize)).resolves.toBeNull();
    expect(authorize).not.toHaveBeenCalled();
  });

  it("returns the real authorizer claims for an active device", async () => {
    const authorize = vi.fn().mockResolvedValue({
      isAuthorized: true,
      context: {
        "claims.sub": "binding-1",
        "claims.custom:siteId": "site-1",
        "claims.ver": 4,
        "claims.accessLevel": "manager",
      },
    });

    await expect(
      resolveDeviceClaims({ authorization: "Bearer signed-token" }, authorize),
    ).resolves.toEqual({
      sub: "binding-1",
      siteId: "site-1",
      ver: 4,
      accessLevel: "manager",
    });
  });

  it("fails closed when the live authorizer rejects a revoked device", async () => {
    const authorize = vi.fn().mockResolvedValue({
      isAuthorized: false,
      context: { reason: "revoked" },
    });

    await expect(
      resolveDeviceClaims(
        { authorization: "Bearer still-signed-token" },
        authorize,
      ),
    ).resolves.toEqual({ error: "revoked" });
  });
});
