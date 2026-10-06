import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const setup = vi.hoisted(() => ({
  clearSite: vi.fn(),
  getSite: vi.fn(),
  getSiteSettings: vi.fn(),
  clearAuthState: vi.fn(),
}));

vi.mock("../db.js", () => ({
  clearSite: setup.clearSite,
  getSite: setup.getSite,
  hasAdminAccess: vi.fn(),
  resetLocalAppState: vi.fn(),
  saveSiteSettings: vi.fn(),
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
});

function component() {
  const root = new AppRoot();
  root._renderSetup = vi.fn();
  root._renderApp = vi.fn();
  root._renderView = vi.fn();
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

  it("blocks the app shell when the cached binding is revoked", async () => {
    vi.stubGlobal("location", new URL("http://localhost:5173/"));
    setup.getSite.mockResolvedValue({ siteId: "revoked-site" });
    setup.getSiteSettings.mockRejectedValue(
      Object.assign(new Error("reauth"), { name: "ReauthRequiredError" }),
    );
    const root = component();

    await root.connectedCallback();

    expect(setup.clearSite).toHaveBeenCalledOnce();
    expect(setup.clearAuthState).toHaveBeenCalledOnce();
    expect(root._renderSetup).toHaveBeenCalledOnce();
    expect(root._renderApp).not.toHaveBeenCalled();
  });
});
