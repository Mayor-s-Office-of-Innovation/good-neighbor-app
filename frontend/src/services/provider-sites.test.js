import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ listProviderSites: vi.fn() }));
vi.mock("./api.js", () => ({ listProviderSites: api.listProviderSites }));

beforeEach(() => {
  api.listProviderSites.mockReset();
});

describe("fetchProviderSites", () => {
  it("walks every page, de-duplicates, and sorts by name", async () => {
    api.listProviderSites
      .mockResolvedValueOnce({
        providerId: "provider-1",
        providerName: "Provider One",
        sites: [
          { siteId: "site-z", name: "Zeta" },
          { siteId: "site-m", name: "Mid" },
        ],
        nextCursor: "next-page",
      })
      .mockResolvedValueOnce({
        providerId: "provider-1",
        providerName: "Provider One",
        sites: [
          { siteId: "site-a", name: "Alpha" },
          { siteId: "site-m", name: "Mid (dupe)" },
        ],
        nextCursor: null,
      });
    const { fetchProviderSites } = await import("./provider-sites.js");
    const catalog = await fetchProviderSites();
    expect(api.listProviderSites.mock.calls.map(([c]) => c)).toEqual([
      "",
      "next-page",
    ]);
    expect(catalog.providerName).toBe("Provider One");
    expect(catalog.sites.map((s) => s.name)).toEqual([
      "Alpha",
      "Mid (dupe)",
      "Zeta",
    ]);
  });

  it("rejects a listing whose provider changes or whose cursor repeats", async () => {
    const { fetchProviderSites } = await import("./provider-sites.js");
    api.listProviderSites
      .mockResolvedValueOnce({ providerId: "p1", sites: [], nextCursor: "c" })
      .mockResolvedValueOnce({ providerId: "p2", sites: [], nextCursor: null });
    await expect(fetchProviderSites()).rejects.toThrow(/Provider changed/);

    api.listProviderSites
      .mockResolvedValueOnce({ providerId: "p1", sites: [], nextCursor: "c" })
      .mockResolvedValueOnce({ providerId: "p1", sites: [], nextCursor: "c" });
    await expect(fetchProviderSites()).rejects.toThrow(/Repeated/);

    api.listProviderSites.mockResolvedValueOnce({ providerId: "p1" });
    await expect(fetchProviderSites()).rejects.toThrow(/Invalid/);
  });
});
