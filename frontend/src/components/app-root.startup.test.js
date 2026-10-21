import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const setup = vi.hoisted(() => ({
  clearSite: vi.fn(),
  getSite: vi.fn(),
  getSiteSettings: vi.fn(),
  clearAuthState: vi.fn(),
  saveSiteSettings: vi.fn(),
}));

vi.mock("../db.js", () => ({
  clearSite: setup.clearSite,
  getSite: setup.getSite,
  hasAdminAccess: vi.fn(),
  resetLocalAppState: vi.fn(),
  saveSiteSettings: setup.saveSiteSettings,
}));
vi.mock("../services/api.js", () => ({
  getSiteSettings: setup.getSiteSettings,
}));
vi.mock("../services/backend-health.js", () => ({
  clearAuthState: setup.clearAuthState,
  startHealthMonitoring: vi.fn(),
  stopHealthMonitoring: vi.fn(),
}));
vi.mock("../services/device-location.js", () => ({
  requestLocationPermissionEarly: vi.fn(),
}));
vi.mock("../router.js", () => ({
  currentRoute: () => "/today",
  navigate: vi.fn(),
  onRouteChange: vi.fn(),
}));
vi.mock("./app-root.templates.js", () => ({
  appShell: vi.fn(),
  setupView: vi.fn(),
}));
vi.mock("./connection-status.js", () => ({}));
vi.mock("../services/browser-context.js", () => ({
  isInAppBrowser: () => false,
}));
vi.mock("../services/install-prompt.js", () => ({
  shouldOfferInstall: () => false,
}));
vi.mock("../services/keyboard-viewport.js", () => ({
  deepActiveElement: vi.fn(),
  isEditable: vi.fn(),
  keyboardViewport: vi.fn(),
}));
vi.mock("../state/toasts.js", () => ({
  showQueuedSiteSwitchSuccessToast: vi.fn(),
  showSiteSwitchSuccessToast: vi.fn(),
}));

let AppRoot;

beforeAll(async () => {
  vi.stubGlobal(
    "HTMLElement",
    class {
      addEventListener() {}
      removeEventListener() {}
    },
  );
  vi.stubGlobal("customElements", { define: vi.fn(), get: vi.fn() });
  vi.stubGlobal("document", {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    hidden: false,
  });
  vi.stubGlobal("window", {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  ({ AppRoot } = await import("./app-root.js"));
});

beforeEach(() => {
  setup.clearSite.mockReset().mockResolvedValue(undefined);
  setup.getSite.mockReset();
  setup.getSiteSettings.mockReset();
  setup.clearAuthState.mockReset();
  setup.saveSiteSettings.mockReset();
});

/**
 * A resolvable stand-in for the settings request.
 * @returns {{ promise: Promise<any>, resolve: (value: any) => void, reject: (reason: any) => void }}
 */
function deferred() {
  /** @type {(value: any) => void} */
  let resolve = () => {};
  /** @type {(reason: any) => void} */
  let reject = () => {};
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function component() {
  const root = new AppRoot();
  root._renderSetup = vi.fn();
  root._renderApp = vi.fn();
  root._renderView = vi.fn();
  root._restoreInterruptedCapture = vi.fn().mockResolvedValue(undefined);
  // The stubbed HTMLElement has no DOM: nothing is mounted unless a test
  // says so (the shell title, or a setup screen in progress).
  root.querySelector = vi.fn(() => null);
  return root;
}

describe("app startup authentication", () => {
  it("processes an enrollment link before a cached binding", async () => {
    vi.stubGlobal(
      "location",
      new URL(
        "http://localhost:5173/#enrollment_grant=new-grant&enrollment_token=new-token",
      ),
    );
    setup.getSite.mockResolvedValue({ siteId: "cached-site" });
    const root = component();

    await root.connectedCallback();

    expect(root._renderSetup).toHaveBeenCalledOnce();
    expect(setup.getSiteSettings).not.toHaveBeenCalled();
    expect(root._renderApp).not.toHaveBeenCalled();
  });

  it("renders the app shell from the cached binding without waiting for the settings refresh", async () => {
    vi.stubGlobal("location", new URL("http://localhost:5173/"));
    setup.getSite.mockResolvedValue({ siteId: "cached-site", name: "Cached" });
    // A refresh that never answers must not hold the first paint hostage.
    setup.getSiteSettings.mockReturnValue(new Promise(() => {}));
    const root = component();

    await root.connectedCallback();

    expect(setup.getSiteSettings).toHaveBeenCalledOnce();
    expect(root._renderApp).toHaveBeenCalledOnce();
    expect(root._renderView).toHaveBeenCalledOnce();
    expect(root._renderSetup).not.toHaveBeenCalled();
  });

  it("tears the app shell down when the cached binding turns out to be revoked", async () => {
    vi.stubGlobal("location", new URL("http://localhost:5173/"));
    const binding = { siteId: "revoked-site", token: "t1" };
    setup.getSite.mockResolvedValue(binding);
    setup.getSiteSettings.mockRejectedValue(
      Object.assign(new Error("reauth"), { name: "ReauthRequiredError" }),
    );
    const root = component();

    await root.connectedCallback();
    // The shell paints first; the revocation lands behind it.
    expect(root._renderApp).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(root._renderSetup).toHaveBeenCalledOnce());

    expect(setup.clearSite).toHaveBeenCalledOnce();
    expect(setup.clearAuthState).toHaveBeenCalledOnce();
    expect(root._site).toBeNull();
  });

  it("keeps a newer session when the startup refresh fails with a superseded token", async () => {
    vi.stubGlobal("location", new URL("http://localhost:5173/"));
    setup.getSite
      .mockResolvedValueOnce({ siteId: "site-1", token: "t1" })
      // By the time the verdict lands, a rotation has stored a newer token.
      .mockResolvedValue({ siteId: "site-1", token: "t2" });
    setup.getSiteSettings.mockRejectedValue(
      Object.assign(new Error("401"), { status: 401 }),
    );
    const root = component();

    await root.connectedCallback();
    await flush();

    expect(setup.clearSite).not.toHaveBeenCalled();
    expect(root._renderSetup).not.toHaveBeenCalled();
    expect(root._site).toEqual({ siteId: "site-1", token: "t1" });
  });

  it("leaves a site setup in progress alone when the old session is rejected", async () => {
    vi.stubGlobal("location", new URL("http://localhost:5173/"));
    setup.getSite.mockResolvedValue({ siteId: "old-site", token: "t1" });
    const pending = deferred();
    setup.getSiteSettings.mockReturnValue(pending.promise);
    const root = component();

    await root.connectedCallback();
    // The user opened setup to bind another site while the request was out.
    root.querySelector = vi.fn((selector) =>
      selector === "site-setup" ? {} : null,
    );
    pending.reject(
      Object.assign(new Error("reauth"), { name: "ReauthRequiredError" }),
    );
    await flush();

    expect(setup.clearSite).not.toHaveBeenCalled();
    expect(root._renderSetup).not.toHaveBeenCalled();
  });

  it("drops a settings answer for a binding that is no longer current", async () => {
    vi.stubGlobal("location", new URL("http://localhost:5173/"));
    setup.getSite.mockResolvedValue({ siteId: "old-site", token: "t1" });
    const pending = deferred();
    setup.getSiteSettings.mockReturnValue(pending.promise);
    const root = component();

    await root.connectedCallback();
    const switched = { siteId: "new-site", token: "t9" };
    root._site = switched;
    pending.resolve({ site: { siteId: "old-site", name: "Old Site" } });
    await flush();

    expect(setup.saveSiteSettings).not.toHaveBeenCalled();
    expect(root._site).toBe(switched);
  });

  it("writes a refreshed site name into the header behind the first paint", async () => {
    vi.stubGlobal("location", new URL("http://localhost:5173/"));
    setup.getSite.mockResolvedValue({
      siteId: "site-1",
      name: "Old",
      token: "t1",
    });
    setup.getSiteSettings.mockResolvedValue({
      site: { siteId: "site-1", name: "New" },
    });
    setup.saveSiteSettings.mockResolvedValue({
      siteId: "site-1",
      name: "New",
      token: "t1",
    });
    const root = component();
    const title = { textContent: "Old" };
    root.querySelector = vi.fn((selector) =>
      selector === ".app__title" ? title : null,
    );

    await root.connectedCallback();
    await flush();

    expect(setup.saveSiteSettings).toHaveBeenCalledWith(
      expect.objectContaining({ name: "New" }),
      "site-1",
    );
    expect(title.textContent).toBe("New");
    expect(root._site.name).toBe("New");
  });
});
