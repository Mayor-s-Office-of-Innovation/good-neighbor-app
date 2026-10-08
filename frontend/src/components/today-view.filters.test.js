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
const catalog = vi.hoisted(() => ({ listProviderSites: vi.fn() }));
vi.mock("../db.js", () => ({
  getSite: async () => ({ siteId: "site-1" }),
  hasAdminAccess: () => false,
  listBoundSites: async () => [],
  setSite: vi.fn(async (_name, meta) => ({ ...meta, id: "current" })),
  clearSiteSession: logout.clearSiteSession,
}));
vi.mock("../services/api.js", () => ({
  listProviderSites: catalog.listProviderSites,
  selectDeviceBinding: vi.fn(),
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
  awaitOverlayUnwindMock.mockClear();
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
    expect(heading.focus).toHaveBeenCalledOnce();
    scrollTop = 850;

    // Checklist completion refreshes via this same callback after collapsing.
    await view.connectedCallback();
    expect(view._renderHome).toHaveBeenCalledTimes(2);
    expect(heading.focus).toHaveBeenCalledOnce();
    expect(scrollTop).toBe(850);
    view.disconnectedCallback();
  });
});
