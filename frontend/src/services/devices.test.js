import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api-error.js";
import { refreshDeviceToken } from "./devices.js";

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
