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

const hydrateEvidence = vi.hoisted(() => vi.fn(async () => []));
vi.mock("../services/task-evidence.js", async (importOriginal) => ({
  ...(await importOriginal()),
  hydrateTaskEvidence: hydrateEvidence,
}));

const answerUpdated = vi.hoisted(() => vi.fn());
const finishAnswerFocus = vi.hoisted(() => vi.fn());
vi.mock("./analysis-answer-controls.js", async (importOriginal) => ({
  ...(await importOriginal()),
  showQuestionAnswerUpdated: answerUpdated,
  finishQuestionAnswerFocus: finishAnswerFocus,
}));

const session = vi.hoisted(() => ({ current: null }));
const subscribeSession = vi.hoisted(() =>
  vi.fn((listener) => {
    void listener;
    return () => {};
  }),
);
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
  startCaptureDeviceLocation: async () => {},
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
  listPendingGuidance: vi.fn(async () => ({ guidance: [], nextToken: null })),
  getAssessmentGuidance: vi.fn(async () => ({
    assessment: null,
    conditions: [],
    tasks: [],
  })),
  submitConditionAnswers: vi.fn(),
  editAnalysisCondition: vi.fn(),
  listChecks: vi.fn(),
}));
vi.mock("../services/session-handoff.js", () => ({
  retireHandoff: vi.fn(async () => false),
}));
vi.mock("../db.js", () => ({
  getSite: siteRead,
  hasAdminAccess: () => false,
  listBoundSites: catalog.listBoundSites,
  setSite: vi.fn(async (_name, meta) => ({ ...meta, id: "current" })),
  clearSiteSession: logout.clearSiteSession,
  saveHomeSnapshot: vi.fn(async () => {}),
  getHomeSnapshot: vi.fn(async () => null),
}));
vi.mock("../services/api.js", () => ({
  listProviderSites: catalog.listProviderSites,
  selectDeviceBinding: vi.fn(),
  listChecks: catalog.listChecks,
  listTasks: catalog.listTasks,
  listPendingGuidance: catalog.listPendingGuidance,
  getAssessmentGuidance: catalog.getAssessmentGuidance,
  submitConditionAnswers: catalog.submitConditionAnswers,
  editAnalysisCondition: catalog.editAnalysisCondition,
}));
const duplicates = vi.hoisted(() => ({ watch: vi.fn(() => vi.fn()) }));
vi.mock("../services/duplicate-issues.js", () => ({
  watchDuplicateIssues: duplicates.watch,
}));
const queued311 = vi.hoisted(() => ({
  stop: vi.fn(),
  watch: vi.fn(),
}));
vi.mock("../services/queued-311-filings.js", () => ({
  watchQueued311Filings: queued311.watch,
}));
vi.mock("../state/check-session.js", () => ({
  getCurrentCheck: () => session.current,
  hasDraft: async () => Boolean(session.current),
  loadSubmitted: async () => null,
  loadFinishedChecks: async () => [],
  clearSubmittedSession: vi.fn(async () => {}),
  onCheckSessionChange: subscribeSession,
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
  answerUpdated.mockClear();
  hydrateEvidence.mockReset().mockResolvedValue([]);
  windowListeners.get("authsignout")?.();
  setDuplicateUiSite(null);
  siteRead.mockResolvedValue({ siteId: "site-1" });
  awaitOverlayUnwindMock.mockClear();
  catalog.listBoundSites.mockReset().mockResolvedValue([]);
  catalog.listTasks.mockReset().mockResolvedValue({ tasks: [] });
  catalog.listChecks.mockReset().mockResolvedValue({ checks: [] });
  catalog.getAssessmentGuidance
    .mockReset()
    .mockResolvedValue({ assessment: null, conditions: [], tasks: [] });
  catalog.listPendingGuidance
    .mockReset()
    .mockResolvedValue({ guidance: [], nextToken: null });
  catalog.listProviderSites.mockReset();
  catalog.listProviderSites.mockResolvedValue({
    providerId: "provider-1",
    providerName: "Test provider",
    sites: [],
    nextCursor: null,
  });
});
beforeAll(async () => {
  vi.stubGlobal("HTMLButtonElement", class {});
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
  view._renderHome = vi.fn((model) => {
    view._homeModel = model;
  });
  view._hydrateVisibleHomeTasks = vi.fn();
  await view.connectedCallback();
  // The In-progress / History lists load after the first paint; settle them
  // so tests see the complete worklist state.
  await view._remainingLoad;
  await view._pendingGuidanceLoad;
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

  it("keeps a new clear result while older unanswered questions load", async () => {
    freezeClock();
    const view = await mount("?filter=todo");
    const pendingSession = {
      id: "clear-check",
      status: "capture-complete",
      startedAt: NEWER_TODAY,
      items: [
        {
          id: "clear-photo",
          analysis: { status: "analyzed", tasks: [], conditions: [] },
        },
      ],
    };
    const model = {
      last: null,
      checks: [],
      latestStartedCheck: { id: pendingSession.id, startedAt: NEWER_TODAY },
      tasks: [],
      pendingSession,
    };
    expect(view._render(model).match(/analysis-card--clear/g)).toHaveLength(1);

    const pendingQuestions = [
      {
        id: "older-question",
        checkId: "older-check",
        analysis: {
          status: "analyzed",
          assessment: { assessmentId: "older-assessment" },
          tasks: [],
          conditions: [
            {
              conditionId: "older-condition",
              category: "Graffiti",
              status: "needs_answer",
              needsAnswer: { key: "provider_generated", options: [] },
            },
          ],
        },
      },
    ];
    const hydrated = view._render({ ...model, pendingQuestions });
    expect(hydrated.match(/analysis-card--clear/g)).toHaveLength(1);
    expect(hydrated).toContain(todayTitle(NEWER_TODAY));
    expect(hydrated).toContain('data-condition-id="older-condition"');

    // Once the saved header arrives, it replaces the local clear result.
    const completed = {
      id: pendingSession.id,
      status: "submitted",
      submittedAt: NEWER_TODAY,
      issueCount: 0,
    };
    for (const pending of [pendingSession, null]) {
      const saved = view._render({
        ...model,
        last: completed,
        checks: [completed],
        pendingSession: pending,
        pendingQuestions,
      });
      expect(saved.match(/analysis-card--clear/g)).toHaveLength(1);
      expect(saved).toContain('data-condition-id="older-condition"');
    }
  });

  it("shows the latest clear check only on To-do", async () => {
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
    expect(historyMarkup).not.toContain(t("card.clear.title"));
    expect(historyMarkup).not.toContain("analysis-tray--history");
    view._homeFilter = "in_progress";
    expect(view._render(model)).not.toContain(t("card.clear.title"));
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
    expect(markup).not.toContain(t("card.clear.title"));
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

  it("omits superseded clear checks from History", async () => {
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

    expect(markup).not.toContain(t("card.clear.title"));
  });

  it.each(["resolved", "opened"])(
    "excludes clear checks from %s day groups",
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
        mode === "opened" ? "2026-09-01" : "2026-09-02",
      ]);
      expect(groups.map((group) => group.compact)).toEqual([true, true]);
    },
  );

  it("excludes clear checks from issue-type groups", async () => {
    const view = await mount("?filter=history");
    view._historyGrouping = "type";
    view._taskCardEntry = () => ({ markup: "task-card" });
    const groups = view._historyGroups(
      [{ task: { category: "Litter" } }, { task: { category: "Graffiti" } }],
      [],
      [{ submittedAt: NEWER_TODAY }],
    );
    expect(groups.map((group) => group.title)).toEqual(["Graffiti", "Litter"]);
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

    view._renderHome = vi.fn((model) => {
      view._homeModel = model;
    });
    view._onLocationDialogClosed({ changingSite: false });
    expect(view._locationPrompt).toBeNull();
    expect(view._renderHome).toHaveBeenCalledWith(model);
  });

  it("does not redraw the home behind a site change after the prompt closes", async () => {
    const view = await mount("?filter=todo");
    view._homeModel = { tasks: [] };
    view._locationPrompt = { flowType: "perimeter", launcher: null };
    view._pendingLocationRender = true;
    view._renderHome = vi.fn((model) => {
      view._homeModel = model;
    });
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
    view._renderHome = vi.fn((model) => {
      view._homeModel = model;
    });
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
    view._renderHome = vi.fn((model) => {
      view._homeModel = model;
    });
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
    // The real start button only arrives with the data (e2e sentinel), and
    // the settings button is inert until then.
    expect(view.innerHTML).not.toContain('id="start-check"');
    expect(view.innerHTML).toMatch(/id="home-settings"[^>]*disabled/);
    // Tapping a skeleton tab selects it for the live render.
    view._skeletonTabClick({
      target: { closest: () => ({ getAttribute: () => "history" }) },
    });
    expect(view._homeFilter).toBe("history");
    expect(view.innerHTML).toMatch(
      /home-tabs__tab--active[^>]*data-home-filter="history"/,
    );

    release();
    await loading;
    await view._remainingLoad;
    expect(view._renderHome.mock.calls[0][0].pendingGuidanceLoading).toBe(true);
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

  it.each([false, true])(
    "keeps failed 311 filing available to retry when the worklist lands after failure: %s",
    async (loadAfterFailure) => {
      freezeClock();
      const { getToasts } = await import("../state/toasts.js");
      getToasts().forEach((toast) => toast.close());
      const view = liveView("?filter=todo");
      view._siteId = "site-1";
      view._watchDuplicates = vi.fn();
      const task = {
        ...openTask,
        appActions: [{ code: "create_311_ticket" }],
      };
      view._homeModel = { tasks: [task], checks: [] };
      const button = { disabled: false };
      const card = {
        isConnected: false,
        querySelector: () => null,
        querySelectorAll: () => [button],
        getAttribute: () => task.taskId,
        setAttribute: vi.fn(),
        removeAttribute: vi.fn(),
      };
      /** @type {(value: unknown) => void} */
      let finishFiling = () => {};
      const response = new Promise((resolve) => {
        finishFiling = resolve;
      });
      const onSuccess = vi.fn();
      const filing = view._run(card, () => response, {
        requireSubmitted311: true,
        onSuccess,
      });
      /** @type {(value: unknown) => void} */
      let finishWorklist = () => {};
      const worklist = new Promise((resolve) => {
        finishWorklist = resolve;
      });
      catalog.listTasks.mockImplementation(async ({ status }) =>
        status === "completing" ? worklist : { tasks: [] },
      );
      view._remainingStatus = "pending";
      const loading = view._loadRemainingTasks();
      const completeWorklist = async () => {
        finishWorklist({ tasks: [{ ...task, status: "completing" }] });
        await loading;
        await view._remainingLoad;
      };
      if (!loadAfterFailure) {
        await completeWorklist();
        expect(view._homeTasks(view._homeModel.tasks)[0].homeStatus).toBe(
          "in_progress",
        );
      }
      // Any replacement read starts after the failed attempt has reopened.
      catalog.listTasks.mockResolvedValue({ tasks: [] });
      finishFiling({
        task: {
          ...task,
          appActionResults: [{ code: "create_311_ticket", status: "failed" }],
        },
      });
      try {
        await filing;
        if (loadAfterFailure) {
          await completeWorklist();
          await view._remainingLoad;
        }
        const [entry] = view._homeTasks(view._homeModel.tasks);
        expect(entry.task.status).toBe("open");
        expect(entry.homeStatus).toBe("needs_action");
        expect(view._taskCardEntry(entry, false).markup).toContain(
          'data-action="file311"',
        );
        expect(view._busyCards.has(task.taskId)).toBe(false);
        expect(onSuccess).not.toHaveBeenCalled();
        expect(getToasts()).toHaveLength(1);
      } finally {
        getToasts().forEach((toast) => toast.close());
      }
    },
  );

  it.each([false, true])(
    "preserves a duplicate after failed shared filing with original in worklist: %s",
    async (hasOriginal) => {
      freezeClock();
      setDuplicateUiSite({ featureFlags: { duplicateDetection: true } });
      const { getToasts } = await import("../state/toasts.js");
      getToasts().forEach((toast) => toast.close());
      const view = liveView("?filter=todo");
      view._watchDuplicates = vi.fn();
      const original = {
        ...openTask,
        status: "completing",
        description: "Original evidence",
        appActions: [{ code: "create_311_ticket" }],
      };
      const duplicate = {
        ...openTask,
        taskId: "duplicate-1",
        checkId: "duplicate-check",
        description: "Duplicate evidence",
        thumbnailUrl: "duplicate-thumbnail",
      };
      const sibling = { ...duplicate, taskId: "duplicate-2" };
      view._homeModel = {
        tasks: [duplicate, sibling, ...(hasOriginal ? [original] : [])],
        checks: [],
      };
      view._duplicateLinks = new Map(
        [duplicate, sibling].map((task) => [
          task.taskId,
          {
            state: "matched",
            original,
          },
        ]),
      );
      expect(
        view
          ._homeTasks(view._homeModel.tasks)
          .map((entry) => entry.task.taskId),
      ).not.toContain(duplicate.taskId);
      const card = {
        isConnected: false,
        querySelector: () => null,
        querySelectorAll: () => [],
        getAttribute: () => duplicate.taskId,
        setAttribute: vi.fn(),
        removeAttribute: vi.fn(),
      };
      const failed = {
        ...original,
        status: "open",
        appActionResults: [{ code: "create_311_ticket", status: "failed" }],
      };
      try {
        await view._run(card, async () => ({ task: failed }), {
          requireSubmitted311: true,
        });
        expect(
          view._homeModel.tasks.filter(
            (task) => task.taskId === original.taskId,
          ),
        ).toEqual([failed]);
        expect(
          view._homeModel.tasks.find(
            (task) => task.taskId === duplicate.taskId,
          ),
        ).toEqual(duplicate);
        for (const observation of [duplicate, sibling]) {
          const entry = view
            ._homeTasks(view._homeModel.tasks)
            .find((entry) => entry.task.taskId === observation.taskId);
          expect(entry.homeStatus).toBe("needs_action");
          expect(entry.task.description).toBe(observation.description);
          expect(entry.task.thumbnailUrl).toBe(observation.thumbnailUrl);
          expect(view._taskCardEntry(entry, false).markup).toContain(
            'data-action="file311"',
          );
          expect(
            view._duplicateLinks.get(observation.taskId).original.status,
          ).toBe("open");
        }
        expect(view._watchDuplicates).toHaveBeenCalledWith(
          view._homeModel.tasks,
        );
        expect(view._busyCards.size).toBe(0);
        expect(getToasts()).toHaveLength(1);
      } finally {
        getToasts().forEach((toast) => toast.close());
      }
    },
  );

  describe("background 311 filing", () => {
    const tapped = (appActionStatus, reason = "sf311_timeout") => ({
      ...openTask,
      status: "in_progress",
      inProgressActionKind: "311_filed",
      appActionStatus,
      appActions: [{ code: "create_311_ticket" }],
      appActionResults:
        appActionStatus === "failed"
          ? [{ code: "create_311_ticket", status: "failed", reason }]
          : [],
    });
    const idleCard = (taskId) => ({
      isConnected: false,
      querySelector: () => null,
      querySelectorAll: () => [],
      getAttribute: () => taskId,
      setAttribute: vi.fn(),
      removeAttribute: vi.fn(),
    });
    beforeEach(() => {
      queued311.watch.mockReset().mockReturnValue(queued311.stop);
      queued311.stop.mockReset();
    });

    it("counts a queued filing as accepted", async () => {
      freezeClock();
      const { getToasts } = await import("../state/toasts.js");
      getToasts().forEach((toast) => toast.close());
      const view = liveView("?filter=todo");
      view._homeModel = { tasks: [openTask], checks: [] };
      const onSuccess = vi.fn();
      try {
        const result = await view._run(
          idleCard(openTask.taskId),
          async () => ({ task: tapped("queued") }),
          { requireSubmitted311: true, onSuccess },
        );
        expect(result).toMatchObject({ task: { appActionStatus: "queued" } });
        expect(onSuccess).toHaveBeenCalledTimes(1);
        expect(getToasts()).toHaveLength(0);
      } finally {
        getToasts().forEach((toast) => toast.close());
      }
    });

    it("offers a retry on a failed filing only when it can help", () => {
      freezeClock();
      const view = liveView("?filter=inprogress");
      const entryFor = (task) => {
        view._homeModel = { tasks: [task], checks: [] };
        return view._homeTasks(view._homeModel.tasks)[0];
      };

      const retryable = view._taskCardEntry(
        entryFor(tapped("failed")),
        false,
      ).markup;
      expect(retryable).toContain('data-action="file311"');
      expect(retryable).toContain(escapeHtml(t("today.action.retryFiling")));
      expect(retryable).toContain(
        escapeHtml(t("taskAction.failure.sf311Timeout")),
      );
      expect(retryable).toContain('data-status-ticker="filingFailed"');

      const uncertain = view._taskCardEntry(
        entryFor(
          tapped("failed", "sf311_creation_uncertain_requires_reconciliation"),
        ),
        false,
      ).markup;
      expect(uncertain).not.toContain('data-action="file311"');
      expect(uncertain).toContain(
        escapeHtml(t("taskAction.failure.creationUncertain")),
      );

      const queued = view._taskCardEntry(
        entryFor(tapped("queued")),
        false,
      ).markup;
      expect(queued).toContain('data-status-ticker="filing"');
      expect(queued).not.toContain('data-action="file311"');
      expect(queued).not.toContain("analysis-card__filing-note");
    });

    it("watches queued filings and applies the outcome", async () => {
      freezeClock();
      const { getToasts } = await import("../state/toasts.js");
      getToasts().forEach((toast) => toast.close());
      const view = liveView("?filter=inprogress");
      view._siteId = "site-1";
      view._refreshAfterAction = vi.fn();
      const queued = tapped("queued");
      view._homeModel = { tasks: [queued, doneTask], checks: [] };

      view._watchQueued311(view._homeModel.tasks);
      view._watchQueued311(view._homeModel.tasks);
      expect(queued311.watch).toHaveBeenCalledTimes(1);
      const [ids, onSettled] = queued311.watch.mock.calls[0];
      expect(ids).toEqual([queued.taskId]);

      const filedTask = {
        ...queued,
        appActionStatus: "submitted",
        appActionResults: [
          {
            code: "create_311_ticket",
            status: "submitted",
            payload: { tickets: [{ srNum: "SR-9" }] },
          },
        ],
      };
      try {
        onSettled(filedTask);
        expect(
          view._homeModel.tasks.find((task) => task.taskId === queued.taskId),
        ).toMatchObject({ appActionStatus: "submitted" });
        expect(view._confirmedTasks.get(queued.taskId)).toBe(filedTask);
        expect(getToasts()).toHaveLength(0);
        expect(view._refreshAfterAction).toHaveBeenCalled();

        view._watchQueued311([filedTask]);
        expect(queued311.stop).toHaveBeenCalledTimes(1);
        expect(queued311.watch).toHaveBeenCalledTimes(1);
      } finally {
        getToasts().forEach((toast) => toast.close());
      }
    });
  });

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
    const loading = view.connectedCallback();
    await vi.waitFor(() => expect(catalog.listTasks).toHaveBeenCalledTimes(4));

    const statuses = catalog.listTasks.mock.calls.map(([{ status }]) => status);
    expect(statuses[0]).toBe("open");
    expect(statuses.slice(1).sort()).toEqual(
      ["completed", "completing", "in_progress"].sort(),
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
    await loading;
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

  describe("with no connection", () => {
    const offline = Object.assign(new Error("Network error"), { status: 0 });

    it("shows the saved lists and a notice instead of the error screen", async () => {
      const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
      const { getHomeSnapshot, saveHomeSnapshot } = await import("../db.js");
      vi.mocked(saveHomeSnapshot).mockClear();
      catalog.listTasks.mockImplementation(async () => {
        throw offline;
      });
      vi.mocked(getHomeSnapshot).mockResolvedValueOnce({
        siteId: "site-1",
        checks: [],
        tasks: [openTask],
        savedAt: "2026-10-27T15:00:00.000Z",
      });
      const view = liveView("?filter=todo");
      view._renderError = vi.fn();
      await view.connectedCallback();

      expect(view._renderError).not.toHaveBeenCalled();
      expect(view._homeModel.tasks.map((task) => task.taskId)).toEqual([
        "open-1",
      ]);
      expect(view._offline).toBe(true);
      expect(view._remainingStatus).toBe("error");
      expect(saveHomeSnapshot).not.toHaveBeenCalled();
      const markup = view._render(view._homeModel);
      expect(markup).toContain('id="start-check"');
      errorLog.mockRestore();
    });

    it("keeps the error screen for a server failure", async () => {
      const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
      catalog.listTasks.mockImplementation(async () => {
        throw Object.assign(new Error("boom"), { status: 500 });
      });
      const view = liveView("?filter=todo");
      view._renderError = vi.fn();
      await view.connectedCallback();
      expect(view._renderError).toHaveBeenCalled();
      expect(view._offline).toBeFalsy();
      errorLog.mockRestore();
    });

    it("saves the lists after a successful load", async () => {
      const { saveHomeSnapshot } = await import("../db.js");
      vi.mocked(saveHomeSnapshot).mockClear();
      catalog.listTasks.mockResolvedValue({ tasks: [openTask] });
      const view = liveView("?filter=todo");
      await view.connectedCallback();
      expect(saveHomeSnapshot).toHaveBeenCalledWith("site-1", {
        checks: [],
        tasks: [openTask],
        pendingQuestions: [],
      });
      expect(view._offline).toBeNull();
    });
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

  /** Route return: the element is replaced; the next one restores the stash. */
  function routeReturn(view) {
    view.disconnectedCallback();
    return liveView("?filter=todo");
  }

  it("keeps confirmed badge counts visible while returned lists revalidate", async () => {
    freezeClock();
    const view = await loadedView();
    view._homeModel.pendingGuidanceLoading = false;
    const settled = view._render(view._homeModel);
    expect(settled).toContain("home-tabs__count");
    const counts = { ...view._tabCountSnapshot.counts };
    const next = routeReturn(view);
    next._restoreHomeState(
      {
        model: view._homeModel,
        homeFilter: "todo",
        site: view._site,
        siteId: view._siteId,
        confirmedTasks: new Map(),
        remainingStatus: "pending",
        tabCountSnapshot: view._tabCountSnapshot,
      },
      "todo",
    );
    expect(next._render(next._homeModel)).toContain("home-tabs__count");
    expect(next._tabCountSnapshot.counts).toEqual(counts);
    next._siteId = "different-site";
    expect(next._render(next._homeModel)).not.toContain("home-tabs__count");
  });

  it("hides an unverified To-do count on failure and restores it after recovery", async () => {
    freezeClock();
    const view = await loadedView();
    view._remainingStatus = "loaded";
    view._homeModel.pendingGuidanceLoading = false;
    view._render(view._homeModel);
    const confirmed = view._tabCountSnapshot.counts.todo;
    view._homeModel.pendingGuidanceLoading = true;
    view._render(view._homeModel);
    expect(view._tabCountSnapshot.counts.todo).toBe(confirmed);
    view._homeModel.pendingGuidanceLoading = false;
    view._homeModel.pendingGuidanceFailed = true;
    view._render(view._homeModel);
    expect(view._tabCountSnapshot.counts).not.toHaveProperty("todo");
    view._homeModel.pendingGuidanceFailed = false;
    view._render(view._homeModel);
    expect(view._tabCountSnapshot.counts.todo).toBe(confirmed);
  });

  it("reuses fresh In-progress / History lists on a route return and re-fetches only the open list", async () => {
    freezeClock();
    const view = await loadedView();
    catalog.listTasks.mockClear();
    vi.setSystemTime(FROZEN_NOW.getTime() + 30_000);

    const next = routeReturn(view);
    await next.connectedCallback();
    await next._remainingLoad;

    expect(catalog.listTasks.mock.calls.map(([{ status }]) => status)).toEqual([
      "open",
    ]);
    expect(next._remainingStatus).toBe("loaded");
    expect(next._homeModel.tasks.map((t) => t.taskId).sort()).toEqual([
      "done-1",
      "open-1",
    ]);
    expect(next._render(next._homeModel)).toContain("home-tabs__count");
  });

  it("re-fetches every list on a reload triggered from the screen itself", async () => {
    freezeClock();
    const view = await loadedView();
    catalog.listTasks.mockClear();
    // Seconds old, same instance: an action on this screen caused the reload.
    await view.connectedCallback();
    await view._remainingLoad;
    expect(view._remainingStatus).toBe("loaded");
    expect(
      catalog.listTasks.mock.calls.map(([{ status }]) => status).sort(),
    ).toEqual(["completed", "completing", "in_progress", "open"].sort());
  });

  it("drops the lists and shows a placeholder once they are older than a minute", async () => {
    freezeClock();
    const previous = await loadedView();
    vi.setSystemTime(FROZEN_NOW.getTime() + 61_000);
    let release = () => {};
    const held = new Promise((resolve) => {
      release = () => resolve({ tasks: [doneTask] });
    });
    catalog.listTasks.mockImplementation(async ({ status }) =>
      status === "open" ? { tasks: [openTask] } : held,
    );

    const view = routeReturn(previous);
    const loading = view.connectedCallback();
    await vi.waitFor(() => expect(view._remainingStatus).toBe("pending"));
    // The previous completed task is gone, counts hidden, one placeholder.
    expect(view._remainingStatus).toBe("pending");
    expect(view._homeModel.tasks.map((t) => t.taskId)).toEqual(["open-1"]);
    expect(view._render(view._homeModel)).not.toContain("home-tabs__count");
    view._homeFilter = "history";
    const pendingMarkup = view._render(view._homeModel);
    expect(pendingMarkup.match(/analysis-card--pending/g)).toHaveLength(1);
    expect(pendingMarkup).toContain('aria-busy="true"');

    release();
    await loading;
    await view._remainingLoad;
    expect(view._remainingStatus).toBe("loaded");
    expect(view._homeModel.tasks.map((t) => t.taskId).sort()).toEqual([
      "done-1",
      "open-1",
    ]);
  });

  it("re-fetches the lists on the next reload after a cross-list action", async () => {
    freezeClock();
    const previous = await loadedView();
    catalog.listTasks.mockClear();
    // Completing a task writes a status override: the lists are now expired
    // even though they are seconds old, so even a route return re-fetches.
    previous._setTaskOverride("open-1", "resolved");

    const view = routeReturn(previous);
    await view.connectedCallback();
    await view._remainingLoad;
    expect(view._remainingStatus).toBe("loaded");
    expect(
      catalog.listTasks.mock.calls.map(([{ status }]) => status).sort(),
    ).toEqual(["completed", "completing", "in_progress", "open"].sort());
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
    const loading = view.connectedCallback();
    await vi.waitFor(() => expect(view._remainingStatus).toBe("pending"));
    expect(view._siteId).toBe("site-2");
    expect(view._homeModel.tasks).toEqual([]);
    expect(view._remainingStatus).toBe("pending");
    release();
    await loading;
    await view._remainingLoad;
  });

  it("keeps keyboard focus on the current tab when retrying a failed load", async () => {
    const view = await loadedView();
    view._remainingStatus = "error";
    view._retryRemaining();
    expect(view._remainingStatus).toBe("pending");
    expect(view._focusAfterRender).toBe("home-tab-current");
    await view._remainingLoad;
    expect(view._remainingStatus).toBe("loaded");
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
    const loading = view.connectedCallback();
    await vi.waitFor(() => expect(view._remainingStatus).toBe("pending"));
    const renders = view._renderHome.mock.calls.length;
    view._siteId = "another-site";
    release();
    await loading;
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
    // Each load renders twice (open list, then the remaining lists): a reload
    // from this screen follows an action and re-fetches every list.
    await view.connectedCallback();
    await view._remainingLoad;
    expect(view._renderHome.mock.calls.length).toBeGreaterThanOrEqual(4);
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
      expect(view._renderHome.mock.calls[0][0].pendingGuidanceLoading).toBe(
        true,
      );
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
      expect(view._renderHome.mock.calls[0][0].pendingGuidanceLoading).toBe(
        true,
      );
      expect(view._duplicateLinks.size).toBe(0);
      view.disconnectedCallback();
    },
  );
});

it("holds a saved clarification without reloading the worklist during an answer", async () => {
  const view = await mount("?filter=todo");
  const updated = { id: "check-one", status: "capture-complete", items: [] };
  view._homeModel = { tasks: [], pendingSession: { id: "check-one" } };
  view._answeringConditionIds.add("condition-one");
  view._renderHome.mockClear();
  view.connectedCallback = vi.fn(() => new Promise(() => {}));
  const listener = subscribeSession.mock.calls.at(-1)[0];
  listener(updated);
  expect(view._renderHome).toHaveBeenCalledWith({
    tasks: [],
    pendingSession: updated,
  });
  expect(view.connectedCallback).not.toHaveBeenCalled();
  view._renderHome.mockClear();
  listener({ ...updated, id: "different-check" });
  expect(view._renderHome).not.toHaveBeenCalled();
});

describe("attention badges and newer submissions", () => {
  it("counts only old, City-closed, and overdue in-progress issues once each", async () => {
    freezeClock();
    const view = await mount("?filter=in_progress");
    const filed = {
      status: "in_progress",
      createdAt: NEWER_TODAY,
      appActionResults: [
        { code: "create_311_ticket", payload: { tickets: [{ srNum: "123" }] } },
      ],
    };
    const tasks = [
      {
        ...filed,
        taskId: "closed",
        ticketStatus: "Closed",
        ticketResponseOverdue: true,
      },
      { ...filed, taskId: "overdue", ticketResponseOverdue: true },
      {
        ...filed,
        taskId: "old",
        createdAt: new Date(FROZEN_NOW.getTime() - 8 * 86400000).toISOString(),
      },
      { ...filed, taskId: "normal" },
      { ...filed, taskId: "scheduled", ticketStatus: "Scheduled" },
      {
        taskId: "called",
        status: "in_progress",
        kind: "non_actionable_escalation",
        createdAt: NEWER_TODAY,
      },
      {
        ...filed,
        taskId: "history",
        createdAt: new Date(FROZEN_NOW.getTime() - 15 * 86400000).toISOString(),
      },
    ];
    view._311StatusByTaskId = new Map([
      ["closed", { status: "Closed", responseOverdue: true }],
      ["overdue", { status: "Open", responseOverdue: true }],
      ["scheduled", { status: "Scheduled", responseOverdue: false }],
    ]);
    const results = vi.spyOn(view, "_homeResults").mockReturnValue("");
    view._render({ checks: [], tasks });
    expect(
      /** @type {any} */ (results.mock.calls[0][0]).tabCounts.in_progress,
    ).toBe(3);
  });

  it("badges only history cards still awaiting completion proof", async () => {
    freezeClock();
    const view = await mount("?filter=history");
    const completed = {
      status: "completed",
      createdAt: NEWER_TODAY,
      completedAt: NEWER_TODAY,
      completionMethod: "site_team_resolved",
    };
    const tasks = [
      { ...completed, taskId: "resolved" },
      {
        ...completed,
        taskId: "direct",
        completionMethod: "manual",
        canBeInProgress: false,
      },
      { ...completed, taskId: "documented", proofAddedAt: NEWER_TODAY },
      { taskId: "expired", status: "in_progress", createdAt: "2020-01-01" },
    ];
    const results = vi.spyOn(view, "_homeResults").mockReturnValue("");
    view._render({ checks: [], tasks });
    expect(
      /** @type {any} */ (results.mock.calls[0][0]).tabCounts.history,
    ).toBe(2);
  });

  it("keeps a new clear result visible alongside older recovered questions", async () => {
    freezeClock();
    const view = await mount("?filter=todo");
    const markup = view._render({
      checks: [],
      tasks: [],
      pendingSession: {
        id: "new-clear",
        status: "capture-complete",
        startedAt: NEWER_TODAY,
        items: [
          {
            id: "clear-photo",
            analysis: { status: "analyzed", conditions: [], tasks: [] },
          },
        ],
      },
      pendingQuestions: [
        {
          id: "old-question",
          checkId: "old-check",
          analysis: {
            status: "analyzed",
            checkId: "old-check",
            artifactId: "old-artifact",
            assessment: {
              assessmentId: "old-assessment",
              checkId: "old-check",
            },
            tasks: [],
            conditions: [
              {
                conditionId: "old-condition",
                status: "needs_answer",
                user_friendly_label: "Older unanswered issue",
                needsAnswer: {
                  key: "on_site",
                  prompt: "Is this on site property?",
                  options: [],
                },
              },
            ],
          },
        },
      ],
    });
    expect(markup).toContain(t("card.clear.title"));
    expect(markup).toContain('data-condition-id="old-condition"');
  });

  it("removes the old notice while a newer local submission is analyzing", async () => {
    freezeClock();
    const view = await mount("?filter=todo");
    const clear = {
      id: "clear",
      status: "submitted",
      issueCount: 0,
      submittedAt: OLDER_TODAY,
    };
    const markup = view._render({
      last: clear,
      checks: [clear],
      tasks: [],
      pendingSession: {
        id: "pending",
        status: "capture-complete",
        submittedAt: NEWER_TODAY,
        items: [{ id: "photo", analysis: { status: "pending" } }],
      },
    });
    expect(markup).not.toContain(t("card.clear.title"));
  });

  it("hides the clear notice when another user starts a check before analysis finishes", async () => {
    freezeClock();
    const view = await mount("?filter=todo");
    view.isConnected = true;
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      configurable: true,
    });
    const clear = {
      id: "clear",
      status: "submitted",
      issueCount: 0,
      submittedAt: OLDER_TODAY,
    };
    view._homeModel = { last: clear, checks: [clear], tasks: [] };
    catalog.listChecks.mockResolvedValue({
      checks: [
        {
          checkId: "new",
          startedAt: NEWER_TODAY,
          status: "in_progress",
          issueCount: 0,
        },
        {
          checkId: "clear",
          status: "completed",
          completedAt: OLDER_TODAY,
          issueCount: 0,
        },
      ],
    });
    await view._refreshChecks();
    const model = view._renderHome.mock.calls.at(-1)[0];
    expect(model.last.id).toBe("clear");
    expect(model.latestStartedCheck.id).toBe("new");
    expect(view._render(model)).not.toContain(t("card.clear.title"));
    view._homeModel = model;
    view._renderHome.mockClear();
    await view._refreshChecks();
    expect(view._renderHome).not.toHaveBeenCalled();
    // A later clear result may display its own notice.
    model.checks[0] = {
      ...model.latestStartedCheck,
      status: "submitted",
      issueCount: 0,
    };
    expect(view._render(model)).toContain(t("card.clear.title"));
  });
});

it("repaints photo progress without refetching lists, but refreshes new analysis", async () => {
  const view = await mount("?filter=todo");
  const listener = subscribeSession.mock.calls.at(-1)[0];
  const pending = {
    id: "progress-check",
    status: "capture-complete",
    items: [{ id: "photo", analysis: { status: "queued" } }],
  };
  listener(pending);
  await view._homeRefresh;
  view._homeModel = { tasks: [], pendingSession: pending };
  catalog.listTasks.mockClear();
  catalog.listProviderSites.mockClear();
  view._renderHome.mockClear();
  for (const status of ["uploading", "analyzing", "analyzing", "failed"]) {
    pending.items[0].analysis.status = status;
    listener(pending);
  }
  expect(view._renderHome).toHaveBeenCalledTimes(4);
  expect(catalog.listTasks).not.toHaveBeenCalled();
  expect(catalog.listProviderSites).not.toHaveBeenCalled();
  pending.items[0].analysis.status = "analyzed";
  listener(pending);
  await view._homeRefresh;
  expect(catalog.listTasks).toHaveBeenCalledTimes(4);
  expect(catalog.listProviderSites).toHaveBeenCalledOnce();
});

it("refreshes open tasks while secondary lists are slow, without overlapping secondary reads", async () => {
  const view = await mount("?filter=todo");
  view.isConnected = true;
  view.querySelector = () => null;
  view.querySelectorAll = () => [];
  view._renderHome = vi.fn((model) => {
    view._homeModel = model;
  });
  view._hydrate311CardStatuses = vi.fn();
  let release = () => {};
  const held = new Promise((resolve) => {
    release = () =>
      resolve({ tasks: [{ taskId: "stale", status: "completed" }] });
  });
  catalog.listTasks.mockClear();
  catalog.listProviderSites.mockClear();
  catalog.listTasks.mockImplementation(({ status }) =>
    status === "completed" ? held : Promise.resolve({ tasks: [] }),
  );
  await view.connectedCallback();
  expect(catalog.listTasks).toHaveBeenCalledTimes(4);
  catalog.listTasks.mockImplementation(async ({ status }) => ({
    tasks: status === "open" ? [{ taskId: "late-task", status: "open" }] : [],
  }));
  const refresh = view.connectedCallback();
  for (let i = 0; i < 20; i++) expect(view.connectedCallback()).toBe(refresh);
  await refresh;
  // One active primary pass and one coalesced trailing pass; neither waits
  // for the old completed-task read. No new secondary batch starts yet.
  expect(catalog.listProviderSites).toHaveBeenCalledTimes(3);
  expect(catalog.listTasks).toHaveBeenCalledTimes(6);
  expect(view._homeModel.tasks).toContainEqual({
    taskId: "late-task",
    status: "open",
  });
  release();
  await view._remainingLoad;
  expect(catalog.listTasks).toHaveBeenCalledTimes(9);
  expect(view._homeModel.tasks.some((task) => task.taskId === "stale")).toBe(
    false,
  );
  expect(view._remainingStatus).toBe("loaded");
});

it("refreshes tasks when an existing assessment revision changes", async () => {
  const view = await mount("?filter=todo");
  const listener = subscribeSession.mock.calls.at(-1)[0];
  const pending = {
    id: "check",
    status: "capture-complete",
    items: [
      {
        id: "photo",
        analysis: {
          status: "analyzed",
          assessment: {
            assessmentId: "same-assessment",
            assessmentRevision: 1,
          },
        },
      },
    ],
  };
  listener(pending);
  await view._homeRefresh;
  await view._remainingLoad;
  view._homeModel = { tasks: [], pendingSession: pending };
  catalog.listTasks.mockClear();
  pending.items[0].analysis.assessment.assessmentRevision = 2;
  listener(pending);
  await view._homeRefresh;
  await view._remainingLoad;
  expect(catalog.listTasks).toHaveBeenCalledTimes(4);
  catalog.listTasks.mockClear();
  listener(pending);
  expect(catalog.listTasks).not.toHaveBeenCalled();
});

it("preserves a queued refresh after a local site read rejects", async () => {
  const view = await mount("?filter=todo");
  siteRead.mockClear();
  /** @type {(error: Error) => void} */
  let reject = () => {};
  siteRead.mockReturnValueOnce(
    new Promise((_resolve, fail) => {
      reject = fail;
    }),
  );
  const refresh = view.connectedCallback();
  expect(view.connectedCallback()).toBe(refresh);
  reject(new Error("local read failed"));
  await refresh;
  expect(siteRead).toHaveBeenCalledTimes(2);
  await view._remainingLoad;
  siteRead.mockClear();
  siteRead.mockRejectedValueOnce(new Error("no queued refresh"));
  await expect(view.connectedCallback()).rejects.toThrow("no queued refresh");
  expect(siteRead).toHaveBeenCalledOnce();
});

it("discards a disconnected refresh and its queued work after reconnecting to another site", async () => {
  const view = await mount("?filter=todo");
  let release = () => {};
  catalog.listProviderSites.mockReturnValueOnce(
    new Promise((resolve) => {
      release = () => resolve({ sites: [], providerName: "old-provider" });
    }),
  );
  const old = view.connectedCallback();
  await vi.waitFor(() => expect(view._providerSitesStatus).toBe("loading"));
  view.connectedCallback();
  view.disconnectedCallback();
  siteRead.mockResolvedValue({ siteId: "site-2" });
  await view.connectedCallback();
  view._renderHome.mockClear();
  release();
  await old;
  expect(view._siteId).toBe("site-2");
  expect(view._providerName).not.toBe("old-provider");
  expect(view._renderHome).not.toHaveBeenCalled();
});

it("maps a recovered question to its retained local evidence for edits and answers", async () => {
  const view = await mount("?filter=todo");
  session.current = {
    id: "check-one",
    items: [
      {
        id: "local-photo",
        analysis: { assessment: { assessmentId: "assessment-one" } },
      },
    ],
  };
  view._homeModel = {
    pendingQuestions: [
      {
        id: "pending:assessment-one:condition-one",
        analysis: { assessment: { assessmentId: "assessment-one" } },
      },
    ],
  };
  expect(
    await view._localQuestionItemId("pending:assessment-one:condition-one"),
  ).toBe("local-photo");
  session.current = null;
  expect(
    await view._localQuestionItemId("pending:assessment-one:condition-one"),
  ).toBeNull();
  expect(await view._localQuestionItemId("ordinary-local-item")).toBe(
    "ordinary-local-item",
  );
});

it.each([true, false])(
  "republishes edits to recovered questions (retained local copy: %s)",
  async (hasLocal) => {
    const analysis = await import("../services/photo-analysis.js");
    const localRefresh = vi
      .spyOn(analysis, "refreshEvidenceAnalysis")
      .mockResolvedValue(undefined);
    const recoveredRefresh = vi
      .spyOn(analysis, "refreshRecoveredQuestion")
      .mockResolvedValue({ assessment: {}, conditions: [], tasks: [] });
    try {
      const view = await mount("?filter=todo");
      const item = {
        id: "recovered",
        checkId: "check",
        analysis: {
          artifactId: "artifact",
          assessment: { assessmentId: "assessment" },
        },
      };
      view._homeModel = { tasks: [], pendingQuestions: [item] };
      view._activeProblem = {
        itemId: item.id,
        checkId: "check",
        artifactId: "artifact",
        conditionId: "condition",
        description: "Original description",
      };
      view._analysisEditDescription = { value: "Updated description" };
      view.querySelector = () => null;
      view._setDialogError = vi.fn();
      view._localQuestionItemId = vi.fn(async () =>
        hasLocal ? "local-photo" : null,
      );
      view.connectedCallback = vi.fn(async () => {});
      const response = { assessment: {} };
      catalog.editAnalysisCondition.mockResolvedValue(response);
      await view._saveProblemEdit();
      if (hasLocal) {
        expect(localRefresh).toHaveBeenCalledWith("local-photo", response);
        expect(recoveredRefresh).not.toHaveBeenCalled();
      } else {
        expect(recoveredRefresh).toHaveBeenCalledWith(item, response);
        expect(localRefresh).not.toHaveBeenCalled();
      }
      expect(view.connectedCallback).toHaveBeenCalledOnce();
    } finally {
      localRefresh.mockRestore();
      recoveredRefresh.mockRestore();
    }
  },
);

it("keeps live tasks and withholds unverified cached questions when guidance fails", async () => {
  const { saveHomeSnapshot } = await import("../db.js");
  const { clearSubmittedSession } = await import("../state/check-session.js");
  const view = await mount("?filter=todo");
  const condition = {
    conditionId: "question",
    canonicalCategory: "Bulky items",
    status: "needs_answer",
    needsAnswer: { key: "provider_generated", options: [] },
  };
  const pending = {
    id: "pending:a:question",
    checkId: "old-check",
    analysis: {
      status: "analyzed",
      artifactId: "artifact",
      assessment: { assessmentId: "a" },
      conditions: [condition],
      tasks: [],
    },
  };
  const task = {
    taskId: "fresh",
    status: "open",
    createdAt: new Date().toISOString(),
  };
  view._homeModel = { tasks: [], pendingQuestions: [pending] };
  session.current = {
    id: "old-check",
    status: "capture-complete",
    scorecardDone: true,
    items: [{ ...pending, id: "local" }],
  };
  catalog.listChecks.mockResolvedValue({
    checks: [{ checkId: "old-check", status: "completed" }],
  });
  catalog.listTasks.mockImplementation(async ({ status }) => ({
    tasks: status === "open" ? [task] : [],
  }));
  catalog.listPendingGuidance.mockRejectedValueOnce(new Error("guidance down"));
  vi.mocked(saveHomeSnapshot).mockClear();
  vi.mocked(clearSubmittedSession).mockClear();
  view._renderError = vi.fn();
  catalog.getAssessmentGuidance.mockRejectedValueOnce(
    new Error("guidance down"),
  );
  await view.connectedCallback();
  await view._pendingGuidanceLoad;
  const model = view._renderHome.mock.calls.at(-1)[0];
  expect(model).toMatchObject({
    tasks: [task],
    pendingQuestions: [],
    pendingGuidanceFailed: true,
  });
  expect(view._offline).toBeNull();
  expect(view._renderError).not.toHaveBeenCalled();
  expect(saveHomeSnapshot).not.toHaveBeenCalled();
  expect(clearSubmittedSession).not.toHaveBeenCalled();
  view._homeModel = model;
  expect(view._render(model)).toContain(t("today.questions.error"));
  expect(view._render(model)).toContain('id="retry-guidance"');
  catalog.listPendingGuidance.mockResolvedValue({
    guidance: [],
    nextToken: null,
  });
  await view.connectedCallback();
  await view._pendingGuidanceLoad;
  expect(view._renderHome.mock.calls.at(-1)[0].pendingGuidanceFailed).toBe(
    false,
  );
});

it("does not leak cached questions across a site switch when guidance fails", async () => {
  const view = await mount("?filter=todo");
  view._homeModel = {
    tasks: [],
    pendingQuestions: [{ id: "other-site-question" }],
  };
  siteRead.mockResolvedValue({ siteId: "site-2" });
  catalog.listPendingGuidance.mockRejectedValueOnce(new Error("guidance down"));
  await view.connectedCallback();
  await view._pendingGuidanceLoad;
  expect(view._renderHome.mock.calls.at(-1)[0].pendingQuestions).toEqual([]);
});

it("explains an expired analyzer edit and retains the description for the user", async () => {
  const view = await mount("?filter=todo");
  const problem = {
    itemId: "recovered",
    checkId: "check",
    artifactId: "artifact",
    conditionId: "condition",
    description: "Original description",
  };
  view._activeProblem = problem;
  view._analysisEditDescription = { value: "My updated description" };
  view.querySelector = () => null;
  view._setDialogError = vi.fn();
  catalog.editAnalysisCondition.mockRejectedValueOnce({
    status: 404,
    body: { code: "unknown_analysis" },
  });
  await view._saveProblemEdit();
  expect(view._setDialogError).toHaveBeenLastCalledWith(
    "analysis-edit-error",
    t("analysis.editDialog.expired"),
  );
  expect(view._activeProblem).toBe(problem);
  expect(view._analysisEditDescription.value).toBe("My updated description");
});

it("uses retained local evidence when committing deletion of a recovered card", async () => {
  const deletion = await import("./analysis-card-deletion.js");
  const actions = await import("./analysis-problem-actions.js");
  const commit = vi
    .spyOn(deletion, "deleteAnalysisCard")
    .mockImplementation(async (_host, _problem, save) => {
      await save();
    });
  const reject = vi
    .spyOn(actions, "rejectProblemCondition")
    .mockImplementation(async (_problem, handlers) => {
      handlers.deleteLocally();
    });
  try {
    const view = await mount("?filter=todo");
    view._activeProblem = {
      itemId: "recovered",
      checkId: "check",
      artifactId: "artifact",
      conditionId: "condition",
    };
    view._localQuestionItemId = vi.fn(async () => "local-evidence");
    view._deleteProblemLocally = vi.fn();
    view._setDialogError = vi.fn();
    view.querySelector = () => null;
    await view._confirmDeleteProblem();
    expect(reject.mock.calls[0][0].itemId).toBe("local-evidence");
    expect(view._deleteProblemLocally).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: "local-evidence" }),
    );
  } finally {
    commit.mockRestore();
    reject.mockRestore();
  }
});

it("keeps the resolution-proof History badge visible when guidance recovery fails", async () => {
  freezeClock();
  const view = await mount("?filter=history");
  view._homeModel = { tasks: [], pendingGuidanceFailed: true };
  view._remainingStatus = "loaded";
  const markup = view._render({
    checks: [],
    tasks: [
      {
        taskId: "resolved-needing-proof",
        status: "completed",
        createdAt: NEWER_TODAY,
        completedAt: NEWER_TODAY,
        completionMethod: "site_team_resolved",
      },
    ],
  });
  const historyTab = markup.match(
    /data-home-filter="history"[^>]*>([\s\S]*?)<\/button>/,
  )?.[1];
  expect(historyTab).toContain('class="home-tabs__count"');
  expect(historyTab).toMatch(/>1<\/span/);
});

describe("duplicate watch continuity", () => {
  it("keeps unchanged watches and invalidates changed server tasks", async () => {
    const { onDuplicateInvalidation } = await import(
      "../services/duplicate-invalidation.js"
    );
    duplicates.watch.mockClear();
    const changed = vi.fn();
    const stop = onDuplicateInvalidation(changed);
    const view = new TodayView();
    view._siteId = "watch-continuity-site";
    const tasks = [{ taskId: "one", status: "open", updatedAt: "v1" }];
    try {
      view._watchDuplicates(tasks);
      view._watchDuplicates(tasks.map((task) => ({ ...task })));
      expect(duplicates.watch).toHaveBeenCalledOnce();
      expect(changed).not.toHaveBeenCalled();
      view._watchDuplicates([
        { ...tasks[0], status: "completed", updatedAt: "v2" },
      ]);
      expect(changed).toHaveBeenCalledExactlyOnceWith(view._siteId, [
        { ...tasks[0], status: "completed", updatedAt: "v2" },
      ]);
      expect(duplicates.watch).toHaveBeenCalledOnce();
      view._watchDuplicates([
        { ...tasks[0], status: "completed", updatedAt: "v2" },
        { taskId: "two" },
      ]);
      expect(duplicates.watch).toHaveBeenCalledTimes(2);
      // A newly mounted view still observes the versions associated with the
      // session cache, rather than treating the changed row as its first read.
      view._stopDuplicates?.();
      const remount = new TodayView();
      remount._siteId = view._siteId;
      remount._watchDuplicates([{ ...tasks[0], updatedAt: "v3" }]);
      expect(changed).toHaveBeenCalledTimes(2);
      remount._stopDuplicates?.();
    } finally {
      stop();
      view._stopDuplicates?.();
    }
  });
});

it("renders live tasks before historical recovery finishes and publishes each recovered page", async () => {
  const view = await mount("?filter=todo");
  const task = { taskId: "live", status: "open", createdAt: NEWER_TODAY };
  catalog.listTasks.mockImplementation(async ({ status }) => ({
    tasks: status === "open" ? [task] : [],
  }));
  const condition = {
    conditionId: "question",
    status: "needs_answer",
    needsAnswer: { key: "provider_generated", options: [] },
  };
  /** @type {(value: any) => void} */
  let release = () => {};
  catalog.listPendingGuidance
    .mockResolvedValueOnce({
      guidance: [
        {
          assessment: { assessmentId: "a", checkId: "check" },
          conditions: [condition],
        },
      ],
      nextToken: "older",
    })
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
  await view.connectedCallback();
  await vi.waitFor(() => expect(release).toBeDefined());
  expect(view._homeModel.tasks).toEqual([task]);
  expect(view._homeModel.pendingQuestions).toHaveLength(1);
  expect(view._homeModel.pendingGuidanceLoading).toBe(true);
  expect(view._render(view._homeModel)).toContain(t("common.loading"));
  release({ guidance: [], nextToken: null });
  await view._pendingGuidanceLoad;
  expect(view._homeModel.pendingGuidanceLoading).toBe(false);
  expect(view._homeModel.pendingQuestions).toHaveLength(1);
});

it.each(["completed", "superseded"])(
  "never renders a retained %s task as actionable while History is delayed",
  async (status) => {
    const view = await mount("?filter=todo");
    const task = {
      taskId: "old-task",
      conditionId: "old-condition",
      assessmentId: "a",
      status: "open",
      createdAt: NEWER_TODAY,
    };
    session.current = {
      id: "check",
      status: "capture-complete",
      scorecardDone: true,
      items: [
        {
          id: "local",
          analysis: {
            status: "analyzed",
            assessment: { assessmentId: "a" },
            conditions: [],
            tasks: [task],
          },
        },
      ],
    };
    const releases = [];
    catalog.listTasks.mockImplementation(async ({ status }) =>
      status === "open"
        ? { tasks: [] }
        : new Promise((resolve) => {
            releases.push(() => resolve({ tasks: [] }));
          }),
    );
    catalog.getAssessmentGuidance.mockResolvedValueOnce({
      assessment: { assessmentId: "a", checkId: "check" },
      conditions: [],
      tasks: [{ ...task, status }],
    });
    view._renderHome.mockClear();
    await view.connectedCallback();
    expect(view._renderHome.mock.calls[0][0].localGuidancePending).toBe(true);
    await view._pendingGuidanceLoad;
    expect(view._homeModel.tasks[0].status).toBe(status);
    expect(view._render(view._homeModel)).not.toContain(
      'data-task-id="old-task"',
    );
    releases.forEach((release) => release());
    await view._remainingLoad;
    view.disconnectedCallback();
  },
);

it("ignores historical recovery from an earlier refresh on the same site", async () => {
  const view = await mount("?filter=todo");
  /** @type {(value: any) => void} */
  let release = () => {};
  catalog.listPendingGuidance.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await view.connectedCallback();
  const old = view._pendingGuidanceLoad;
  await view.connectedCallback();
  await view._pendingGuidanceLoad;
  release({
    guidance: [
      {
        assessment: { assessmentId: "old" },
        conditions: [{ conditionId: "stale" }],
      },
    ],
    nextToken: null,
  });
  await old;
  expect(view._homeModel.pendingQuestions).toEqual([]);
});

it("preserves backend check headers in the offline snapshot after background recovery", async () => {
  const { saveHomeSnapshot } = await import("../db.js");
  const view = await mount("?filter=todo");
  const checks = [
    {
      checkId: "check",
      status: "completed",
      startedAt: OLDER_TODAY,
      completedAt: NEWER_TODAY,
    },
  ];
  catalog.listChecks.mockResolvedValueOnce({ checks });
  vi.mocked(saveHomeSnapshot).mockClear();
  await view.connectedCallback();
  await view._pendingGuidanceLoad;
  expect(saveHomeSnapshot).toHaveBeenLastCalledWith(
    "site-1",
    expect.objectContaining({ checks }),
  );
});

it("retires an optimistic open task after another device dismisses it", async () => {
  const view = await mount("?filter=todo");
  const task = {
    taskId: "confirmed",
    assessmentId: "a",
    status: "open",
    updatedAt: OLDER_TODAY,
  };
  view._confirmedTasks = new Map([[task.taskId, task]]);
  catalog.getAssessmentGuidance.mockResolvedValueOnce({
    assessment: { assessmentId: "a" },
    conditions: [],
    tasks: [{ ...task, status: "superseded", updatedAt: NEWER_TODAY }],
  });
  await view.connectedCallback();
  expect(view._reconcileConfirmedTasks([], false, false)).toEqual([]);
  await view._pendingGuidanceLoad;
  expect(view._confirmedTasks.has(task.taskId)).toBe(false);
  expect(view._homeTasks(view._homeModel.tasks)).toEqual([]);
});

it("updates a no-task answer locally before refreshing the worklist", async () => {
  const analysis = await import("../services/photo-analysis.js");
  const answered = {
    conditionId: "question",
    status: "completed",
    needsAnswer: null,
  };
  const save = vi.spyOn(analysis, "answerAnalysisQuestion").mockResolvedValue({
    assessmentItem: { assessmentId: "a", assessmentRevision: 2 },
    conditionItem: answered,
    taskItem: null,
  });
  try {
    const view = await mount("?filter=todo");
    const item = {
      id: "local",
      analysis: {
        status: "analyzed",
        assessment: { assessmentId: "a", assessmentRevision: 1 },
        conditions: [
          {
            conditionId: "question",
            status: "needs_answer",
            needsAnswer: { key: "provider_generated", options: [] },
          },
        ],
        tasks: [],
      },
    };
    view._homeModel = {
      tasks: [],
      pendingSession: { id: "check", items: [item] },
      pendingQuestions: [],
      localGuidancePending: false,
    };
    view.querySelectorAll = () => [];
    view._setInlineProblemError = vi.fn();
    view._refreshAfterAction = vi.fn(async () => {});
    const button = new HTMLButtonElement();
    button.getAttribute = (name) =>
      name === "data-answer-key" ? "provider_generated" : "true";
    await view._answerAnalysisQuestion(
      { itemId: "local", conditionId: "question" },
      button,
    );
    expect(save).toHaveBeenCalledWith(
      "local",
      "question",
      "provider_generated",
      true,
      item.analysis,
    );
    expect(view._homeModel.pendingSession.items[0].analysis.conditions).toEqual(
      [answered],
    );
  } finally {
    save.mockRestore();
  }
});

it("does not apply a delayed question answer to a different site", async () => {
  const view = await mount("?filter=todo");
  view._homeModel = {
    tasks: [],
    pendingQuestions: [
      { id: "recovered", analysis: { assessment: { assessmentId: "a" } } },
    ],
  };
  view._localQuestionItemId = vi.fn(async () => null);
  view.querySelectorAll = () => [];
  view._setInlineProblemError = vi.fn();
  view._refreshAfterAction = vi.fn(async () => {});
  const button = new HTMLButtonElement();
  button.getAttribute = (name) =>
    name === "data-answer-key" ? "provider_generated" : "true";
  /** @type {(value:any)=>void} */ let release = () => {};
  catalog.submitConditionAnswers.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const pending = view._answerAnalysisQuestion(
    { itemId: "recovered", conditionId: "question" },
    button,
  );
  await vi.waitFor(() =>
    expect(catalog.submitConditionAnswers).toHaveBeenCalled(),
  );
  view._siteId = "site-2";
  view._homeModel = { tasks: [], pendingQuestions: [] };
  release({
    assessmentItem: { assessmentId: "a" },
    conditionItem: { conditionId: "question", status: "completed" },
    taskItem: { taskId: "site-1-task", status: "open" },
  });
  await pending;
  expect(view._homeModel.tasks).toEqual([]);
  expect(view._refreshAfterAction).not.toHaveBeenCalled();
  expect(answerUpdated).not.toHaveBeenCalled();
});

it("preserves the selected problem while a background refresh leaves its dialog open", async () => {
  const view = await mount("?filter=todo");
  const selected = {
    checkId: "check",
    artifactId: "artifact",
    conditionId: "condition",
  };
  view._activeProblem = selected;
  view.querySelector = (selector) =>
    selector === ".analysis-dialog[open]" ? {} : null;
  await view.connectedCallback();
  expect(view._activeProblem).toBe(selected);
  siteRead.mockResolvedValueOnce({ siteId: "another-site" });
  await view.connectedCallback();
  expect(view._activeProblem).toBeNull();
});

it("cleans up each completed home answer even while another confirmation holds the render", () => {
  finishAnswerFocus.mockClear();
  const view = {
    isConnected: true,
    _siteId: "example",
    _homeRefreshGeneration: 1,
    _answeringConditionIds: new Set(["first", "second"]),
    _renderHome: vi.fn(),
  };
  TodayView.prototype._finishQuestionConfirmation.call(
    view,
    "first",
    "example",
    1,
  );
  expect(finishAnswerFocus).toHaveBeenCalledWith(view, "first");
  expect(view._renderHome).not.toHaveBeenCalled();
  expect(view._answeringConditionIds.has("second")).toBe(true);
});

it.each([
  "publish",
  "site",
  "refresh",
  "request",
  "removed",
  "artifact",
  "disconnected",
])(
  "applies only current photo hydration while the model changes (%s)",
  async (change) => {
    let release = (_tasks) => {
      void _tasks;
    };
    hydrateEvidence.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const task = {
      taskId: "photo-task",
      checkId: "photo-check",
      sourceArtifactIds: ["original"],
      status: "open",
      description: "Original",
    };
    const view = {
      _homeModel: { tasks: [task] },
      _hydrationGeneration: 0,
      _siteId: "site",
      _homeRefreshGeneration: 1,
      isConnected: true,
      _homeFilter: "todo",
      _homeTasks: (tasks) =>
        tasks.map((task) => ({ task, homeStatus: "needs_action" })),
      _renderHome: vi.fn(),
    };
    const pending = TodayView.prototype._hydrateVisibleHomeTasks.call(view);
    const currentTask = {
      ...task,
      status: "in_progress",
      description: "Edited while signing",
    };
    view._homeModel = { tasks: [currentTask], pendingGuidanceLoading: false };
    if (change === "site") view._siteId = "other";
    if (change === "refresh") view._homeRefreshGeneration++;
    if (change === "request") view._hydrationGeneration++;
    if (change === "removed") view._homeModel.tasks = [];
    if (change === "artifact") currentTask.sourceArtifactIds = ["replacement"];
    if (change === "disconnected") view.isConnected = false;
    release([
      {
        ...task,
        evidence: { kind: "photo", artifactId: "original" },
        mediaUrl: "https://cdn.example.test/photo",
        mediaState: "ready",
      },
    ]);
    await pending;
    if (["site", "refresh", "request", "disconnected"].includes(change)) {
      expect(view._renderHome).not.toHaveBeenCalled();
    } else {
      const model = view._renderHome.mock.calls[0][0];
      expect(model.pendingGuidanceLoading).toBe(false);
      if (change === "removed") expect(model.tasks).toEqual([]);
      else {
        expect(model.tasks[0]).toMatchObject({
          status: "in_progress",
          description: "Edited while signing",
        });
        if (change === "artifact")
          expect(model.tasks[0].mediaUrl).toBeUndefined();
        else
          expect(model.tasks[0].mediaUrl).toBe(
            "https://cdn.example.test/photo",
          );
      }
    }
  },
);
