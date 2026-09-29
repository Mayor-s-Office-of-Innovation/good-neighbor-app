import { beforeEach, describe, expect, it, vi } from "vitest";

const listeners = vi.hoisted(
  () => /** @type {Record<string, (...args: any[]) => any>} */ ({}),
);

const browser = vi.hoisted(() => ({
  location: { pathname: "/today" },
  history: {
    state: null,
    pushState: vi.fn(),
    replaceState: vi.fn(),
    back: vi.fn(),
    go: vi.fn(),
  },
}));

vi.stubGlobal("location", browser.location);
vi.stubGlobal("history", browser.history);
vi.stubGlobal("window", {
  addEventListener: vi.fn((type, listener) => {
    listeners[type] = listener;
  }),
});
vi.stubGlobal("document", { addEventListener: vi.fn() });

const { backOrNavigate, currentRoute, navigate, setPopstateGuard } =
  await import("./router.js");

describe("router history", () => {
  beforeEach(() => {
    browser.location.pathname = "/today";
    browser.history.state = null;
    browser.history.pushState.mockReset();
    browser.history.replaceState.mockReset();
    browser.history.back.mockReset();
    browser.history.go.mockReset();
    browser.history.pushState.mockImplementation((state, _title, route) => {
      browser.history.state = state;
      browser.location.pathname = route;
    });
    browser.history.replaceState.mockImplementation((state, _title, route) => {
      browser.history.state = state;
      browser.location.pathname = route;
    });
  });

  it("marks routes created by in-app navigation", () => {
    navigate("/site-admin");

    expect(browser.history.pushState).toHaveBeenCalledWith(
      { goodNeighborAppNavigation: 1 },
      "",
      "/site-admin",
    );
  });

  it("restores an admin edit route from the current URL", () => {
    browser.location.pathname = "/site-admin/edit/contact";

    expect(currentRoute()).toBe("/site-admin/edit/contact");
  });

  it("returns through history from an in-app admin route", () => {
    browser.history.state = { goodNeighborAppNavigation: 1 };

    backOrNavigate("/today");

    expect(browser.history.back).toHaveBeenCalledOnce();
    expect(browser.history.replaceState).not.toHaveBeenCalled();
  });

  it("uses the parent route when an admin deep link was loaded directly", () => {
    browser.location.pathname = "/site-admin/edit/contact";

    backOrNavigate("/site-admin");

    expect(browser.history.back).not.toHaveBeenCalled();
    expect(browser.history.replaceState).toHaveBeenCalledWith(
      { goodNeighborAppNavigation: 0 },
      "",
      "/site-admin",
    );
  });

  it("restores browser history when a route-leave guard declines Back", async () => {
    navigate("/site-admin/edit/site");
    const removeGuard = setPopstateGuard(() => false);
    browser.history.state = { goodNeighborAppNavigation: 0 };
    browser.location.pathname = "/today";

    await listeners.popstate();

    expect(browser.history.go).toHaveBeenCalledWith(1);
    removeGuard();
  });
});
