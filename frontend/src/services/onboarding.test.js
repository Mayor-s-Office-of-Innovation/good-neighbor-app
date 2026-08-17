import { afterEach, describe, expect, it, vi } from "vitest";
import { formatSiteCode, validateSetupCode } from "./onboarding.js";

describe("formatSiteCode", () => {
  it("normalizes visual separators", () => {
    expect(formatSiteCode("123-456")).toBe("123456");
    expect(formatSiteCode(" 123 456 ")).toBe("123456");
  });
});

describe("validateSetupCode", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("accepts active provider-site codes from the backend", async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          code: "123456",
          providerSite: {
            id: "provider-site-health-center-mission",
            siteId: "site-health-center-mission",
            name: "Health Center Mission",
          },
        }),
    });
    vi.stubGlobal("fetch", fetch);

    await expect(validateSetupCode("654321")).resolves.toEqual({
      ok: true,
      code: "123456",
      providerSite: {
        id: "provider-site-health-center-mission",
        siteId: "site-health-center-mission",
        name: "Health Center Mission",
      },
    });
    expect(fetch.mock.calls[0][0]).toBe("/site-code");
  });

  it("targets the local API port when the frontend runs on localhost", async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ error: "invalid_site_code" }),
    });
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("location", { hostname: "127.0.0.1" });

    await validateSetupCode("654321");

    expect(fetch.mock.calls[0][0]).toBe("http://127.0.0.1:3001/site-code");
  });

  it("maps inactive codes to invalid", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ error: "invalid_site_code" }),
      }),
    );

    await expect(validateSetupCode("000000")).resolves.toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("reports network failures without accepting a code in the browser", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("failed")));

    await expect(validateSetupCode("123456")).resolves.toEqual({
      ok: false,
      reason: "network",
    });
  });

  it("does not override backend rejections for seeded local codes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: () => Promise.resolve({ error: "not found" }),
      }),
    );

    await expect(validateSetupCode("123456")).resolves.toEqual({
      ok: false,
      reason: "invalid",
    });
  });
});
