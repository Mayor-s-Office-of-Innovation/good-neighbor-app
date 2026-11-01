import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const setup = vi.hoisted(() => ({
  currentRoute: vi.fn(() => "/today"),
  backOrNavigate: vi.fn(),
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
  isStandalone: vi.fn(() => false),
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
  onHealthChange: vi.fn(() => () => {}),
  clearAuthState: setup.clearAuthState,
  startHealthMonitoring: vi.fn(),
  stopHealthMonitoring: vi.fn(),
}));
vi.mock("../services/device-location.js", () => ({
  requestLocationPermissionEarly: vi.fn(),
}));
vi.mock("../router.js", () => ({
  currentRoute: setup.currentRoute,
  navigate: vi.fn(),
  backOrNavigate: setup.backOrNavigate,
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
  isStandalone: setup.isStandalone,
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

vi.mock("./perimeter-check.js", () => ({ screen: "perimeter-check" }));
vi.mock("./problem-report.js", () => ({ screen: "problem-report" }));
vi.mock("./describe-instead.js", () => ({ screen: "describe-instead" }));

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
  setup.isStandalone.mockReset().mockReturnValue(false);
  setup.currentRoute.mockReset().mockReturnValue("/today");
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

  it("finishes install preparation before showing a newly enrolled app", async () => {
    setup.getSite.mockResolvedValue({
      siteId: "site-1",
      name: "Site",
      token: "access",
    });
    setup.getSiteSettings.mockResolvedValue({
      site: { siteId: "site-1", name: "Site" },
    });
    setup.saveSiteSettings.mockResolvedValue({
      siteId: "site-1",
      name: "Site",
      token: "access",
    });
    const pending = deferred();
    setup.ensureHandoffManifest.mockReturnValue(pending.promise);
    const root = component();
    const entering = root._enterAppAfterBind();
    await flush();
    expect(setup.ensureHandoffManifest).toHaveBeenCalledOnce();
    expect(root._renderApp).not.toHaveBeenCalled();
    pending.resolve(true);
    expect(await entering).toBe(true);
    expect(root._renderApp).toHaveBeenCalledOnce();
  });

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

  it("restores a cookie-only Home Screen launch without manifest credentials", async () => {
    vi.stubGlobal("location", new URL("http://localhost:5173/"));
    setup.isStandalone.mockReturnValue(true);
    setup.getSite
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ siteId: "site-1", name: "Site" });
    setup.redeemHandoffGrant.mockResolvedValue(session);
    setup.getSiteSettings.mockResolvedValue({
      site: { siteId: "site-1", name: "Site" },
    });
    setup.saveSiteSettings.mockResolvedValue({
      siteId: "site-1",
      name: "Site",
    });
    const root = component();
    await root.connectedCallback();
    expect(setup.redeemHandoffGrant).toHaveBeenCalledWith(undefined, undefined);
    expect(root._renderApp).toHaveBeenCalledOnce();
    expect(root._renderSetup).not.toHaveBeenCalled();
    expect(setup.rememberConsumedGrant).not.toHaveBeenCalled();
  });

  it("keeps a valid session when a returning bookmark contains the generic login flag", async () => {
    vi.stubGlobal("location", new URL("http://localhost:5173/#login=1"));
    setup.getSite.mockResolvedValue({ siteId: "site-1", token: "cached" });
    setup.getSiteSettings.mockReturnValue(new Promise(() => {}));
    const root = component();
    await root.connectedCallback();
    expect(root._renderApp).toHaveBeenCalledOnce();
    expect(root._renderSetup).not.toHaveBeenCalled();
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

it("shows recovery controls when a route module fails instead of leaving a blank page", async () => {
  const root = new AppRoot();
  const handlers = {};
  root._view = {
    innerHTML: "",
    querySelector: (selector) => ({
      addEventListener: (_, fn) => {
        handlers[selector] = fn;
      },
    }),
  };
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  root._loadRoute("/today", () => Promise.reject(new Error("chunk missing")));
  expect(root._view.inert).toBe(true);
  expect(root._view.innerHTML).toContain('role="status"');
  await flush();
  expect(root._view.innerHTML).toContain('role="alert"');
  expect(root._view.innerHTML).toContain(
    'class="app-route-load-error__actions"',
  );
  expect(root._view.innerHTML).toContain(
    'class="btn-outline btn-outline--sm" data-route-back',
  );
  expect(root._view.inert).toBe(false);
  expect(handlers["[data-route-reload]"]).toBeTypeOf("function");
  expect(handlers["[data-route-back]"]).toBeTypeOf("function");
  handlers["[data-route-back]"]();
  expect(setup.backOrNavigate).toHaveBeenCalledWith("/today");
  log.mockRestore();
});

it.each([
  ["/check", "perimeter-check"],
  ["/problem", "problem-report"],
  ["/check/describe", "describe-instead"],
  ["/problem/describe", "describe-instead"],
])(
  "loads the capture screen for a direct visit to %s",
  async (route, screen) => {
    setup.currentRoute.mockReturnValue(route);
    const root = component();
    root._loadRoute = vi.fn();
    AppRoot.prototype._renderView.call(root);
    expect(root._loadRoute).toHaveBeenCalledOnce();
    const [requestedRoute, load] = root._loadRoute.mock.calls[0];
    expect(requestedRoute).toBe(route);
    expect((await load()).screen).toBe(screen);
  },
);

it("does not render a capture screen after navigation changes during loading", async () => {
  setup.currentRoute.mockReturnValue("/check");
  const root = component();
  root._view = { innerHTML: "" };
  const pending = deferred();
  root._loadRoute("/check", () => pending.promise);
  setup.currentRoute.mockReturnValue("/today");
  pending.resolve(undefined);
  await flush();
  expect(root._renderView).not.toHaveBeenCalled();
});

it("keeps the old view inert when a superseded import fails", async () => {
  const root = component();
  root._view = { innerHTML: "previous screen", firstElementChild: {} };
  const old = deferred();
  const latest = deferred();
  root._loadRoute("/today", () => old.promise);
  expect(root._view.innerHTML).toBe("previous screen");
  expect(root._view.inert).toBe(true);
  root._loadRoute("/today", () => latest.promise);
  old.reject(new Error("superseded"));
  await flush();
  expect(root._view.inert).toBe(true);
  latest.resolve(undefined);
  await flush();
  expect(root._renderView).toHaveBeenCalledOnce();
});

describe("keyboard viewport style updates", () => {
  function style() {
    const values = new Map();
    return {
      getPropertyValue: (name) => values.get(name) || "",
      setProperty: vi.fn((name, value) => values.set(name, value)),
      removeProperty: vi.fn((name) => values.delete(name)),
    };
  }

  async function shell() {
    const keyboard = await import("../services/keyboard-viewport.js");
    const root = {
      style: style(),
      open: false,
      hasAttribute: () => root.open,
      toggleAttribute: vi.fn((_, open) => {
        root.open = open;
      }),
    };
    vi.stubGlobal("document", { documentElement: root });
    vi.stubGlobal("window", {
      innerHeight: 844,
      visualViewport: { height: 500, offsetTop: 90, scale: 1 },
    });
    vi.stubGlobal("requestAnimationFrame", vi.fn());
    const view = {
      style: style(),
      _applyKeyboardViewport: AppRoot.prototype._applyKeyboardViewport,
    };
    const sync = () => AppRoot.prototype._syncKeyboardViewport.call(view);
    return { keyboard, root, view, sync };
  }

  it("does not mutate viewport styles or attributes during ordinary scrolling", async () => {
    const { keyboard, root, view, sync } = await shell();
    vi.mocked(keyboard.isEditable).mockReturnValue(false);
    vi.mocked(keyboard.keyboardViewport).mockReturnValue(null);
    sync();
    sync();
    for (const target of [root.style, view.style]) {
      expect(target.setProperty).not.toHaveBeenCalled();
      expect(target.removeProperty).not.toHaveBeenCalled();
    }
    expect(root.toggleAttribute).not.toHaveBeenCalled();
  });

  it("updates changed keyboard values, follows closing pan after blur, and clears once", async () => {
    const { keyboard, root, view, sync } = await shell();
    vi.mocked(keyboard.isEditable).mockReturnValue(true);
    vi.mocked(keyboard.keyboardViewport).mockReturnValue({
      height: 500,
      top: 90,
    });
    sync();
    sync();
    expect(root.style.setProperty).toHaveBeenCalledTimes(2);
    expect(view.style.setProperty).toHaveBeenCalledTimes(2);
    expect(requestAnimationFrame).toHaveBeenCalledTimes(2);
    vi.mocked(keyboard.isEditable).mockReturnValue(false);
    vi.mocked(keyboard.keyboardViewport).mockReturnValue({
      height: 500,
      top: 60,
    });
    sync();
    expect(root.style.getPropertyValue("--editable-viewport-top")).toBe("60px");
    expect(keyboard.keyboardViewport).toHaveBeenLastCalledWith(
      window.visualViewport,
      844,
      true,
    );
    vi.mocked(keyboard.keyboardViewport).mockReturnValue(null);
    sync();
    sync();
    expect(root.style.removeProperty).toHaveBeenCalledTimes(2);
    expect(view.style.removeProperty).toHaveBeenCalledTimes(2);
    expect(root.toggleAttribute).toHaveBeenCalledTimes(2);
  });

  it("keeps editable viewport sizing when the browser also resizes its layout viewport", async () => {
    const { keyboard, root, view, sync } = await shell();
    vi.mocked(keyboard.isEditable).mockReturnValue(true);
    vi.mocked(keyboard.keyboardViewport).mockReturnValue(null);
    sync();
    expect(root.style.getPropertyValue("--editable-viewport-height")).toBe(
      "500px",
    );
    expect(view.style.setProperty).not.toHaveBeenCalled();
    vi.mocked(keyboard.isEditable).mockReturnValue(false);
    sync();
    expect(root.style.getPropertyValue("--editable-viewport-height")).toBe("");
  });
});
