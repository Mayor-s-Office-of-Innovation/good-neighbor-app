import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  method: "ios",
  prepared: false,
  route: "/today",
  heldPrompt: false,
  preparedListeners: new Set(),
  checkListeners: new Set(),
}));
vi.mock("../router.js", () => ({
  currentRoute: () => state.route,
  onRouteChange: () => () => {},
}));
vi.mock("../services/analytics.js", () => ({ trackEvent: vi.fn() }));
vi.mock("../services/install-prompt.js", () => ({
  installMethod: () => state.method,
  hasHeldPrompt: () => state.heldPrompt,
  onInstallAvailable: (fn) => {
    if (state.heldPrompt) fn();
    return () => {};
  },
  onAppInstalled: () => () => {},
  onFirstPerimeterCheckCompleted: (fn) => {
    state.checkListeners.add(fn);
    return () => state.checkListeners.delete(fn);
  },
  dismissInstall: vi.fn(),
  promptInstall: vi.fn(),
}));
vi.mock("../services/session-handoff.js", () => ({
  isHandoffPrepared: () => state.prepared,
  onHandoffPrepared: (fn) => {
    state.preparedListeners.add(fn);
    if (state.prepared) fn();
    return () => state.preparedListeners.delete(fn);
  },
}));

beforeEach(() => {
  state.method = "ios";
  state.prepared = false;
  state.route = "/today";
  state.heldPrompt = false;
  state.preparedListeners.clear();
  state.checkListeners.clear();
  vi.stubGlobal(
    "HTMLElement",
    class {
      innerHTML = "";
      hidden = false;
      querySelector(selector) {
        return selector === ".install-banner" &&
          this.innerHTML.includes("install-banner")
          ? {}
          : null;
      }
    },
  );
  vi.stubGlobal("customElements", { get: vi.fn(), define: vi.fn() });
  vi.stubGlobal("window", {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
});
afterEach(() => vi.unstubAllGlobals());

async function mount() {
  const { InstallPrompt } = await import("./install-prompt.js");
  const banner = new InstallPrompt();
  banner.connectedCallback();
  return banner;
}

it("withholds iOS instructions until the asynchronous handoff is prepared", async () => {
  const banner = await mount();
  expect(banner.hidden).toBe(true);
  expect(banner.innerHTML).toBe("");
  state.prepared = true;
  for (const fn of state.preparedListeners) fn();
  expect(banner.hidden).toBe(false);
  expect(banner.innerHTML).toContain("install-banner");
});

it("shows instructions when handoff preparation finished before mounting", async () => {
  state.prepared = true;
  const banner = await mount();
  expect(banner.hidden).toBe(false);
});

it("leaves the iOS offer hidden if preparation never succeeds", async () => {
  const banner = await mount();
  banner._syncVisibility();
  expect(banner.hidden).toBe(true);
  expect(banner.innerHTML).toBe("");
  banner.disconnectedCallback();
  expect(state.preparedListeners.size).toBe(0);
});

it("keeps the prepared offer off non-home routes", async () => {
  state.prepared = true;
  state.route = "/reports";
  const banner = await mount();
  expect(banner.hidden).toBe(true);
});

it("allows a held Chromium install prompt without an iOS handoff", async () => {
  state.method = "prompt";
  state.heldPrompt = true;
  const banner = await mount();
  expect(banner.hidden).toBe(false);
  expect(banner.innerHTML).toContain("install-banner__install");
});

it("removes the banner on first perimeter completion and cleans up its subscription", async () => {
  state.prepared = true;
  const banner = await mount();
  banner.remove = vi.fn();
  for (const fn of state.checkListeners) fn();
  expect(banner.remove).toHaveBeenCalledTimes(1);
  banner.disconnectedCallback();
  expect(state.checkListeners.size).toBe(0);
});
