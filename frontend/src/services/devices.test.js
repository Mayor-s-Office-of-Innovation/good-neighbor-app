import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api-error.js";
import {
  redeemEnrollmentGrant,
  redeemHandoffGrant,
  refreshDeviceToken,
} from "./devices.js";

/**
 * A JSON Response stub. `ok` derives from status, matching the real Response.
 * @param {{ status?: number, body?: any }} [opts]
 */
function jsonResponse({ status = 200, body = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  };
}

const session = {
  deviceId: "dev_1",
  site: { siteId: "site_1", name: "Site" },
  token: "access-2",
  refreshToken: "refresh-2",
  expiresIn: 100,
  refreshExpiresIn: 200,
  tokenGeneration: 2,
  accessLevel: "general",
};

describe("refreshDeviceToken", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => jsonResponse({ body: session })),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("returns the session on 200", async () => {
    await expect(refreshDeviceToken("refresh-1")).resolves.toMatchObject({
      token: "access-2",
    });
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/v1/devices/token:refresh"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ refreshToken: "refresh-1" }),
      }),
    );
  });

  it("throws ApiError with status 401 on a rejected refresh (fatal)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => jsonResponse({ status: 401 })),
    );
    const err = await refreshDeviceToken("refresh-1").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(401);
  });

  it("throws ApiError with the server status on a 5xx (retryable)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => jsonResponse({ status: 503 })),
    );
    const err = await refreshDeviceToken("refresh-1").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(503);
  });

  it("throws ApiError with status 0 on a transport failure (retryable)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline"))),
    );
    const err = await refreshDeviceToken("refresh-1").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(0);
  });

  it("throws ApiError (status 0) on a malformed 2xx body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => jsonResponse({ body: { token: 42 } })),
    );
    const err = await refreshDeviceToken("refresh-1").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(0);
  });
});

describe("redeemEnrollmentGrant", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        jsonResponse({
          status: 201,
          body: {
            ...session,
            accessLevel: "manager",
            physicalDeviceId: "physical-1",
            bindingId: "binding-1",
          },
        }),
      ),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("posts the fragment secrets and existing physical identity", async () => {
    await expect(
      redeemEnrollmentGrant("grant-1", "secret-token", {
        physicalDeviceId: "physical-1",
      }),
    ).resolves.toMatchObject({ accessLevel: "manager" });
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/app/v1/enrollment/redeem"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          grantId: "grant-1",
          token: "secret-token",
          physicalDeviceId: "physical-1",
        }),
      }),
    );
  });

  it("maps a rejected grant to a non-specific link error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => jsonResponse({ status: 401 })),
    );
    await expect(redeemEnrollmentGrant("grant-1", "bad-token")).rejects.toThrow(
      "invalid enrollment link",
    );
  });

  it("preserves verified invitation failures and support references", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        jsonResponse({
          status: 409,
          body: { error: "enrollment_already_used", requestId: "request-1" },
        }),
      ),
    );
    await expect(
      redeemEnrollmentGrant("grant-1", "secret"),
    ).rejects.toMatchObject({
      code: "enrollment_already_used",
      requestId: "request-1",
    });
  });

  it("does not misreport a missing API route as an expired link", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => jsonResponse({ status: 404 })),
    );
    await expect(redeemEnrollmentGrant("grant-1", "token")).rejects.toThrow(
      "enrollment failed (404)",
    );
  });
});

describe("redeemHandoffGrant", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("posts the grant in the body and returns the session", async () => {
    const fetch = vi.fn(() => jsonResponse({ body: session }));
    vi.stubGlobal("fetch", fetch);

    await expect(redeemHandoffGrant("g-1", "t-1")).resolves.toMatchObject({
      token: "access-2",
    });
    const [url, init] = /** @type {any[]} */ (fetch.mock.calls[0]);
    expect(url).toMatch(/\/app\/v1\/session-handoff\/redeem$/);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ grantId: "g-1", token: "t-1" });
  });

  it("maps a 401 to InvalidHandoffGrantError and other failures to ApiError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => jsonResponse({ status: 401, body: {} })),
    );
    await expect(redeemHandoffGrant("g-1", "t-1")).rejects.toMatchObject({
      name: "InvalidHandoffGrantError",
      status: 401,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(() => jsonResponse({ status: 503, body: {} })),
    );
    await expect(redeemHandoffGrant("g-1", "t-1")).rejects.toMatchObject({
      name: "ApiError",
      status: 503,
    });
  });
});
