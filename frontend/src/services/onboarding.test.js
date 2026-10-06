import { afterEach, describe, expect, it, vi } from "vitest";
import { t } from "../i18n/i18n.js";
import {
  formatSiteCode,
  requestManagerAccess,
  requestSetupCode,
  searchSites,
  validateSetupCode,
} from "./onboarding.js";

describe("requestManagerAccess", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns the generic response without asking for a Site", async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
      json: () =>
        Promise.resolve({
          message:
            "If that email is authorized, enrollment instructions will arrive shortly.",
        }),
    });
    vi.stubGlobal("fetch", fetch);
    await expect(requestManagerAccess("manager@example.org")).resolves.toEqual({
      ok: true,
      message:
        "If that email is authorized, enrollment instructions will arrive shortly.",
    });
    expect(fetch.mock.calls[0][0]).toBe("/app/v1/manager-access/request");
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
      email: "manager@example.org",
    });
  });
});

describe("formatSiteCode", () => {
  it("normalizes visual separators", () => {
    expect(formatSiteCode("123-456")).toBe("123456");
    expect(formatSiteCode(" 123 456 ")).toBe("123456");
  });
});

describe("searchSites", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("searches public-safe site records", async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          sites: [{ siteId: "site-1", name: "City Hall" }],
        }),
    });
    vi.stubGlobal("fetch", fetch);

    await expect(searchSites("city hall")).resolves.toEqual({
      ok: true,
      sites: [{ siteId: "site-1", name: "City Hall" }],
    });
    expect(fetch.mock.calls[0][0]).toBe("/v1/sites:search?q=city%20hall");
  });

  it("does not search for one-character queries", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    await expect(searchSites("c")).resolves.toEqual({
      ok: false,
      reason: "empty",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("requestSetupCode", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requests a code email and returns the generic message", async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
      json: () =>
        Promise.resolve({
          message: "Check your inbox for a setup code.",
        }),
    });
    vi.stubGlobal("fetch", fetch);

    await expect(
      requestSetupCode({ siteId: "site-1", email: "lead@example.org" }),
    ).resolves.toEqual({
      ok: true,
      message: "Check your inbox for a setup code.",
    });
    expect(fetch.mock.calls[0][0]).toBe("/v1/setup-codes:request");
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
      siteId: "site-1",
      email: "lead@example.org",
    });
  });

  it("falls back to the generic message when the server sends none", async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
      json: () => Promise.resolve({}),
    });
    vi.stubGlobal("fetch", fetch);

    await expect(
      requestSetupCode({ siteId: "site-1", email: "lead@example.org" }),
    ).resolves.toEqual({
      ok: true,
      message: t("onboarding.setupCodeRequested.message"),
    });
  });

  it("rejects malformed local requests before fetch", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    await expect(
      requestSetupCode({ siteId: "site-1", email: "not-email" }),
    ).resolves.toEqual({ ok: false, reason: "invalid" });
    expect(fetch).not.toHaveBeenCalled();
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
    // Same-origin path in dev — the Vite proxy forwards it to the local API, so
    // it works identically from localhost and from a phone on the LAN. No
    // hostname sniffing (which broke LAN-IP origins).
    expect(fetch.mock.calls[0][0]).toBe("/site-code");
  });

  it("uses a same-origin path regardless of the frontend hostname", async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ error: "invalid_site_code" }),
    });
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("location", { hostname: "10.18.37.82" });

    await validateSetupCode("654321");

    expect(fetch.mock.calls[0][0]).toBe("/site-code");
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
