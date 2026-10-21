import {
  beforeAll,
  beforeEach,
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { lastLogSummary } from "../domain/home-tasks.js";
import { formatTime } from "../i18n/dates.js";
import { t } from "../i18n/i18n.js";
import { setDuplicateUiSite } from "../services/feature-flags.js";
import { escapeHtml } from "../lib/html.js";

/*
  Frozen clock with Pacific-anchored fixtures. The app renders every check
  time in Pacific (i18n/dates.js), so runner-local setHours() raced between a
  Pacific laptop and a UTC CI runner. Oct 2026 is PDT (-07:00); the instants
  are fixed so labels are deterministic on every machine and every day.
*/
const FROZEN_NOW = new Date("2026-10-02T17:30:00-07:00");
const OLDER_TODAY = new Date("2026-10-02T09:00:00-07:00").toISOString();
const NEWER_TODAY = new Date("2026-10-02T10:00:00-07:00").toISOString();
const YESTERDAY = new Date("2026-10-01T17:30:00-07:00").toISOString();

function freezeClock() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FROZEN_NOW.getTime());
}

/** Same-day check title exactly as a template renders it (escaped). */
const todayTitle = (iso) =>
  escapeHtml(t("analysis.checkTitle.today", { time: formatTime(iso) }));

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
const navigateMock = vi.hoisted(() => vi.fn());
const awaitOverlayUnwindMock = vi.hoisted(() => vi.fn(async () => {}));
const siteRead = vi.hoisted(() => vi.fn(async () => ({ siteId: "site-1" })));
const windowListeners = new Map();
const catalog = vi.hoisted(() => ({
  listProviderSites: vi.fn(),
  listBoundSites: vi.fn(),
  listTasks: vi.fn(),
}));
vi.mock("../db.js", () => ({
  getSite: siteRead,
  hasAdminAccess: () => false,
  listBoundSites: catalog.listBoundSites,
  setSite: vi.fn(async (_name, meta) => ({ ...meta, id: "current" })),
  clearSiteSession: logout.clearSiteSession,
}));
vi.mock("../services/api.js", () => ({
  listProviderSites: catalog.listProviderSites,
  selectDeviceBinding: vi.fn(),
  listChecks: async () => ({ checks: [] }),
  listTasks: catalog.listTasks,
}));
vi.mock("../state/check-session.js", () => ({
  getCurrentCheck: () => session.current,
  hasDraft: async () => Boolean(session.current),
  loadSubmitted: async () => null,
  onCheckSessionChange: () => () => {},
  discardInMemorySession: logout.discardInMemorySession,
}));
vi.mock("../router.js", () => ({
  navigate: navigateMock,
  pushOverlay: vi.fn(),
  closeOverlay: vi.fn(),
  onOverlayPop: () => () => {},
  currentRoute: () => "/today",
}));
vi.mock("../dialog-history.js", () => ({
  awaitOverlayUnwind: awaitOverlayUnwindMock,
  openOverlayDialog: vi.fn((dialog) => {
    if (!dialog.open) dialog.showModal();
  }),
}));

let TodayView;
beforeEach(() => {
  windowListeners.get("authsignout")?.();
  setDuplicateUiSite(null);
  siteRead.mockResolvedValue({ siteId: "site-1" });
  awaitOverlayUnwindMock.mockClear();
  catalog.listBoundSites.mockReset().mockResolvedValue([]);
  catalog.listTasks.mockReset().mockResolvedValue({ tasks: [] });
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
    addEventListener(type, listener) {
      windowListeners.set(type, listener);
    },
    removeEventListener() {},
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
  vi.useRealTimers();
  session.current = null;
  devicePosition.current = null;
  logout.clearSiteSession.mockClear();
  logout.discardInMemorySession.mockClear();
  /** @type {any} */ (window.dispatchEvent).mockClear();
});

async function mount(search) {
  window.location.search = search;
  navigateMock.mockClear();
  const view = new TodayView();
  view._renderHome = vi.fn();
  view._hydrateVisibleHomeTasks = vi.fn();
  await view.connectedCallback();
  // The In-progress / History lists load after the first paint; settle them
  // so tests see the complete worklist state.
  await view._remainingLoad;
  return view;
}

describe("clear perimeter checks on home", () => {
  it("keeps a just-finished clear check in the newest blue group", async () => {
    freezeClock();
    const view = await mount("?filter=todo");
    const startedAt = FROZEN_NOW.toISOString();
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
    freezeClock();
    const view = await mount("?filter=todo");
    const checks = [
      {
        id: "newer-clear",
        status: "submitted",
        submittedAt: NEWER_TODAY,
        issueCount: 0,
      },
      {
        id: "older-clear",
        status: "submitted",
        submittedAt: OLDER_TODAY,
        issueCount: 0,
      },
    ];
    const newerTitle = todayTitle(NEWER_TODAY);
    const olderTitle = todayTitle(OLDER_TODAY);
    const model = {
      last: checks[0],
      checks,
      tasks: [],
      captureSession: null,
      pendingSession: null,
    };

    const todoMarkup = view._render(model);
    expect(todoMarkup).toContain("analysis-tray--new");
    expect(todoMarkup).toContain(newerTitle);
    expect(todoMarkup).not.toContain(olderTitle);
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
    expect(historyMarkup).toContain(olderTitle);
    expect(historyMarkup).toContain(newerTitle);
    expect(historyMarkup.match(/Your check was clear!/g)).toHaveLength(2);
  });

  it("keeps the latest clear check active across days until another check completes", async () => {
    freezeClock();
    const view = await mount("?filter=todo");
    const check = {
      id: "yesterday-clear",
      status: "submitted",
      submittedAt: YESTERDAY,
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
    expect(markup).toContain(
      escapeHtml(
        t("analysis.checkTitle.yesterdayTime", { time: formatTime(YESTERDAY) }),
      ),
    );
    expect(markup.match(/Your check was clear!/g)).toHaveLength(1);
  });

  it("groups newest-check history tasks by the selected date or issue type", async () => {
    freezeClock();
    const view = await mount("?filter=history");
    const check = {
      id: "latest",
      status: "submitted",
      submittedAt: NEWER_TODAY,
      issueCount: 1,
    };
    const model = {
      last: check,
      checks: [check],
      captureSession: null,
      pendingSession: null,
      tasks: [
        {
          taskId: "completed-litter",
          checkId: "latest",
          status: "completed",
          category: "Litter",
          createdAt: YESTERDAY,
          completedAt: NEWER_TODAY,
        },
      ],
    };
    for (const [mode, title] of [
      ["resolved", "Today · Oct 2"],
      ["opened", "Yesterday · Oct 1"],
      ["type", "Litter"],
    ]) {
      view._historyGrouping = mode;
      const markup = view._render(model);
      const headings = [
        ...markup.matchAll(
          /<h2 class="analysis-tray__check-title">\s*([^<]+)<\/h2>/g,
        ),
      ].map((match) => match[1].trim());
      expect(headings).toContain(title);
      expect(markup).not.toContain(todayTitle(NEWER_TODAY));
      expect(markup).toContain("history-card__row");
    }
  });

  it("moves an active clear check to History after a newer check completes", async () => {
    freezeClock();
    const view = await mount("?filter=history");
    const checks = [
      {
        id: "newer-with-issues",
        status: "submitted",
        submittedAt: NEWER_TODAY,
        issueCount: 1,
      },
      {
        id: "older-clear",
        status: "submitted",
        submittedAt: OLDER_TODAY,
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
          createdAt: NEWER_TODAY,
          status: "completed",
        },
      ],
      captureSession: null,
      pendingSession: null,
    });

    expect(markup).toContain("analysis-tray--history");
    expect(markup).toContain(todayTitle(OLDER_TODAY));
    expect(markup.indexOf(todayTitle(OLDER_TODAY))).toBeGreaterThan(
      markup.indexOf("home-tabs"),
    );
    expect(markup.match(/Your check was clear!/g)).toHaveLength(1);
  });

  it.each(["resolved", "opened"])(
    "orders historical clear checks alongside %s day groups",
    async (mode) => {
      const view = await mount("?filter=history");
      view._historyGrouping = mode;
      view._taskCardEntry = () => ({ markup: "task-card" });
      const groups = view._historyGroups(
        [
          {
            task: {
              taskId: "old",
              createdAt: "2026-09-01T12:00:00Z",
              completedAt: "2026-09-02T12:00:00Z",
            },
          },
          {
            task: {
              taskId: "new",
              createdAt: "2026-10-04T12:00:00Z",
              completedAt: "2026-10-05T12:00:00Z",
            },
          },
        ],
        [],
        [
          { startedAt: "2026-09-10T12:00:00Z" },
          {
            submittedAt: "2026-10-02T12:00:00Z",
            startedAt: "2026-08-01T12:00:00Z",
          },
        ],
      );
      expect(groups.map((group) => group.dateKey)).toEqual([
        mode === "opened" ? "2026-10-04" : "2026-10-05",
        "2026-10-02",
        "2026-09-10",
        mode === "opened" ? "2026-09-01" : "2026-09-02",
      ]);
      expect(groups.map((group) => group.compact)).toEqual([
        true,
        false,
        false,
        true,
      ]);
    },
  );

  it("keeps clear checks separate after issue-type groups", async () => {
    const view = await mount("?filter=history");
    view._historyGrouping = "type";
    view._taskCardEntry = () => ({ markup: "task-card" });
    const groups = view._historyGroups(
      [{ task: { category: "Litter" } }, { task: { category: "Graffiti" } }],
      [],
      [{ submittedAt: NEWER_TODAY }],
    );
    expect(groups.map((group) => group.title)).toEqual([
      "Graffiti",
      "Litter",
      "",
    ]);
    expect(groups[2].checkTime).toBe(NEWER_TODAY);
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
    devicePosition.current = { latitude: 37.78, longitude: -122.4194 };
    await view._startCapture("perimeter");
    expect(view._showLocationDialog).toHaveBeenCalledOnce();
    // Paused mid-flight: no navigation until the radius question is settled.
    expect(navigateMock).not.toHaveBeenCalled();
    await view._startCapture("single-problem");
    expect(view._locationPrompt.flowType).toBe("single-problem");
    devicePosition.current = { latitude: 37.7749, longitude: -122.4194 };
    await view._startCapture("perimeter");
    // Routed capture: a successful radius check navigates to the flow's URL.
    expect(navigateMock).toHaveBeenLastCalledWith("/check");
  });

  it("logs when a check starts without a usable location and still continues", async () => {
    const view = await mount("?filter=todo");
    devicePosition.current = null;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await view._startCapture("perimeter");
    expect(warn).toHaveBeenCalledWith(
      "[location] No usable device location when starting a full check; site proximity check skipped.",
    );
    expect(navigateMock).toHaveBeenLastCalledWith("/check");
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
    const last = {
      id: "check-1",
      submittedAt: new Date().toISOString(),
      issueCount: 1,
    };
    const entries = [
      { task: { checkId: "check-1" }, homeStatus: "needs_action" },
    ];
    const summary = view._summaryBlock(last, entries);
    expect(summary).toContain(escapeHtml(t("today.summary.outsideRadius")));
    expect(summary).toContain('id="lastlog-change-site"');
    expect(summary).toContain('appearance="plain"');
    const label = lastLogSummary(last, entries);
    expect(label).not.toBe("");
    expect(summary).not.toContain(escapeHtml(label));
    view._deviceLocation = null;
    expect(view._summaryBlock(null, [])).toBe("");
  });

  it("keeps the location warning mounted through a background location update", async () => {
    const view = await mount("?filter=todo");
    view.isConnected = true;
    const model = { tasks: [] };
    view._homeModel = model;
    view._locationPrompt = { flowType: "perimeter", launcher: null };
    const render = vi.fn();
    view._render = render;
    view._renderHome = TodayView.prototype._renderHome.bind(view);

    devicePosition.listener({ latitude: 37.78, longitude: -122.4194 });
    expect(view._pendingLocationRender).toBe(true);
    expect(render).not.toHaveBeenCalled();

    view._renderHome = vi.fn();
    view._onLocationDialogClosed({ changingSite: false });
    expect(view._locationPrompt).toBeNull();
    expect(view._renderHome).toHaveBeenCalledWith(model);
  });

  it("does not redraw the home behind a site change after the prompt closes", async () => {
    const view = await mount("?filter=todo");
    view._homeModel = { tasks: [] };
    view._locationPrompt = { flowType: "perimeter", launcher: null };
    view._pendingLocationRender = true;
    view._renderHome = vi.fn();
    view._onLocationDialogClosed({ changingSite: true });
    expect(view._renderHome).not.toHaveBeenCalled();
    expect(view._pendingLocationRender).toBe(false);
  });

  it("resumes the waiting capture flow on Stay", async () => {
    devicePosition.current = { latitude: 37.78, longitude: -122.4194 };
    const view = await mount("?filter=todo");
    view._site = {
      siteId: "site-1",
      name: "Mission District",
      location: { latitude: 37.7749, longitude: -122.4194 },
    };
    await view._onLocationStay({
      prompt: { flowType: "single-problem", launcher: null },
    });
    expect(awaitOverlayUnwindMock).toHaveBeenLastCalledWith("location");
    expect(navigateMock).toHaveBeenLastCalledWith("/problem");
    await view._onLocationStay({
      prompt: { flowType: "perimeter", launcher: null },
    });
    expect(navigateMock).toHaveBeenLastCalledWith("/check");
    navigateMock.mockClear();
    await view._onLocationStay({ prompt: null });
    expect(navigateMock).not.toHaveBeenCalled();
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
        expect(view._renderHome).toHaveBeenCalledWith(
          expect.objectContaining({ pendingSession: null }),
        );
        expect(session.current).toBe(draft);
        // Routed capture: home never navigates on its own.
        expect(navigateMock).not.toHaveBeenCalled();
        view.disconnectedCallback();
      }
    },
  );
  it.each(["", "?filter=unknown"])("defaults safely for %s", async (search) => {
    const view = await mount(search);
    expect(view._homeFilter).toBe("todo");
    view.disconnectedCallback();
  });
  it("keeps an in-progress draft off home: no capture re-entry, worklist unchanged", async () => {
    session.current = {
      id: "draft-1",
      status: "in-progress",
      flowType: "perimeter",
    };
    const view = await mount("?filter=unknown");
    expect(navigateMock).not.toHaveBeenCalled();
    view.disconnectedCallback();
  });
});

describe("logout", () => {
  it("restores the confirmation dialog after a home refresh", () => {
    const view = new TodayView();
    const dialog = {
      open: false,
      dataset: {},
      addEventListener: vi.fn(),
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
    expect(view._logoutError).toBe(t("today.logout.error"));
    expect(view._renderHome).toHaveBeenCalledTimes(2);
  });
});

describe("site switcher", () => {
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
    expect(view._providerSites).toEqual([]);

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
    errorLog.mockRestore();
  });

  it("re-reads bindings at switch time when the load-time read failed", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    catalog.listBoundSites.mockRejectedValueOnce(new Error("IndexedDB"));
    const view = await mount("?filter=todo");
    // The worklist still loaded; the bindings are unknown, not empty.
    expect(view._renderHome).toHaveBeenCalled();
    expect(view._boundSites).toBeNull();

    view._siteId = "site-1";
    view._providerSites = [{ siteId: "site-2", name: "Second site" }];
    view._requestAnotherSite = vi.fn();

    // Still failing: no enrollment offer for a site that may well be bound.
    catalog.listBoundSites.mockRejectedValueOnce(new Error("IndexedDB"));
    await view._switchToSite("site-2");
    expect(view._requestAnotherSite).not.toHaveBeenCalled();
    expect(view._boundSites).toBeNull();

    // Recovered: a genuinely unbound site is offered enrollment as before.
    catalog.listBoundSites.mockResolvedValueOnce([]);
    await view._switchToSite("site-2");
    expect(view._boundSites).toEqual([]);
    expect(view._requestAnotherSite).toHaveBeenCalledWith(
      "code",
      "site-2",
      "Second site",
    );
    errorLog.mockRestore();
  });
});

describe("pre-data skeleton", () => {
  it("paints the chrome and placeholder cards before the worklist responds", async () => {
    window.location.search = "?filter=in_progress";
    let release = () => {};
    // The catalog shares the worklist's Promise.all, so holding it holds the
    // whole data tier while the skeleton is on screen.
    catalog.listProviderSites.mockReturnValueOnce(
      new Promise((resolve) => {
        release = () =>
          resolve({ providerId: "provider-1", providerName: "P", sites: [] });
      }),
    );
    const view = new TodayView();
    view._renderHome = vi.fn();
    view._hydrateVisibleHomeTasks = vi.fn();
    const loading = view.connectedCallback();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(view._renderHome).not.toHaveBeenCalled();
    expect(view.innerHTML).toContain("analysis-card--pending");
    expect(view.innerHTML).toContain('aria-busy="true"');
    expect(view.innerHTML).toContain(escapeHtml(t("today.site.fallback")));
    // The requested tab is already selected in the placeholder tab bar.
    expect(view.innerHTML).toMatch(
      /home-tabs__tab--active[^>]*data-home-filter="in_progress"/,
    );
    // The real start button only arrives with the data (e2e sentinel).
    expect(view.innerHTML).not.toContain('id="start-check"');

    release();
    await loading;
    expect(view._renderHome).toHaveBeenCalledOnce();
  });

  it("does not repaint the skeleton on a refresh that already has a model", async () => {
    const view = await mount("?filter=todo");
    view._homeModel = { tasks: [] };
    view.innerHTML = '<div class="live"></div>';
    await view.connectedCallback();
    expect(view.innerHTML).toBe('<div class="live"></div>');
  });
});

describe("deferred In-progress / History lists", () => {
  const openTask = {
    taskId: "open-1",
    checkId: "c1",
    status: "open",
    category: "Litter",
    severity: 3,
    createdAt: YESTERDAY,
  };
  const doneTask = {
    taskId: "done-1",
    checkId: "c0",
    status: "completed",
    category: "Litter",
    createdAt: YESTERDAY,
    completedAt: NEWER_TODAY,
  };

  /** A view whose render keeps the model, as the real one does. */
  function liveView(search) {
    window.location.search = search;
    const view = new TodayView();
    view.isConnected = true;
    view.querySelector = () => null;
    view.querySelectorAll = () => [];
    view._renderHome = vi.fn((model) => {
      view._homeModel = model;
    });
    view._hydrateVisibleHomeTasks = vi.fn();
    view._hydrate311CardStatuses = vi.fn();
    return view;
  }

  it("paints from the open list alone, then fetches the rest and reveals counts", async () => {
    freezeClock();
    let release = () => {};
    const held = new Promise((resolve) => {
      release = () => resolve({ tasks: [doneTask] });
    });
    catalog.listTasks.mockImplementation(async ({ status }) =>
      status === "open"
        ? { tasks: [openTask] }
        : status === "completed"
          ? held
          : { tasks: [] },
    );
    const view = liveView("?filter=todo");
    await view.connectedCallback();

    const statuses = catalog.listTasks.mock.calls.map(([{ status }]) => status);
    expect(statuses[0]).toBe("open");
    expect(statuses.slice(1).sort()).toEqual(
      ["cannot_do", "completed", "completing", "in_progress"].sort(),
    );
    // The open-only render happened before any other list was requested.
    const firstRender = view._renderHome.mock.invocationCallOrder[0];
    expect(catalog.listTasks.mock.invocationCallOrder[0]).toBeLessThan(
      firstRender,
    );
    expect(catalog.listTasks.mock.invocationCallOrder[1]).toBeGreaterThan(
      firstRender,
    );
    expect(view._homeModel.tasks.map((t) => t.taskId)).toEqual(["open-1"]);

    // Counts stay hidden while the remaining lists are in flight…
    expect(view._render(view._homeModel)).not.toContain("home-tabs__count");
    // …and History shows placeholders, not "no history".
    view._homeFilter = "history";
    const pendingMarkup = view._render(view._homeModel);
    expect(pendingMarkup).toContain("analysis-card--pending");
    expect(pendingMarkup).not.toContain(escapeHtml(t("today.empty.history")));

    release();
    await view._remainingLoad;
    expect(view._remainingStatus).toBe("loaded");
    expect(view._homeModel.tasks.map((t) => t.taskId).sort()).toEqual([
      "done-1",
      "open-1",
    ]);
    view._homeFilter = "todo";
    const loadedMarkup = view._render(view._homeModel);
    expect(loadedMarkup).toContain("home-tabs__count");
    expect(loadedMarkup).not.toContain("analysis-card--pending");
  });

  it("keeps the To-do tab and offers a retry when the remaining lists fail", async () => {
    freezeClock();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    catalog.listTasks.mockImplementation(async ({ status }) => {
      if (status === "open") return { tasks: [openTask] };
      throw new Error("boom");
    });
    const view = liveView("?filter=todo");
    await view.connectedCallback();
    await view._remainingLoad;

    expect(view._remainingStatus).toBe("error");
    expect(view._homeModel.tasks.map((t) => t.taskId)).toEqual(["open-1"]);
    expect(view._render(view._homeModel)).not.toContain("retry-remaining");
    view._homeFilter = "history";
    const errorMarkup = view._render(view._homeModel);
    expect(errorMarkup).toContain('id="retry-remaining"');
    expect(errorMarkup).toContain(escapeHtml(t("today.remaining.error")));
    expect(errorMarkup).not.toContain("analysis-card--pending");

    catalog.listTasks.mockImplementation(async ({ status }) => ({
      tasks: status === "completed" ? [doneTask] : [],
    }));
    await view._loadRemainingTasks();
    expect(view._remainingStatus).toBe("loaded");
    expect(view._render(view._homeModel)).not.toContain("retry-remaining");
    errorLog.mockRestore();
  });

  /** First load with one open and one completed task, fully settled. */
  async function loadedView() {
    catalog.listTasks.mockImplementation(async ({ status }) => ({
      tasks:
        status === "open"
          ? [openTask]
          : status === "completed"
            ? [doneTask]
            : [],
    }));
    const view = liveView("?filter=todo");
    await view.connectedCallback();
    await view._remainingLoad;
    expect(view._remainingStatus).toBe("loaded");
    expect(view._homeModel.tasks.map((t) => t.taskId).sort()).toEqual([
      "done-1",
      "open-1",
    ]);
    return view;
  }

  it("reuses fresh In-progress / History lists on a reload and re-fetches only the open list", async () => {
    freezeClock();
    const view = await loadedView();
    catalog.listTasks.mockClear();
    vi.setSystemTime(FROZEN_NOW.getTime() + 30_000);

    await view.connectedCallback();
    await view._remainingLoad;

    expect(catalog.listTasks.mock.calls.map(([{ status }]) => status)).toEqual([
      "open",
    ]);
    expect(view._remainingStatus).toBe("loaded");
    expect(view._homeModel.tasks.map((t) => t.taskId).sort()).toEqual([
      "done-1",
      "open-1",
    ]);
    expect(view._render(view._homeModel)).toContain("home-tabs__count");
  });

  it("drops the lists and shows a placeholder once they are older than a minute", async () => {
    freezeClock();
    const view = await loadedView();
    vi.setSystemTime(FROZEN_NOW.getTime() + 61_000);
    let release = () => {};
    const held = new Promise((resolve) => {
      release = () => resolve({ tasks: [doneTask] });
    });
    catalog.listTasks.mockImplementation(async ({ status }) =>
      status === "open" ? { tasks: [openTask] } : held,
    );

    await view.connectedCallback();
    // The previous completed task is gone, counts hidden, one placeholder.
    expect(view._remainingStatus).toBe("pending");
    expect(view._homeModel.tasks.map((t) => t.taskId)).toEqual(["open-1"]);
    expect(view._render(view._homeModel)).not.toContain("home-tabs__count");
    view._homeFilter = "history";
    const pendingMarkup = view._render(view._homeModel);
    expect(pendingMarkup.match(/analysis-card--pending/g)).toHaveLength(1);
    expect(pendingMarkup).toContain('aria-busy="true"');

    release();
    await view._remainingLoad;
    expect(view._remainingStatus).toBe("loaded");
    expect(view._homeModel.tasks.map((t) => t.taskId).sort()).toEqual([
      "done-1",
      "open-1",
    ]);
  });

  it("re-fetches the lists on the next reload after a cross-list action", async () => {
    freezeClock();
    const view = await loadedView();
    catalog.listTasks.mockClear();
    // Completing a task writes a status override: the lists are now expired
    // even though they are seconds old.
    view._setTaskOverride("open-1", "resolved");

    await view.connectedCallback();
    expect(view._remainingStatus).toBe("pending");
    await view._remainingLoad;
    expect(
      catalog.listTasks.mock.calls.map(([{ status }]) => status).sort(),
    ).toEqual(
      ["cannot_do", "completed", "completing", "in_progress", "open"].sort(),
    );
    expect(view._remainingStatus).toBe("loaded");
  });

  it("does not carry tasks over when the view re-enters for another site", async () => {
    catalog.listTasks.mockImplementation(async ({ status }) => ({
      tasks: status === "completed" ? [doneTask] : [],
    }));
    const view = liveView("?filter=todo");
    await view.connectedCallback();
    await view._remainingLoad;
    expect(view._homeModel.tasks.map((t) => t.taskId)).toEqual(["done-1"]);

    siteRead.mockResolvedValue({ siteId: "site-2" });
    let release = () => {};
    const held = new Promise((resolve) => {
      release = () => resolve({ tasks: [] });
    });
    catalog.listTasks.mockImplementation(async ({ status }) =>
      status === "open" ? { tasks: [] } : held,
    );
    await view.connectedCallback();
    expect(view._siteId).toBe("site-2");
    expect(view._homeModel.tasks).toEqual([]);
    expect(view._remainingStatus).toBe("pending");
    release();
    await view._remainingLoad;
  });

  it("ignores a late remaining-lists answer after the site changed", async () => {
    let release = () => {};
    const held = new Promise((resolve) => {
      release = () => resolve({ tasks: [doneTask] });
    });
    catalog.listTasks.mockImplementation(async ({ status }) =>
      status === "open" ? { tasks: [] } : held,
    );
    const view = liveView("?filter=todo");
    await view.connectedCallback();
    const renders = view._renderHome.mock.calls.length;
    view._siteId = "another-site";
    release();
    await view._remainingLoad;
    expect(view._renderHome.mock.calls.length).toBe(renders);
    expect(view._homeModel.tasks).toEqual([]);
  });
});

describe("worklist refresh focus", () => {
  it("announces initial arrival without moving focus or scroll on a card refresh", async () => {
    window.location.search = "?filter=todo";
    let scrollTop = 0;
    const heading = new HTMLElement();
    heading.focus = vi.fn(() => {
      scrollTop = 0;
    });
    const view = new TodayView();
    view.isConnected = true;
    view.querySelector = () => heading;
    view._renderHome = vi.fn((model) => {
      view._homeModel = model;
    });
    view._hydrateVisibleHomeTasks = vi.fn();
    view._hydrate311CardStatuses = vi.fn();

    await view.connectedCallback();
    await view._remainingLoad;
    expect(heading.focus).toHaveBeenCalledOnce();
    scrollTop = 850;

    // Checklist completion refreshes via this same callback after collapsing.
    // The first load renders twice (open list, then the remaining lists);
    // the reload reuses the still-fresh remaining lists and renders once.
    await view.connectedCallback();
    await view._remainingLoad;
    expect(view._renderHome).toHaveBeenCalledTimes(3);
    expect(heading.focus).toHaveBeenCalledOnce();
    expect(scrollTop).toBe(850);
    view.disconnectedCallback();
  });
});

describe("restored duplicate links", () => {
  function stash() {
    const view = new TodayView();
    view._homeFilter = "todo";
    view._siteId = "site-1";
    view._site = { siteId: "site-1" };
    view._homeModel = { tasks: [], checks: [] };
    view._duplicateLinks.set("duplicate", { originalTaskId: "original" });
    view.disconnectedCallback();
    view._duplicateLinks.clear();
  }

  it.each([true, false])(
    "restores copied links before async reads with flag %s",
    async (enabled) => {
      setDuplicateUiSite({ featureFlags: { duplicateDetection: enabled } });
      stash();
      window.location.search = "?filter=todo";
      /** @type {(site: { siteId: string }) => void} */
      let release = () => {};
      siteRead.mockReturnValueOnce(
        new Promise((resolve) => {
          release = resolve;
        }),
      );
      const view = new TodayView();
      view._renderHome = vi.fn(() => {
        expect(view._duplicateLinks.has("duplicate")).toBe(enabled);
      });
      view._hydrateVisibleHomeTasks = vi.fn();
      view._hydrate311CardStatuses = vi.fn();
      const pending = view.connectedCallback();
      expect(view._renderHome).toHaveBeenCalledOnce();
      release({ siteId: "site-1" });
      await pending;
      view.disconnectedCallback();
    },
  );

  it("clears restored links when the refreshed site differs", async () => {
    setDuplicateUiSite({ featureFlags: { duplicateDetection: true } });
    stash();
    siteRead.mockResolvedValueOnce({ siteId: "site-2" });
    const view = await mount("?filter=todo");
    expect(view._duplicateLinks.size).toBe(0);
    view.disconnectedCallback();
  });

  it.each(["authsignout", "sitebound"])(
    "invalidates the snapshot on %s",
    async (event) => {
      stash();
      windowListeners.get(event)();
      const view = await mount("?filter=todo");
      expect(view._renderHome).toHaveBeenCalledOnce();
      expect(view._duplicateLinks.size).toBe(0);
      view.disconnectedCallback();
    },
  );
});
