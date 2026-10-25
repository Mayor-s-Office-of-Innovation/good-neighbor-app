import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { switchToBoundSite } from "./site-switch.js";

const mocks = vi.hoisted(() => ({
  activateSiteBinding: vi.fn(),
  setSite: vi.fn(),
  selectDeviceBinding: vi.fn(),
  getCurrentCheck: vi.fn(),
  pauseCheck: vi.fn(),
  discardInMemorySession: vi.fn(),
  queueSiteSwitchSuccessToast: vi.fn(),
  showSiteSwitchBlockedToast: vi.fn(),
  showSiteSwitchErrorToast: vi.fn(),
  showSiteSwitchSuccessToast: vi.fn(),
}));
vi.mock("../db.js", () => mocks);
vi.mock("./api.js", () => mocks);
vi.mock("../state/check-session.js", () => mocks);
vi.mock("../state/toasts.js", () => mocks);

const sibling = {
  siteId: "site-2",
  bindingId: "binding-2",
  physicalDeviceId: "physical-1",
};
const session = {
  site: { siteId: "site-2", name: "Second site" },
  bindingId: "binding-2",
  deviceId: "binding-2",
  physicalDeviceId: "physical-1",
  token: "new-access",
  refreshToken: "new-refresh",
  expiresIn: 900,
  tokenGeneration: 2,
  accessLevel: "manager",
  absoluteExpiresAt: "2027-10-22T00:00:00Z",
};
const assign = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("window", { location: { assign } });
  mocks.selectDeviceBinding.mockResolvedValue(session);
  mocks.setSite.mockResolvedValue({ siteId: "site-2" });
  mocks.activateSiteBinding.mockResolvedValue({ siteId: "site-2" });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("selects a never-opened sibling binding without stored tokens", async () => {
  expect(
    await switchToBoundSite({
      siteId: "site-2",
      currentSiteId: "site-1",
      boundSites: [sibling],
    }),
  ).toBe("switched");
  expect(mocks.selectDeviceBinding).toHaveBeenCalledWith("binding-2");
  expect(mocks.activateSiteBinding).not.toHaveBeenCalled();
  expect(mocks.setSite).toHaveBeenCalledWith(
    "Second site",
    expect.objectContaining({
      siteId: "site-2",
      bindingId: "binding-2",
      physicalDeviceId: "physical-1",
      token: "new-access",
      refreshToken: "new-refresh",
      accessLevel: "manager",
    }),
  );
  expect(assign).toHaveBeenCalledWith("/today");
});

it("revalidates a previously selected server binding when switching back", async () => {
  await switchToBoundSite({
    siteId: "site-2",
    currentSiteId: "site-1",
    boundSites: [
      { ...sibling, token: "old-access", refreshToken: "old-refresh" },
    ],
    destination: "/reports",
  });
  expect(mocks.selectDeviceBinding).toHaveBeenCalledWith("binding-2");
  expect(mocks.activateSiteBinding).not.toHaveBeenCalled();
  expect(assign).toHaveBeenCalledWith("/reports");
});

it("activates a legacy token-backed session", async () => {
  expect(
    await switchToBoundSite({
      siteId: "site-2",
      currentSiteId: "site-1",
      boundSites: [
        { siteId: "site-2", token: "access", refreshToken: "refresh" },
      ],
    }),
  ).toBe("switched");
  expect(mocks.activateSiteBinding).toHaveBeenCalledWith("site-2");
  expect(mocks.selectDeviceBinding).not.toHaveBeenCalled();
});

it.each([
  { boundSites: [] },
  { boundSites: [{ siteId: "site-2" }] },
  { boundSites: [{ siteId: "site-2", bindingId: "incomplete" }] },
  { boundSites: [{ siteId: "site-2", token: "access" }] },
  { boundSites: [{ ...sibling, siteId: "site-3" }] },
])(
  "requires enrollment for a target without a usable binding: %j",
  async ({ boundSites }) => {
    expect(
      await switchToBoundSite({
        siteId: "site-2",
        currentSiteId: "site-1",
        boundSites,
      }),
    ).toBe("needs-binding");
    expect(mocks.selectDeviceBinding).not.toHaveBeenCalled();
    expect(mocks.activateSiteBinding).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  },
);

it("keeps the current session when the server rejects a revoked binding", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.selectDeviceBinding.mockRejectedValue(new Error("binding_not_found"));
  expect(
    await switchToBoundSite({
      siteId: "site-2",
      currentSiteId: "site-1",
      boundSites: [sibling],
    }),
  ).toBe("failed");
  expect(mocks.showSiteSwitchErrorToast).toHaveBeenCalledOnce();
  expect(mocks.setSite).not.toHaveBeenCalled();
  expect(mocks.activateSiteBinding).not.toHaveBeenCalled();
  expect(mocks.discardInMemorySession).not.toHaveBeenCalled();
  expect(assign).not.toHaveBeenCalled();
});

it("blocks switching when a captured check is awaiting submission", async () => {
  mocks.getCurrentCheck.mockReturnValue({ status: "capture-complete" });
  expect(
    await switchToBoundSite({
      siteId: "site-2",
      currentSiteId: "site-1",
      boundSites: [sibling],
    }),
  ).toBe("blocked");
  expect(mocks.showSiteSwitchBlockedToast).toHaveBeenCalledOnce();
  expect(mocks.selectDeviceBinding).not.toHaveBeenCalled();
});
