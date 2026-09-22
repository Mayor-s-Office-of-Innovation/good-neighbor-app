import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ current: null }));
const logout = vi.hoisted(() => ({
  clearSiteSession: vi.fn(async () => {}),
  discardInMemorySession: vi.fn(),
}));
vi.mock("../db.js", () => ({
  getSite: async () => ({ siteId: "site-1" }),
  listBoundSites: async () => [],
  clearSiteSession: logout.clearSiteSession,
}));
vi.mock("../services/api.js", () => ({
  listProviderSites: async () => ({ providerName: "Test provider", sites: [] }),
  listChecks: async () => ({ checks: [] }),
  listTasks: async () => ({ tasks: [] }),
}));
vi.mock("../state/check-session.js", () => ({
  getCurrentCheck: () => session.current,
  hasDraft: async () => Boolean(session.current),
  loadSubmitted: async () => null,
  onCheckSessionChange: () => () => {},
  discardInMemorySession: logout.discardInMemorySession,
}));

let TodayView;
beforeAll(async () => {
  vi.stubGlobal(
    "HTMLElement",
    class {
      addEventListener() {}
      removeEventListener() {}
    },
  );
  vi.stubGlobal("window", {
    addEventListener() {},
    clearTimeout() {},
    location: {},
    dispatchEvent: vi.fn(),
  });
  vi.stubGlobal(
    "CustomEvent",
    class {
      constructor(type) {
        this.type = type;
      }
    },
  );
  vi.stubGlobal("document", {
    addEventListener() {},
    removeEventListener() {},
  });
  vi.stubGlobal("customElements", {
    define: (name, component) => {
      if (name === "today-view") TodayView = component;
    },
  });
  await import("./today-view.js");
});
afterEach(() => {
  session.current = null;
  logout.clearSiteSession.mockClear();
  logout.discardInMemorySession.mockClear();
  /** @type {any} */ (window.dispatchEvent).mockClear();
});

async function mount(search) {
  window.location.search = search;
  const view = new TodayView();
  view._renderHome = vi.fn();
  view._hydrateVisibleHomeTasks = vi.fn();
  await view.connectedCallback();
  return view;
}

describe("worklist URL initialization", () => {
  it.each([
    ["todo", "todo"],
    ["in_progress", "in_progress"],
    ["history", "history"],
    ["needs_action", "todo"],
    ["resolved", "history"],
    ["archived", "history"],
  ])(
    "restores %s as %s on remount without reopening or discarding an active draft",
    async (filter, expectedTab) => {
      const draft = {
        id: "draft-1",
        status: "in-progress",
        flowType: "perimeter",
      };
      session.current = draft;
      for (let remount = 0; remount < 2; remount++) {
        const view = await mount(`?filter=${filter}`);
        expect(view._homeFilter).toBe(expectedTab);
        expect(view._viewPhase).toBe("home");
        expect(view._renderHome).toHaveBeenCalledWith(
          expect.objectContaining({ captureSession: null }),
        );
        expect(session.current).toBe(draft);
        view.disconnectedCallback();
      }
    },
  );
  it.each(["", "?filter=unknown"])("defaults safely for %s", async (search) => {
    const view = await mount(search);
    expect(view._homeFilter).toBe("todo");
    view.disconnectedCallback();
  });
  it("still resumes capture when no recognized worklist filter was requested", async () => {
    session.current = {
      id: "draft-1",
      status: "in-progress",
      flowType: "perimeter",
    };
    const view = await mount("?filter=unknown");
    expect(view._viewPhase).toBe("capture");
    view.disconnectedCallback();
  });
});

describe("logout", () => {
  it("restores the confirmation dialog after a home refresh", () => {
    const view = new TodayView();
    const dialog = {
      open: false,
      showModal: vi.fn(function () {
        this.open = true;
      }),
    };
    view._logoutDialogOpen = true;
    view._logoutDialog = dialog;

    view._restoreLogoutDialog();

    expect(dialog.showModal).toHaveBeenCalledOnce();
    expect(dialog.open).toBe(true);
  });

  it("clears the device binding and asks app-root to show setup", async () => {
    const view = new TodayView();

    await view._logout();

    expect(logout.discardInMemorySession).toHaveBeenCalledOnce();
    expect(logout.clearSiteSession).toHaveBeenCalledOnce();
    expect(window.dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "authsignout" }),
    );
  });

  it("keeps the session active and shows a retryable error when cleanup fails", async () => {
    const view = new TodayView();
    view._homeModel = { tasks: [] };
    view._renderHome = vi.fn();
    logout.clearSiteSession.mockRejectedValueOnce(
      new Error("IndexedDB failed"),
    );

    await view._logout();

    expect(logout.discardInMemorySession).not.toHaveBeenCalled();
    expect(window.dispatchEvent).not.toHaveBeenCalled();
    expect(view._logoutPending).toBe(false);
    expect(view._logoutError).toBe(
      "We couldn't log you out. Please try again.",
    );
    expect(view._renderHome).toHaveBeenCalledTimes(2);
  });
});

describe("task card labels", () => {
  it("prefers the user-friendly condition label", () => {
    const view = new TodayView();
    view._cardActions = () => [];

    const card = view._actionCard({
      taskId: "task-1",
      category: "Litter",
      label: "File a 311 ticket",
      userFriendlyLabel: "Lots of trash in tree well",
    });

    expect(card).toContain("Lots of trash in tree well");
    expect(card).not.toContain(">File a 311 ticket</h3>");
  });
});

describe("site switcher", () => {
  it("lists provider sites without add-site or generic login actions", () => {
    const view = new TodayView();
    view._site = { name: "730 Polk" };
    view._siteId = "chc-730-polk";
    view._providerSites = [
      { siteId: "chc-640-jones", name: "640 Jones" },
      { siteId: "chc-730-polk", name: "730 Polk" },
    ];
    view._siteSwitcherOpen = true;

    const menu = view._siteSwitcher("CHC");

    expect(menu).toContain("640 Jones");
    expect(menu).toContain("730 Polk");
    expect(menu).toContain("home-site-switcher__item--selected");
    expect(menu).not.toContain("Add another site");
    expect(menu).not.toContain("Login to another site");
  });
});
