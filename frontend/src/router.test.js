import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listeners = vi.hoisted(
  () => /** @type {Record<string, (...args: any[]) => any>} */ ({}),
);

const browser = vi.hoisted(() => ({
  location: { pathname: "/today", search: "", hash: "" },
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

/**
 * Fire a synthetic popstate after applying the history mutation the browser
 * would have performed for `back`/`go` (mock helpers stand in for the engine).
 */
async function pop() {
  await listeners.popstate();
}

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

    await pop();

    expect(browser.history.go).toHaveBeenCalledWith(1);
    removeGuard();
  });
});

describe("router overlays", () => {
  /** @type {string[]} */
  let popped;
  /** @type {() => void} */
  let removeOverlayListener;
  /** @type {Record<string, any>} */
  let router;

  beforeEach(async () => {
    browser.location.pathname = "/today";
    browser.history.state = null;
    browser.history.pushState.mockReset();
    browser.history.replaceState.mockReset();
    browser.history.back.mockReset();
    browser.history.go.mockReset();
    browser.history.pushState.mockImplementation((state, _title, route) => {
      browser.history.state = state;
      if (route) {
        if (route.startsWith("#")) browser.location.hash = route;
        else {
          browser.location.pathname = route;
          browser.location.hash = "";
        }
      }
    });
    browser.history.replaceState.mockImplementation((state, _title, route) => {
      browser.history.state = state;
      if (route && !route.startsWith("#")) {
        browser.location.pathname = route;
        browser.location.hash = "";
      }
    });
    browser.history.back.mockImplementation(() => {
      // Stand-in for the engine: an app-close unwind lands on the prior entry.
      browser.history.state = { goodNeighborAppNavigation: 0 };
      browser.location.pathname = "/today";
      browser.location.hash = "";
    });
    // Fresh module per test: the router keeps overlay state in module scope.
    vi.resetModules();
    router = await import("./router.js");
    popped = [];
    removeOverlayListener = router.onOverlayPop((id) => popped.push(id));
  });

  afterEach(() => {
    removeOverlayListener();
  });

  it("pushes an overlay sentinel with a #dialog hash and keeps the path", () => {
    router.pushOverlay("logout");

    expect(browser.history.pushState).toHaveBeenCalledWith(
      { goodNeighborAppNavigation: 1, goodNeighborOverlay: "logout" },
      "",
      "#logout",
    );
    expect(browser.location.pathname).toBe("/today");
  });

  it("does not push a duplicate sentinel for an already-open id", () => {
    router.pushOverlay("logout");
    router.pushOverlay("logout");

    expect(browser.history.pushState).toHaveBeenCalledOnce();
  });

  it("notifies overlay closers on system back without re-rendering", async () => {
    router.pushOverlay("capture");
    const routeListener = vi.fn();
    const removeRoute = router.onRouteChange(routeListener);
    // Simulate the engine: back lands on the entry beneath the sentinel
    // (depth 0), dropping the hash; popstate catches up.
    browser.history.back.mockImplementationOnce(() => {
      browser.history.state = { goodNeighborAppNavigation: 0 };
      browser.location.pathname = "/today";
      browser.location.hash = "";
    });
    await pop();

    router.closeOverlay("capture");

    expect(popped).toEqual(["capture"]);
    expect(routeListener).not.toHaveBeenCalled();
    removeRoute();
  });

  it("ignores closeOverlay when the id is not on top (system back won it)", () => {
    router.pushOverlay("capture");

    browser.history.state = { goodNeighborAppNavigation: 0 };
    browser.location.pathname = "/today";
    router.closeOverlay("capture");

    expect(browser.history.back).not.toHaveBeenCalled();
  });

  it("re-renders on a popstate that changes the route even with overlays open", async () => {
    router.pushOverlay("capture");
    router.navigate("/check");
    const routeListener = vi.fn();
    const removeRoute = router.onRouteChange(routeListener);
    browser.history.state = { goodNeighborAppNavigation: 0 };
    browser.location.pathname = "/today";

    await pop();

    expect(routeListener).toHaveBeenCalled();
    expect(popped).toEqual([]);
    removeRoute();
  });

  it("strips a stale overlay marker AND #hash left by a refresh mid-dialog", async () => {
    // Fresh module whose load-time strip branch sees the stale state.
    vi.resetModules();
    browser.history.state = {
      goodNeighborAppNavigation: 1,
      goodNeighborOverlay: "logout",
    };
    browser.location.hash = "#logout";
    await import("./router.js");

    expect(browser.history.replaceState).toHaveBeenCalledWith(
      { goodNeighborAppNavigation: 1 },
      "",
      "/today",
    );
    expect(browser.history.state).toEqual({ goodNeighborAppNavigation: 1 });
    expect(browser.location.hash).toBe("");
  });

  it("retires a popped id so a reopen pushes a fresh sentinel (regression)", async () => {
    router.pushOverlay("analysis-edit");

    // System back: sentinel gone from state, popstate delivers, closer runs.
    browser.history.back.mockImplementationOnce(() => {
      browser.history.state = { goodNeighborAppNavigation: 0 };
      browser.location.hash = "";
    });
    await pop();
    expect(popped).toEqual(["analysis-edit"]);

    // Reopen the same id: a NEW sentinel must be pushed (previously the id
    // lingered in overlayDepths and pushOverlay short-circuited).
    router.pushOverlay("analysis-edit");

    expect(browser.history.pushState).toHaveBeenCalledTimes(2);
    expect(browser.history.state).toEqual({
      goodNeighborAppNavigation: 2,
      goodNeighborOverlay: "analysis-edit",
    });
  });

  it("forward back onto a dismissed sentinel is normalized (no stuck step)", async () => {
    router.pushOverlay("attributions");

    // Back: engine swaps to the entry beneath, popstate delivers the close.
    browser.history.back.mockImplementationOnce(() => {
      browser.history.state = { goodNeighborAppNavigation: 0 };
      browser.location.hash = "";
    });
    browser.history.back();
    await pop();
    expect(popped).toEqual(["attributions"]);

    // Forward re-lands ON the old sentinel entry (browser restores its
    // state and hash). Nothing should reopen; the entry is normalized.
    const routeListener = vi.fn();
    const removeRoute = router.onRouteChange(routeListener);
    browser.history.state = {
      goodNeighborAppNavigation: 1,
      goodNeighborOverlay: "attributions",
    };
    browser.location.hash = "#attributions";

    await pop();

    // The first close's emit stays in `popped`; forward must NOT emit.
    expect(popped).toEqual(["attributions"]);
    expect(routeListener).not.toHaveBeenCalled();
    expect(browser.history.replaceState).toHaveBeenCalledWith(
      { goodNeighborAppNavigation: 1 },
      "",
      "/today",
    );
    expect(browser.history.state).toEqual({ goodNeighborAppNavigation: 1 });
    expect(browser.location.hash).toBe("");
    removeRoute();
  });
});
