import { buildHandoffManifest, installManifest } from "./handoff-manifest.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSite: vi.fn(),
  saveSiteSettings: vi.fn(),
  issueSessionHandoff: vi.fn(),
  retireSessionHandoff: vi.fn(),
  trackEvent: vi.fn(),
  installMethod: vi.fn(() => "ios"),
  isStandalone: vi.fn(() => false),
  isInAppBrowser: vi.fn(() => false),
}));
vi.mock("../db.js", () => ({
  getSite: mocks.getSite,
  saveSiteSettings: mocks.saveSiteSettings,
}));
vi.mock("./api.js", () => ({
  issueSessionHandoff: mocks.issueSessionHandoff,
  retireSessionHandoff: mocks.retireSessionHandoff,
}));
vi.mock("./analytics.js", () => ({ trackEvent: mocks.trackEvent }));
vi.mock("./browser-context.js", () => ({
  isInAppBrowser: mocks.isInAppBrowser,
}));
vi.mock("./install-prompt.js", () => ({
  installMethod: mocks.installMethod,
  isStandalone: mocks.isStandalone,
}));

const {
  consumedGrantIds,
  ensureHandoffManifest,
  grantIsFresh,
  isHandoffPrepared,
  onHandoffPrepared,
  readHandoffCredentials,
  rememberConsumedGrant,
  resetHandoffManifest,
  retireHandoff,
  shouldPrepareHandoff,
  stripHandoffCredentials,
  uninstallHandoffManifest,
} = await import("./session-handoff.js");

const LAUNCH = "https://app.example.org/#handoff_grant=g-1&handoff_token=t-1";

/** @returns {Storage} an in-memory localStorage stand-in */
function memoryStorage() {
  /** @type {Map<string, string>} */
  const map = new Map();
  return /** @type {any} */ ({
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  });
}

describe("handoff credentials in the launch URL", () => {
  it("parses both parameters from the fragment and nothing else", () => {
    const storage = memoryStorage();
    expect(readHandoffCredentials(LAUNCH, storage)).toEqual({
      grantId: "g-1",
      token: "t-1",
    });
    expect(
      readHandoffCredentials("https://app.example.org/", storage),
    ).toBeNull();
    expect(
      readHandoffCredentials(
        "https://app.example.org/#handoff_grant=g-1",
        storage,
      ),
    ).toBeNull();
    expect(
      readHandoffCredentials(
        "https://app.example.org/?handoff_grant=g-1&handoff_token=t-1",
        storage,
      ),
    ).toBeNull();
    expect(readHandoffCredentials("", storage)).toBeNull();
    expect(readHandoffCredentials("not a url", storage)).toBeNull();
  });

  it("never yields a grant this install already presented", () => {
    const storage = memoryStorage();
    rememberConsumedGrant("g-1", storage);
    expect(consumedGrantIds(storage)).toEqual(["g-1"]);
    expect(readHandoffCredentials(LAUNCH, storage)).toBeNull();
    // Other grants are unaffected, and the memory is bounded.
    for (let i = 0; i < 20; i += 1)
      rememberConsumedGrant(`g-${i + 10}`, storage);
    expect(consumedGrantIds(storage).length).toBeLessThanOrEqual(8);
    expect(
      readHandoffCredentials(
        "https://app.example.org/#handoff_grant=g-2&handoff_token=t-2",
        storage,
      ),
    ).toEqual({ grantId: "g-2", token: "t-2" });
  });

  it("survives blocked or corrupt storage", () => {
    const broken = /** @type {any} */ ({
      getItem: () => "{not json",
      setItem: () => {
        throw new Error("quota");
      },
    });
    expect(consumedGrantIds(broken)).toEqual([]);
    expect(() => rememberConsumedGrant("g-1", broken)).not.toThrow();
    expect(readHandoffCredentials(LAUNCH, broken)).toEqual({
      grantId: "g-1",
      token: "t-1",
    });
    expect(readHandoffCredentials(LAUNCH, null)).toEqual({
      grantId: "g-1",
      token: "t-1",
    });
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
    expect(grantIsFresh({ ...grant, startUrl: "" }, now)).toBe(false);
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

    installManifest({ start_url: "y" }, doc, "blob:one");
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
  const fresh = {
    grantId: "g-cached",
    expiresAt: "2026-10-28T12:00:00Z",
    startUrl: "/#handoff_grant=g-cached&handoff_token=t-cached",
  };
  const staticManifest = { id: "/", start_url: "/", scope: "/", icons: [] };
  const link = { setAttribute: vi.fn() };
  const fetch = vi.fn();

  beforeEach(() => {
    resetHandoffManifest();
    vi.useFakeTimers({ now: Date.parse("2026-10-21T12:00:00Z") });
    mocks.getSite.mockReset();
    mocks.saveSiteSettings.mockReset().mockResolvedValue({ siteId: "s1" });
    mocks.issueSessionHandoff
      .mockReset()
      .mockResolvedValue({ ...fresh, token: "t-cached" });
    mocks.trackEvent.mockReset();
    vi.stubGlobal("navigator", {});
    mocks.installMethod.mockReturnValue("ios");
    mocks.isStandalone.mockReturnValue(false);
    mocks.isInAppBrowser.mockReturnValue(false);
    link.setAttribute.mockReset();
    fetch.mockReset().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(staticManifest),
    });
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("location", { origin: "https://app.example.org" });
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
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const installedStartUrl = () =>
    JSON.parse(
      /** @type {any} */ (URL.createObjectURL).mock.calls[0][0].parts[0],
    ).start_url;

  it("shares preparation and does not mint again when the shell has an older snapshot", async () => {
    const site = { siteId: "s1", deviceId: "d1", token: "a" };
    const first = ensureHandoffManifest({ site });
    const second = ensureHandoffManifest({ site });
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(await ensureHandoffManifest({ site })).toBe(true);
    expect(mocks.issueSessionHandoff).toHaveBeenCalledOnce();
    expect(link.setAttribute).toHaveBeenCalledOnce();
  });

  it("re-reads another tab's cached grant under the origin-wide preparation lock", async () => {
    const request = vi.fn(async (_name, work) => work());
    vi.stubGlobal("navigator", { locks: { request } });
    mocks.getSite.mockResolvedValue({
      siteId: "s1",
      deviceId: "d1",
      token: "a",
      handoff: fresh,
    });
    expect(
      await ensureHandoffManifest({
        site: { siteId: "s1", deviceId: "d1", token: "a" },
      }),
    ).toBe(true);
    expect(request).toHaveBeenCalledWith(
      "gnp:handoff:s1:d1",
      expect.any(Function),
    );
    expect(mocks.issueSessionHandoff).toHaveBeenCalledWith(
      {
        grantId: "g-cached",
        token: "t-cached",
      },
      expect.any(AbortSignal),
    );
  });

  it("cancels a stalled mint and retires immediately without waiting for its response", async () => {
    let release = () => {};
    mocks.issueSessionHandoff.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ...fresh, token: "t-cached" });
        }),
    );
    mocks.retireSessionHandoff.mockReset().mockResolvedValue({ retired: true });
    const site = { siteId: "s1", deviceId: "d1", token: "a" };
    const preparing = ensureHandoffManifest({ site });
    const rejected = expect(preparing).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(await retireHandoff({ site })).toBe(true);
    await rejected;
    expect(mocks.retireSessionHandoff).toHaveBeenCalledWith({
      signal: expect.any(AbortSignal),
      endSession: true,
    });
    release();
    await Promise.resolve();
    expect(mocks.saveSiteSettings).not.toHaveBeenCalled();
    expect(isHandoffPrepared()).toBe(false);
    expect(link.setAttribute).not.toHaveBeenCalled();
  });

  it("times out a stalled mint so enrollment can proceed", async () => {
    mocks.issueSessionHandoff.mockReturnValue(new Promise(() => {}));
    const pending = ensureHandoffManifest({
      site: { siteId: "s1", deviceId: "d1", token: "a" },
    });
    const rejected = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    expect(isHandoffPrepared()).toBe(false);
  });

  it("bounds retirement itself when the network never responds", async () => {
    mocks.retireSessionHandoff.mockReturnValue(new Promise(() => {}));
    const pending = retireHandoff({
      site: { siteId: "s1", deviceId: "d1", token: "a" },
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(await pending).toBe(false);
  });

  it("does nothing off iOS Safari, when standalone, or when unbound", async () => {
    mocks.installMethod.mockReturnValue("prompt");
    expect(await ensureHandoffManifest()).toBe(false);
    mocks.installMethod.mockReturnValue("ios");
    mocks.isStandalone.mockReturnValue(true);
    expect(await ensureHandoffManifest()).toBe(false);
    mocks.isStandalone.mockReturnValue(false);
    mocks.getSite.mockResolvedValue(null);
    expect(await ensureHandoffManifest()).toBe(false);
    expect(await ensureHandoffManifest({ site: { siteId: "s1" } })).toBe(false);
    expect(mocks.issueSessionHandoff).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(isHandoffPrepared()).toBe(false);
  });

  it("restores the cached grant cookie before reporting prepared", async () => {
    const prepared = vi.fn();
    onHandoffPrepared(prepared);
    const site = { siteId: "s1", token: "a", handoff: fresh };

    expect(await ensureHandoffManifest({ site })).toBe(true);

    expect(mocks.getSite).not.toHaveBeenCalled();
    expect(mocks.issueSessionHandoff).toHaveBeenCalledWith(
      {
        grantId: "g-cached",
        token: "t-cached",
      },
      expect.any(AbortSignal),
    );
    expect(mocks.saveSiteSettings).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith("/manifest.webmanifest", {
      signal: expect.any(AbortSignal),
    });
    expect(link.setAttribute).toHaveBeenCalledWith("href", "blob:m");
    expect(installedStartUrl()).toBe(
      "https://app.example.org/#handoff_grant=g-cached&handoff_token=t-cached",
    );
    expect(prepared).toHaveBeenCalledOnce();
    expect(isHandoffPrepared()).toBe(true);

    // Same grant again (a shell re-render): nothing refetched or reinstalled.
    expect(await ensureHandoffManifest({ site })).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
    expect(link.setAttribute).toHaveBeenCalledOnce();
  });

  it("mints and caches a grant when none is fresh, then installs the manifest", async () => {
    mocks.getSite.mockResolvedValue({
      siteId: "s1",
      deviceId: "d1",
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

    expect(await ensureHandoffManifest()).toBe(true);

    // Only what the next load needs: the token lives inside startUrl. The
    // write is guarded on the device as well as the site, so a re-bind of
    // the same site mid-flight cannot inherit the grant.
    expect(mocks.saveSiteSettings).toHaveBeenCalledWith(
      {
        handoff: {
          grantId: "g-new",
          expiresAt: "2026-10-28T12:00:00Z",
          startUrl: "/#handoff_grant=g-new&handoff_token=t-new",
        },
      },
      "s1",
      "d1",
    );
    expect(mocks.trackEvent).toHaveBeenCalledWith("handoff_grant_issued", {});
    expect(installedStartUrl()).toContain("g-new");
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

    expect(await ensureHandoffManifest()).toBe(false);
    expect(link.setAttribute).not.toHaveBeenCalled();
    expect(isHandoffPrepared()).toBe(false);
  });

  it("surfaces a failed mint to the caller and stays unprepared", async () => {
    mocks.getSite.mockResolvedValue({ siteId: "s1", token: "a" });
    mocks.issueSessionHandoff.mockRejectedValue(new Error("503"));

    await expect(ensureHandoffManifest()).rejects.toThrow("503");
    expect(link.setAttribute).not.toHaveBeenCalled();
    expect(isHandoffPrepared()).toBe(false);
  });

  it("puts the static manifest back on uninstall and forgets the grant", async () => {
    const site = { siteId: "s1", token: "a", handoff: fresh };
    expect(await ensureHandoffManifest({ site })).toBe(true);
    expect(isHandoffPrepared()).toBe(true);

    uninstallHandoffManifest();

    expect(link.setAttribute).toHaveBeenLastCalledWith(
      "href",
      "/manifest.webmanifest",
    );
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:m");
    expect(isHandoffPrepared()).toBe(false);
    // Idempotent, and safe without a DOM.
    uninstallHandoffManifest();
    uninstallHandoffManifest(undefined);
    expect(link.setAttribute).toHaveBeenCalledTimes(2);
    // The next shell render reinstalls rather than short-circuiting.
    expect(await ensureHandoffManifest({ site })).toBe(true);
    expect(link.setAttribute).toHaveBeenCalledTimes(3);
  });

  it("retires the grant server-side and locally on sign-out", async () => {
    mocks.retireSessionHandoff.mockReset().mockResolvedValue({ retired: true });
    const site = { siteId: "s1", token: "a", handoff: fresh };
    await ensureHandoffManifest({ site });

    expect(await retireHandoff({ site })).toBe(true);

    expect(mocks.retireSessionHandoff).toHaveBeenCalledOnce();
    expect(isHandoffPrepared()).toBe(false);
    expect(link.setAttribute).toHaveBeenLastCalledWith(
      "href",
      "/manifest.webmanifest",
    );
  });

  it("skips the server when there is nothing to retire or the session is dead, and never throws", async () => {
    mocks.retireSessionHandoff.mockReset().mockResolvedValue({ retired: true });
    // Retire even without a locally cached grant: a mint may have just completed.
    expect(await retireHandoff({ site: { siteId: "s1", token: "a" } })).toBe(
      true,
    );
    expect(mocks.retireSessionHandoff).toHaveBeenCalledOnce();
    mocks.retireSessionHandoff.mockClear();
    expect(await retireHandoff({ site: null })).toBe(false);
    expect(
      await retireHandoff({
        site: { siteId: "s1", token: "a", handoff: fresh },
        remote: false,
      }),
    ).toBe(false);
    expect(mocks.retireSessionHandoff).not.toHaveBeenCalled();

    mocks.retireSessionHandoff.mockRejectedValue(new Error("offline"));
    expect(
      await retireHandoff({
        site: { siteId: "s1", token: "a", handoff: fresh },
      }),
    ).toBe(false);
    expect(mocks.retireSessionHandoff).toHaveBeenCalledOnce();
  });
});
