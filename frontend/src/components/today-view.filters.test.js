import {
  beforeAll,
  beforeEach,
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const session = vi.hoisted(() => ({ current: null }));
const devicePosition = vi.hoisted(() => ({ current: null, listener: null }));
vi.mock("../services/device-location.js", () => ({
  getSiteCheckDeviceLocation: async () => devicePosition.current,
  getLastDeviceLocation: () => devicePosition.current,
  onDeviceLocationChange: (listener) => {
    devicePosition.listener = listener;
    return () => {
      devicePosition.listener = null;
    };
  },
  refreshGrantedDeviceLocation: async () => null,
}));
const logout = vi.hoisted(() => ({
  clearSiteSession: vi.fn(async () => {}),
  discardInMemorySession: vi.fn(),
}));
const catalog = vi.hoisted(() => ({ listProviderSites: vi.fn() }));
vi.mock("../db.js", () => ({
  getSite: async () => ({ siteId: "site-1" }),
  listBoundSites: async () => [],
  clearSiteSession: logout.clearSiteSession,
}));
vi.mock("../services/api.js", () => ({
  listProviderSites: catalog.listProviderSites,
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
beforeEach(() => {
  catalog.listProviderSites.mockReset();
  catalog.listProviderSites.mockResolvedValue({
    providerId: "provider-1",
    providerName: "Test provider",
    sites: [],
    nextCursor: null,
  });
});
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
  devicePosition.current = null;
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

describe("clear perimeter checks on home", () => {
  it("keeps a just-finished clear check in the newest blue group", async () => {
    const view = await mount("?filter=todo");
    const startedAt = new Date().toISOString();
    const pendingSession = {
      id: "clear-check",
      status: "capture-complete",
      startedAt,
      items: [
        {
          id: "photo-1",
          kind: "photo",
          analysis: { status: "analyzed", tasks: [], conditions: [] },
        },
        {
          id: "photo-2",
          kind: "photo",
          analysis: { status: "analyzed", tasks: [], conditions: [] },
        },
      ],
    };

    const markup = view._render({
      last: null,
      checks: [],
      tasks: [],
      captureSession: null,
      pendingSession,
    });

    expect(markup).toContain("From today&#39;s");
    expect(markup).toContain("analysis-tray--new");
    expect(markup.match(/Your check was clear!/g)).toHaveLength(1);

    const completed = {
      id: pendingSession.id,
      status: "submitted",
      submittedAt: startedAt,
      issueCount: 0,
    };
    const overlapMarkup = view._render({
      last: completed,
      checks: [completed],
      tasks: [],
      captureSession: null,
      pendingSession,
    });
    expect(overlapMarkup.match(/Your check was clear!/g)).toHaveLength(1);
  });

  it("shows the active clear check above every filter and superseded checks in History", async () => {
    const view = await mount("?filter=todo");
    const older = new Date();
    older.setHours(9, 0, 0, 0);
    const newer = new Date();
    newer.setHours(10, 0, 0, 0);
    const checks = [
      {
        id: "newer-clear",
        status: "submitted",
        submittedAt: newer.toISOString(),
        issueCount: 0,
      },
      {
        id: "older-clear",
        status: "submitted",
        submittedAt: older.toISOString(),
        issueCount: 0,
      },
    ];
    const model = {
      last: checks[0],
      checks,
      tasks: [],
      captureSession: null,
      pendingSession: null,
    };

    const todoMarkup = view._render(model);
    expect(todoMarkup).toContain("analysis-tray--new");
    expect(todoMarkup).toContain("From today&#39;s 10:00 AM check");
    expect(todoMarkup).not.toContain("From today&#39;s 9:00 AM check");
    expect(todoMarkup.match(/Your check was clear!/g)).toHaveLength(1);
    expect(todoMarkup.indexOf("analysis-tray--new")).toBeLessThan(
      todoMarkup.indexOf("home-tabs"),
    );

    view._homeFilter = "history";
    const historyMarkup = view._render(model);
    expect(historyMarkup).toContain("analysis-tray--new");
    expect(historyMarkup.indexOf("analysis-tray--new")).toBeLessThan(
      historyMarkup.indexOf("home-tabs"),
    );
    expect(historyMarkup).toContain("analysis-tray--history");
    expect(historyMarkup).toContain("From today&#39;s 9:00 AM check");
    expect(historyMarkup).toContain("From today&#39;s 10:00 AM check");
    expect(historyMarkup.match(/Your check was clear!/g)).toHaveLength(2);
  });

  it("keeps the latest clear check active across days until another check completes", async () => {
    const view = await mount("?filter=todo");
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const check = {
      id: "yesterday-clear",
      status: "submitted",
      submittedAt: yesterday.toISOString(),
      issueCount: 0,
    };
    const model = {
      last: check,
      checks: [check],
      tasks: [],
      captureSession: null,
      pendingSession: null,
    };

    const todoMarkup = view._render(model);
    expect(todoMarkup).toContain("analysis-tray--new");
    expect(todoMarkup).toContain("Your check was clear!");
    view._homeFilter = "history";
    const markup = view._render(model);
    expect(markup).toContain("analysis-tray--new");
    expect(markup).toContain("From yesterday&#39;s");
    expect(markup.match(/Your check was clear!/g)).toHaveLength(1);
  });

  it("moves an active clear check to History after a newer check completes", async () => {
    const view = await mount("?filter=history");
    const older = new Date();
    older.setHours(9, 0, 0, 0);
    const newer = new Date();
    newer.setHours(10, 0, 0, 0);
    const checks = [
      {
        id: "newer-with-issues",
        status: "submitted",
        submittedAt: newer.toISOString(),
        issueCount: 1,
      },
      {
        id: "older-clear",
        status: "submitted",
        submittedAt: older.toISOString(),
        issueCount: 0,
      },
    ];

    const markup = view._render({
      last: checks[0],
      checks,
      tasks: [
        {
          taskId: "task-1",
          checkId: "newer-with-issues",
          createdAt: newer.toISOString(),
          status: "completed",
        },
      ],
      captureSession: null,
      pendingSession: null,
    });

    expect(markup).toContain("analysis-tray--history");
    expect(markup).toContain("From today&#39;s 9:00 AM check");
    expect(markup.indexOf("From today&#39;s 9:00 AM check")).toBeGreaterThan(
      markup.indexOf("home-tabs"),
    );
    expect(markup.match(/Your check was clear!/g)).toHaveLength(1);
  });
});

describe("site location prompt", () => {
  it("checks a fresh position before both capture actions and pauses when off site", async () => {
    const view = await mount("?filter=todo");
    view._site = {
      siteId: "site-1",
      name: "Mission District",
      location: { latitude: 37.7749, longitude: -122.4194 },
    };
    view._siteId = "site-1";
    view._showLocationDialog = vi.fn();
    view._enterCapture = vi.fn();
    devicePosition.current = { latitude: 37.78, longitude: -122.4194 };
    await view._startCapture("perimeter");
    expect(view._showLocationDialog).toHaveBeenCalledOnce();
    expect(view._enterCapture).not.toHaveBeenCalled();
    await view._startCapture("single-problem");
    expect(view._locationPrompt.flowType).toBe("single-problem");
    devicePosition.current = { latitude: 37.7749, longitude: -122.4194 };
    await view._startCapture("perimeter");
    expect(view._enterCapture).toHaveBeenCalledWith("perimeter", null);
  });

  it("logs when a check starts without a usable location and still continues", async () => {
    const view = await mount("?filter=todo");
    view._enterCapture = vi.fn();
    devicePosition.current = null;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await view._startCapture("perimeter");
    expect(warn).toHaveBeenCalledWith(
      "[location] No usable device location when starting a full check; site proximity check skipped.",
    );
    expect(view._enterCapture).toHaveBeenCalledWith("perimeter", null);
    warn.mockRestore();
  });

  it("replaces the last-log summary only when the latest fix is outside the saved site radius", async () => {
    const view = await mount("?filter=todo");
    view._site = {
      siteId: "site-1",
      name: "Mission District",
      location: { latitude: 37.7749, longitude: -122.4194 },
    };
    view._deviceLocation = { latitude: 37.78, longitude: -122.4194 };
    const summary = view._summaryBlock(
      { id: "check-1", submittedAt: new Date().toISOString(), issueCount: 1 },
      [{ task: { checkId: "check-1" }, homeStatus: "needs_action" }],
    );
    expect(summary).toContain("Looks like you're not near this site.");
    expect(summary).toContain('id="lastlog-change-site"');
    expect(summary).toContain('appearance="plain"');
    expect(summary).not.toContain("Last log:");
    view._deviceLocation = null;
    expect(view._summaryBlock(null, [])).toBe("");
  });

  it("lists provider sites and keeps site-change confirmation disabled initially", async () => {
    const view = await mount("?filter=todo");
    view._site = { siteId: "site-1", name: "Mission District" };
    view._providerSites = [
      { siteId: "site-1", name: "Mission District" },
      { siteId: "site-2", name: "Site 2" },
    ];
    const markup = view._locationDialogMarkup();
    expect(markup).toContain("Is your app set to the right location?");
    expect(markup).toContain('<h2 id="location-dialog-title">');
    expect(markup).toContain('aria-labelledby="location-dialog-title"');
    expect(markup).toContain('aria-describedby="location-dialog-copy"');
    expect(markup).toContain("Site 2");
    expect(markup).toMatch(/location-dialog__site"\s+appearance="plain"/);
    expect(markup).toMatch(/location-dialog__confirm"\s+appearance="plain"/);
    expect(markup).toMatch(/location-dialog__stay"\s+appearance="plain"/);
    expect(markup).toMatch(/Confirm site change\s*<\/button>/);
    expect(markup).toMatch(/id="location-confirm"\s+type="button"\s+disabled/);
  });

  it("focuses the selected site when opening the location dialog", async () => {
    const view = await mount("?filter=todo");
    const focus = vi.fn();
    const showModal = vi.fn();
    const querySelector = vi.fn((selector) =>
      selector === '.location-dialog__site[aria-pressed="true"]'
        ? { focus }
        : null,
    );
    view.querySelector = () => ({
      showModal,
      querySelector,
    });

    view._showLocationDialog();

    expect(showModal).toHaveBeenCalledOnce();
    expect(querySelector).toHaveBeenCalledWith(
      '.location-dialog__site[aria-pressed="true"]',
    );
    expect(focus).toHaveBeenCalledOnce();
    expect(showModal.mock.invocationCallOrder[0]).toBeLessThan(
      focus.mock.invocationCallOrder[0],
    );
  });

  it("keeps the location warning mounted through a background location update", async () => {
    const view = await mount("?filter=todo");
    view.isConnected = true;
    const model = { tasks: [] };
    view._homeModel = model;
    view._viewPhase = "home";
    view._locationPrompt = { flowType: "perimeter", launcher: null };
    view._locationSelectedSiteId = view._siteId;
    const render = vi.fn();
    view._render = render;
    view._renderHome = TodayView.prototype._renderHome.bind(view);
    let onClose = () => {};
    const stayButton = { addEventListener: vi.fn() };
    const confirmButton = { addEventListener: vi.fn() };
    const dialog = {
      open: true,
      addEventListener: (event, callback) => {
        if (event === "close") onClose = callback;
      },
      querySelectorAll: () => [],
      querySelector: (selector) =>
        selector === "#location-stay" ? stayButton : confirmButton,
    };
    view.querySelector = () => dialog;
    view._wireLocationDialog();

    devicePosition.listener({ latitude: 37.78, longitude: -122.4194 });
    expect(view._pendingLocationRender).toBe(true);
    expect(render).not.toHaveBeenCalled();
    expect(dialog.open).toBe(true);
    expect(stayButton.addEventListener).toHaveBeenCalledWith(
      "click",
      expect.any(Function),
    );
    expect(confirmButton.addEventListener).toHaveBeenCalledWith(
      "click",
      expect.any(Function),
    );

    view._renderHome = vi.fn();
    onClose();
    expect(view._renderHome).toHaveBeenCalledWith(model);
  });
});

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
  it("uses accessible filter buttons rather than incomplete tab semantics", () => {
    const view = new TodayView();
    view._homeFilter = "todo";
    const markup = view._taskTabs();
    expect(markup).toContain('role="group"');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).not.toContain('role="tab"');
    expect(markup).not.toContain('role="tablist"');
    expect(markup).not.toContain('tabindex="-1"');
  });

  it("collects all provider-site pages and sorts the complete catalog", async () => {
    catalog.listProviderSites
      .mockResolvedValueOnce({
        providerId: "provider-1",
        providerName: "Provider One",
        sites: [{ siteId: "site-z", name: "Zeta" }],
        nextCursor: "next-page",
      })
      .mockResolvedValueOnce({
        providerId: "provider-1",
        providerName: "Provider One",
        sites: [{ siteId: "site-a", name: "Alpha" }],
        nextCursor: null,
      });

    const view = await mount("?filter=todo");
    expect(
      catalog.listProviderSites.mock.calls.map(([cursor]) => cursor),
    ).toEqual(["", "next-page"]);
    expect(view._providerSites.map((site) => site.name)).toEqual([
      "Alpha",
      "Zeta",
    ]);
    expect(view._providerSitesStatus).toBe("loaded");
  });

  it("shows a failed catalog separately from an empty catalog and retries", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    catalog.listProviderSites.mockRejectedValueOnce(new Error("Offline"));
    const view = await mount("?filter=todo");
    view._site = { siteId: "site-1", name: "Mission District" };
    view._siteId = "site-1";
    view._siteSwitcherOpen = true;

    expect(view._providerSitesStatus).toBe("error");
    expect(view._siteSwitcher("Provider One")).toContain(
      'id="site-catalog-retry"',
    );
    expect(view._siteSwitcher("Provider One")).toContain(
      "Other sites couldn't load.",
    );

    catalog.listProviderSites.mockResolvedValueOnce({
      providerId: "provider-1",
      providerName: "Provider One",
      sites: [{ siteId: "site-2", name: "Second site" }],
      nextCursor: null,
    });
    view._homeModel = { tasks: [] };
    await view._retryProviderSites();
    expect(view._providerSitesStatus).toBe("loaded");
    expect(view._providerSites).toEqual([
      { siteId: "site-2", name: "Second site" },
    ]);
    expect(view._siteSwitcher("Provider One")).not.toContain(
      "Other sites couldn't load.",
    );
    errorLog.mockRestore();
  });

  it("stays open when the location-summary link click reaches the outside-click listener", async () => {
    const view = await mount("?filter=todo");
    const originalElement = globalThis.Element;
    class SiteChangeLink {
      matches(selector) {
        return selector.includes("#lastlog-change-site");
      }
    }
    try {
      vi.stubGlobal("Element", SiteChangeLink);
      view._siteSwitcherOpen = true;
      view._siteDocumentClick({ composedPath: () => [new SiteChangeLink()] });
      expect(view._siteSwitcherOpen).toBe(true);

      view._siteDocumentClick({ composedPath: () => [] });
      expect(view._siteSwitcherOpen).toBe(false);
    } finally {
      vi.stubGlobal("Element", originalElement);
    }
  });

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
