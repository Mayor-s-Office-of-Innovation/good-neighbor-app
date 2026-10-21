import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSite: vi.fn(),
  saveSiteSettings: vi.fn(),
  issueSessionHandoff: vi.fn(),
  trackEvent: vi.fn(),
}));
vi.mock("../db.js", () => ({
  getSite: mocks.getSite,
  saveSiteSettings: mocks.saveSiteSettings,
}));
vi.mock("./api.js", () => ({ issueSessionHandoff: mocks.issueSessionHandoff }));
vi.mock("./analytics.js", () => ({ trackEvent: mocks.trackEvent }));
vi.mock("./browser-context.js", () => ({ isInAppBrowser: () => false }));
vi.mock("./install-prompt.js", () => ({
  installMethod: () => "ios",
  isStandalone: () => false,
}));

const {
  buildHandoffManifest,
  ensureHandoffManifest,
  grantIsFresh,
  hasHandoffCredentials,
  installManifest,
  readHandoffCredentials,
  resetHandoffManifest,
  shouldPrepareHandoff,
  stripHandoffCredentials,
} = await import("./session-handoff.js");

const LAUNCH = "https://app.example.org/#handoff_grant=g-1&handoff_token=t-1";

describe("handoff credentials in the launch URL", () => {
  it("parses both parameters from the fragment and nothing else", () => {
    expect(readHandoffCredentials(LAUNCH)).toEqual({
      grantId: "g-1",
      token: "t-1",
    });
    expect(hasHandoffCredentials(LAUNCH)).toBe(true);
    expect(readHandoffCredentials("https://app.example.org/")).toBeNull();
    expect(
      readHandoffCredentials("https://app.example.org/#handoff_grant=g-1"),
    ).toBeNull();
    expect(
      readHandoffCredentials(
        "https://app.example.org/?handoff_grant=g-1&handoff_token=t-1",
      ),
    ).toBeNull();
    expect(readHandoffCredentials("")).toBeNull();
    expect(readHandoffCredentials("not a url")).toBeNull();
  });

  it("strips the credentials from the address bar and keeps the rest of the fragment", () => {
    const replaceState = vi.fn();
    stripHandoffCredentials(
      /** @type {Location} */ ({
        href: "https://app.example.org/today?x=1#handoff_grant=g-1&handoff_token=t-1&other=keep",
      }),
      /** @type {any} */ ({ replaceState }),
    );
    expect(replaceState).toHaveBeenCalledWith(
      null,
      "",
      "/today?x=1#other=keep",
    );
  });

  it("leaves history alone when there is nothing to strip", () => {
    const replaceState = vi.fn();
    stripHandoffCredentials(
      /** @type {Location} */ ({ href: "https://app.example.org/today" }),
      /** @type {any} */ ({ replaceState }),
    );
    expect(replaceState).not.toHaveBeenCalled();
  });
});

describe("shouldPrepareHandoff", () => {
  it("is iOS Safari, not standalone, not a webview, and nothing else", () => {
    expect(
      shouldPrepareHandoff({
        method: "ios",
        standalone: false,
        webview: false,
      }),
    ).toBe(true);
    expect(
      shouldPrepareHandoff({ method: "ios", standalone: true, webview: false }),
    ).toBe(false);
    expect(
      shouldPrepareHandoff({ method: "ios", standalone: false, webview: true }),
    ).toBe(false);
    expect(
      shouldPrepareHandoff({
        method: "prompt",
        standalone: false,
        webview: false,
      }),
    ).toBe(false);
    expect(
      shouldPrepareHandoff({ method: null, standalone: false, webview: false }),
    ).toBe(false);
  });
});

describe("grantIsFresh", () => {
  const now = Date.parse("2026-10-21T12:00:00Z");
  const grant = {
    grantId: "g",
    token: "t",
    startUrl: "/#x",
    expiresAt: "2026-10-28T12:00:00Z",
  };

  it("reuses a grant with more than a day left and re-mints inside the margin", () => {
    expect(grantIsFresh(grant, now)).toBe(true);
    expect(
      grantIsFresh({ ...grant, expiresAt: "2026-10-22T11:00:00Z" }, now),
    ).toBe(false);
    expect(
      grantIsFresh({ ...grant, expiresAt: "2026-10-20T12:00:00Z" }, now),
    ).toBe(false);
  });

  it("rejects incomplete or malformed grants", () => {
    expect(grantIsFresh(undefined, now)).toBe(false);
    expect(grantIsFresh({ ...grant, token: "" }, now)).toBe(false);
    expect(grantIsFresh({ ...grant, expiresAt: "soon" }, now)).toBe(false);
  });
});

describe("buildHandoffManifest", () => {
  it("makes every URL absolute against the page origin and swaps start_url", () => {
    const manifest = buildHandoffManifest(
      {
        id: "/",
        name: "Good Neighbor App",
        start_url: "/",
        scope: "/",
        display: "standalone",
        icons: [{ src: "/img/icon-192.png", sizes: "192x192" }],
      },
      "/#handoff_grant=g-1&handoff_token=t-1",
      "https://app.example.org",
    );
    expect(manifest).toMatchObject({
      id: "https://app.example.org/",
      scope: "https://app.example.org/",
      start_url: "https://app.example.org/#handoff_grant=g-1&handoff_token=t-1",
      display: "standalone",
      name: "Good Neighbor App",
      icons: [
        { src: "https://app.example.org/img/icon-192.png", sizes: "192x192" },
      ],
    });
  });
});

describe("installManifest", () => {
  const urlApi = { createObjectURL: vi.fn(), revokeObjectURL: vi.fn() };

  beforeEach(() => {
    resetHandoffManifest();
    urlApi.createObjectURL
      .mockReset()
      .mockReturnValueOnce("blob:one")
      .mockReturnValueOnce("blob:two");
    urlApi.revokeObjectURL.mockReset();
    vi.stubGlobal("URL", Object.assign(URL, urlApi));
    vi.stubGlobal(
      "Blob",
      class {
        constructor(parts, opts) {
          this.parts = parts;
          this.type = opts?.type;
        }
      },
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("points the existing manifest link at a blob and revokes the previous one", () => {
    const link = { setAttribute: vi.fn() };
    const doc = /** @type {any} */ ({
      querySelector: vi.fn(() => link),
      createElement: vi.fn(),
      head: { append: vi.fn() },
    });
    expect(installManifest({ start_url: "x" }, doc)).toBe("blob:one");
    expect(link.setAttribute).toHaveBeenCalledWith("href", "blob:one");
    expect(doc.createElement).not.toHaveBeenCalled();

    installManifest({ start_url: "y" }, doc);
    expect(urlApi.revokeObjectURL).toHaveBeenCalledWith("blob:one");
    expect(link.setAttribute).toHaveBeenLastCalledWith("href", "blob:two");
  });

  it("creates the link when the page has none", () => {
    const link = { setAttribute: vi.fn() };
    const doc = /** @type {any} */ ({
      querySelector: vi.fn(() => null),
      createElement: vi.fn(() => link),
      head: { append: vi.fn() },
    });
    installManifest({ start_url: "x" }, doc);
    expect(link.setAttribute).toHaveBeenCalledWith("rel", "manifest");
    expect(doc.head.append).toHaveBeenCalledWith(link);
  });
});

describe("ensureHandoffManifest", () => {
  const now = Date.parse("2026-10-21T12:00:00Z");
  const fresh = {
    grantId: "g-cached",
    token: "t-cached",
    expiresAt: "2026-10-28T12:00:00Z",
    startUrl: "/#handoff_grant=g-cached&handoff_token=t-cached",
  };
  const staticManifest = { id: "/", start_url: "/", scope: "/", icons: [] };
  const link = { setAttribute: vi.fn() };

  beforeEach(() => {
    resetHandoffManifest();
    mocks.getSite.mockReset();
    mocks.saveSiteSettings.mockReset();
    mocks.issueSessionHandoff.mockReset();
    mocks.trackEvent.mockReset();
    link.setAttribute.mockReset();
    vi.stubGlobal(
      "URL",
      Object.assign(URL, {
        createObjectURL: vi.fn(() => "blob:m"),
        revokeObjectURL: vi.fn(),
      }),
    );
    vi.stubGlobal(
      "Blob",
      class {
        constructor(parts) {
          this.parts = parts;
        }
      },
    );
    vi.stubGlobal("document", {
      querySelector: () => link,
      createElement: vi.fn(),
      head: { append: vi.fn() },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  const opts = () => ({
    method: /** @type {"ios"} */ ("ios"),
    standalone: false,
    webview: false,
    now,
    origin: "https://app.example.org",
    fetchManifest: () => Promise.resolve(staticManifest),
  });

  it("does nothing off iOS Safari, when standalone, or when unbound", async () => {
    expect(await ensureHandoffManifest({ ...opts(), method: "prompt" })).toBe(
      false,
    );
    expect(await ensureHandoffManifest({ ...opts(), standalone: true })).toBe(
      false,
    );
    mocks.getSite.mockResolvedValue(null);
    expect(await ensureHandoffManifest(opts())).toBe(false);
    mocks.getSite.mockResolvedValue({ siteId: "s1" });
    expect(await ensureHandoffManifest(opts())).toBe(false);
    expect(mocks.issueSessionHandoff).not.toHaveBeenCalled();
  });

  it("reuses a fresh cached grant without a request", async () => {
    mocks.getSite.mockResolvedValue({
      siteId: "s1",
      token: "a",
      handoff: fresh,
    });

    expect(await ensureHandoffManifest(opts())).toBe(true);

    expect(mocks.issueSessionHandoff).not.toHaveBeenCalled();
    expect(mocks.saveSiteSettings).not.toHaveBeenCalled();
    expect(link.setAttribute).toHaveBeenCalledWith("href", "blob:m");
    const blob = /** @type {any} */ (URL.createObjectURL).mock.calls[0][0];
    expect(JSON.parse(blob.parts[0]).start_url).toBe(
      "https://app.example.org/#handoff_grant=g-cached&handoff_token=t-cached",
    );
  });

  it("mints and caches a grant when none is fresh, then installs the manifest", async () => {
    mocks.getSite.mockResolvedValue({
      siteId: "s1",
      token: "a",
      handoff: { ...fresh, expiresAt: "2026-10-21T18:00:00Z" },
    });
    mocks.issueSessionHandoff.mockResolvedValue({
      grantId: "g-new",
      token: "t-new",
      expiresAt: "2026-10-28T12:00:00Z",
      startUrl: "/#handoff_grant=g-new&handoff_token=t-new",
    });
    mocks.saveSiteSettings.mockResolvedValue({ siteId: "s1" });

    expect(await ensureHandoffManifest(opts())).toBe(true);

    expect(mocks.saveSiteSettings).toHaveBeenCalledWith(
      {
        handoff: {
          grantId: "g-new",
          token: "t-new",
          expiresAt: "2026-10-28T12:00:00Z",
          startUrl: "/#handoff_grant=g-new&handoff_token=t-new",
        },
      },
      "s1",
    );
    expect(mocks.trackEvent).toHaveBeenCalledWith("handoff_grant_issued", {});
    const blob = /** @type {any} */ (URL.createObjectURL).mock.calls[0][0];
    expect(JSON.parse(blob.parts[0]).start_url).toContain("g-new");
  });

  it("stops when the binding changed before the grant could be stored", async () => {
    mocks.getSite.mockResolvedValue({ siteId: "s1", token: "a" });
    mocks.issueSessionHandoff.mockResolvedValue({
      grantId: "g",
      token: "t",
      expiresAt: "2026-10-28T12:00:00Z",
      startUrl: "/#handoff_grant=g&handoff_token=t",
    });
    mocks.saveSiteSettings.mockResolvedValue(null);

    expect(await ensureHandoffManifest(opts())).toBe(false);
    expect(link.setAttribute).not.toHaveBeenCalled();
  });

  it("surfaces a failed mint to the caller", async () => {
    mocks.getSite.mockResolvedValue({ siteId: "s1", token: "a" });
    mocks.issueSessionHandoff.mockRejectedValue(new Error("503"));

    await expect(ensureHandoffManifest(opts())).rejects.toThrow("503");
    expect(link.setAttribute).not.toHaveBeenCalled();
  });
});
