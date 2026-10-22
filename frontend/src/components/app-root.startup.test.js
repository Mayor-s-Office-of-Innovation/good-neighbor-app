import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const setup = vi.hoisted(() => ({
  clearSite: vi.fn(),
  getSite: vi.fn(),
  getSiteSettings: vi.fn(),
  clearAuthState: vi.fn(),
  saveSiteSettings: vi.fn(),
  setSite: vi.fn(),
  saveDiscoveredBindings: vi.fn(),
  listDeviceBindings: vi.fn(),
  redeemHandoffGrant: vi.fn(),
  stripHandoffCredentials: vi.fn(),
  rememberConsumedGrant: vi.fn(),
  ensureHandoffManifest: vi.fn(),
}));

vi.mock("../db.js", () => ({
  bindingFromSession: (session) => ({
    siteId: session.site?.siteId,
    deviceId: session.deviceId,
    token: session.token,
    refreshToken: session.refreshToken,
    tokenGeneration: session.tokenGeneration,
  }),
  clearSite: setup.clearSite,
  getSite: setup.getSite,
  hasAdminAccess: vi.fn(),
  resetLocalAppState: vi.fn(),
  saveDiscoveredBindings: setup.saveDiscoveredBindings,
  saveSiteSettings: setup.saveSiteSettings,
  setSite: setup.setSite,
}));
vi.mock("../services/api.js", () => ({
  getSiteSettings: setup.getSiteSettings,
  listDeviceBindings: setup.listDeviceBindings,
}));
vi.mock("../services/devices.js", () => ({
  redeemHandoffGrant: setup.redeemHandoffGrant,
}));
vi.mock("../services/session-handoff.js", () => ({
  // The real parser is one URLSearchParams read; keep it so the tests drive
  // the boot through a genuine launch URL.
  readHandoffCredentials: () => {
    const fragment = new URLSearchParams(
      new URL(globalThis.location.href).hash.slice(1),
    );
    const grantId = fragment.get("handoff_grant") || "";
    const token = fragment.get("handoff_token") || "";
    return grantId && token ? { grantId, token } : null;
  },
  stripHandoffCredentials: setup.stripHandoffCredentials,
  rememberConsumedGrant: setup.rememberConsumedGrant,
  ensureHandoffManifest: setup.ensureHandoffManifest,
  uninstallHandoffManifest: vi.fn(),
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
  handoffView: vi.fn(),
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
  setup.setSite.mockReset().mockResolvedValue(undefined);
  setup.saveDiscoveredBindings.mockReset().mockResolvedValue(undefined);
  setup.listDeviceBindings.mockReset();
  setup.redeemHandoffGrant.mockReset();
  setup.stripHandoffCredentials.mockReset();
  setup.rememberConsumedGrant.mockReset();
  setup.ensureHandoffManifest.mockReset().mockResolvedValue(false);
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
  root._renderHandoff = vi.fn();
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

describe("Home Screen session handoff at startup", () => {
  const LAUNCH = "http://localhost:5173/#handoff_grant=g-1&handoff_token=t-1";
  const session = {
    deviceId: "device-1",
    site: { siteId: "site-1", name: "Mission Street Center" },
    token: "access-1",
    refreshToken: "refresh-1",
    expiresIn: 900,
    refreshExpiresIn: 2592000,
    tokenGeneration: 2,
    accessLevel: "general",
  };

  it("strips the credentials before anything else and ignores a stale grant when a session exists", async () => {
    vi.stubGlobal("location", new URL(LAUNCH));
    setup.getSite.mockResolvedValue({ siteId: "site-1", name: "Cached" });
    setup.getSiteSettings.mockReturnValue(new Promise(() => {}));
    const root = component();

    await root.connectedCallback();

    expect(setup.stripHandoffCredentials).toHaveBeenCalledOnce();
    expect(setup.redeemHandoffGrant).not.toHaveBeenCalled();
    expect(root._renderApp).toHaveBeenCalledOnce();
    expect(root._renderSetup).not.toHaveBeenCalled();
  });

  it("redeems the grant on a first standalone launch and renders the hub", async () => {
    vi.stubGlobal("location", new URL(LAUNCH));
    setup.getSite
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ siteId: "site-1", name: "Mission Street Center" });
    setup.redeemHandoffGrant.mockResolvedValue(session);
    setup.getSiteSettings.mockResolvedValue({
      site: { siteId: "site-1", name: "Mission Street Center" },
    });
    setup.saveSiteSettings.mockResolvedValue({
      siteId: "site-1",
      name: "Mission Street Center",
    });
    const root = component();

    await root.connectedCallback();

    expect(setup.stripHandoffCredentials).toHaveBeenCalledOnce();
    expect(setup.redeemHandoffGrant).toHaveBeenCalledWith("g-1", "t-1");
    expect(setup.setSite).toHaveBeenCalledWith(
      "Mission Street Center",
      expect.objectContaining({
        siteId: "site-1",
        deviceId: "device-1",
        token: "access-1",
        refreshToken: "refresh-1",
        tokenGeneration: 2,
      }),
    );
    // Legacy device: no physical identity, so no bindings refetch.
    expect(setup.listDeviceBindings).not.toHaveBeenCalled();
    expect(root._renderHandoff).toHaveBeenCalledOnce();
    expect(root._renderSetup).not.toHaveBeenCalled();
    expect(setup.rememberConsumedGrant).toHaveBeenCalledWith("g-1");
    expect(root._renderApp).toHaveBeenCalledOnce();
    expect(root._site).toEqual({
      siteId: "site-1",
      name: "Mission Street Center",
    });
  });

  it("ends on the setup screen when the redeemed session is rejected by the settings refresh", async () => {
    vi.stubGlobal("location", new URL(LAUNCH));
    setup.getSite
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ siteId: "site-1", token: "access-1" });
    setup.redeemHandoffGrant.mockResolvedValue(session);
    setup.getSiteSettings.mockRejectedValue(
      Object.assign(new Error("reauth"), { name: "ReauthRequiredError" }),
    );
    const root = component();

    await root.connectedCallback();

    // No <site-setup> is mounted during a handoff, so the rejection is final.
    expect(setup.clearSite).toHaveBeenCalledOnce();
    expect(root._renderSetup).toHaveBeenCalledWith();
    expect(root._renderApp).not.toHaveBeenCalled();
  });

  it("does not remember a grant after a network failure, so the next launch retries", async () => {
    vi.stubGlobal("location", new URL(LAUNCH));
    setup.getSite.mockResolvedValue(null);
    const { ApiError } = await import("../services/api-error.js");
    setup.redeemHandoffGrant.mockRejectedValue(
      new ApiError("offline", { status: 0 }),
    );
    const root = component();

    await root.connectedCallback();

    expect(setup.rememberConsumedGrant).not.toHaveBeenCalled();
    expect(root._renderSetup).toHaveBeenLastCalledWith({
      notice: "handoffFailed",
    });
  });

  it("re-discovers sibling bindings for a binding-backed device", async () => {
    vi.stubGlobal("location", new URL(LAUNCH));
    setup.getSite
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ siteId: "site-1", name: "Mission Street Center" });
    setup.redeemHandoffGrant.mockResolvedValue({
      ...session,
      bindingId: "binding-1",
      physicalDeviceId: "physical-1",
    });
    setup.listDeviceBindings.mockResolvedValue({
      bindings: [{ siteId: "site-2", siteName: "Other", bindingId: "b2" }],
    });
    setup.getSiteSettings.mockResolvedValue({ site: { siteId: "site-1" } });
    setup.saveSiteSettings.mockResolvedValue({ siteId: "site-1" });
    const root = component();

    await root.connectedCallback();

    expect(setup.saveDiscoveredBindings).toHaveBeenCalledWith(
      [{ siteId: "site-2", siteName: "Other", bindingId: "b2" }],
      "physical-1",
    );
    expect(root._renderApp).toHaveBeenCalledOnce();
  });

  it("lands on the setup screen with a notice when the grant is rejected", async () => {
    vi.stubGlobal("location", new URL(LAUNCH));
    setup.getSite.mockResolvedValue(null);
    const { InvalidHandoffGrantError } = await import(
      "../services/api-error.js"
    );
    setup.redeemHandoffGrant.mockRejectedValue(new InvalidHandoffGrantError());
    const root = component();

    await root.connectedCallback();

    expect(setup.stripHandoffCredentials).toHaveBeenCalledOnce();
    expect(setup.setSite).not.toHaveBeenCalled();
    // Rejected for good: the install never presents this grant again.
    expect(setup.rememberConsumedGrant).toHaveBeenCalledWith("g-1");
    expect(root._renderSetup).toHaveBeenLastCalledWith({
      notice: "handoffFailed",
    });
    expect(root._renderApp).not.toHaveBeenCalled();
  });

  it("lets an enrollment link win over handoff credentials", async () => {
    vi.stubGlobal(
      "location",
      new URL(
        "http://localhost:5173/#enrollment_grant=e&enrollment_token=t&handoff_grant=g-1&handoff_token=t-1",
      ),
    );
    setup.getSite.mockResolvedValue(null);
    const root = component();

    await root.connectedCallback();

    expect(setup.redeemHandoffGrant).not.toHaveBeenCalled();
    expect(root._renderSetup).toHaveBeenCalledOnce();
    expect(root._renderSetup).toHaveBeenCalledWith();
  });
});
