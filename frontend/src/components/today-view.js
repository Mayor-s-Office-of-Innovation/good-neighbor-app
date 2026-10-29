import {
  loadPendingQuestionItems,
  mergePendingQuestionItems,
} from "../services/pending-guidance.js";
import { duplicateUiEnabled } from "../services/feature-flags.js";
import { animatedEllipsis } from "../lib/ellipsis.js";
import {
  projectDuplicateTasks,
  duplicateCounts,
} from "../domain/duplicate-issues.js";
import { watchDuplicateIssues } from "../services/duplicate-issues.js";
import { watchQueued311Filings } from "../services/queued-311-filings.js";
import { openDuplicateIssue } from "./duplicate-issue-launcher.js";
import {
  toggleCardCompletion,
  completeCardAction,
  isCompletingAnalysisCard,
  slideCompletedCard,
} from "./analysis-card-completion.js";
import { taskCardTitle } from "../domain/task-title.js";
import { groupHistory } from "../domain/task-history.js";
import { statusTicker } from "../domain/status-ticker.js";
/*
  today-view — the home hub (the screen with the "Perimeter check" button).

  One always-on screen (no due/up-to-date fork), driven by real data. When we have
  the data, it shows a timestamp for the last check, the current issue count,
  and the site's real TASK# worklist. Cards carry the task's own action buttons,
  wired to the completion endpoint.

  311 filing is a backend app action: explicit escalation buttons file during
  completion, while action/non-actionable escalation rules may file silently when
  tasks are created. Markup lives in today-view.templates.js; this file owns
  state, data loading, and DOM wiring.
*/
import "./today-view.css";
import {
  show311FilingToast,
  show311SuccessToast,
  show311ErrorToast,
  showActionSaveErrorToast,
  showAnswerSaveErrorToast,
  showDeleteErrorToast,
  showEditErrorToast,
  showEditRefreshErrorToast,
  showEditSavedToast,
  showReanalysisErrorToast,
  showSiteCatalogErrorToast,
  showSiteSwitchBlockedToast,
  showSiteSwitchErrorToast,
  showLanguageErrorToast,
} from "../state/toasts.js";
import {
  onDeletionsChange,
  isTaskPendingDeletion,
} from "../state/pending-deletions.js";
import {
  deleteAnalysisCard,
  isDeletingAnalysisCard,
} from "./analysis-card-deletion.js";
import { navigate } from "../router.js";
import { awaitOverlayUnwind, openOverlayDialog } from "../dialog-history.js";
import { announceScreenHeading } from "../screen-focus.js";
import {
  clearSiteSession,
  countUnsentWork,
  getSite,
  hasAdminAccess,
  listBoundSites,
} from "../db.js";
import { retireHandoff } from "../services/session-handoff.js";
import {
  listChecks,
  listTasks,
  submitConditionAnswers,
  editAnalysisCondition,
  get311RequestDetails,
} from "../services/api.js";
import {
  answerAnalysisQuestion,
  analyzeNoIssueDescriptionEdit,
  refreshEvidenceAnalysis,
  refreshRecoveredQuestion,
  retryEvidenceItem,
} from "../services/photo-analysis.js";
import { adaptCheckHeader } from "../domain/check-adapter.js";
import {
  HOME_TABS,
  displayTaskId,
  hasProblemResults,
  homeTabForStatus,
  homeTaskStatus,
  isNewHomeTask,
  isOutsideSiteRadius,
  isStalePendingSession,
  lastLogSummary,
  needsResolutionProof,
  newestBlueCheckGroup,
  newestTaskEntriesFirst,
  normalizedHomeTab,
  relativeDay,
  sessionProblemItemHasBackendCards,
  splitSiteIdentity,
  taskArtifactIdSet,
  taskArtifactIds,
  taskCheckGroupId,
  taskCreatedAt,
  timeOf,
  uniqueTasks,
  visibleTaskEntriesForHydration,
} from "../domain/home-tasks.js";
import {
  hydrateTaskEvidence,
  mergeHydratedTasks,
  needsTaskEvidenceHydration,
} from "../services/task-evidence.js";
import {
  clearTaskStatusOverrides,
  repairSeparatedTaskStatusOverrides,
  readTaskStatusOverrides,
  writeTaskStatusOverrides,
} from "../state/task-status-overrides.js";
import { requestId, setBusy, setDialogError } from "../lib/dialog-controls.js";
import {
  missingConditionMessage,
  problemFromCard,
  rejectProblemCondition,
} from "./analysis-problem-actions.js";
import {
  appActionFailureMessage,
  canRetry311Filing,
  filing311State,
  isAccepted311Filing,
  isFiled311Completion,
  submitted311ServiceRequestNumber,
} from "../domain/task-actions.js";
import {
  getCurrentCheck,
  hasDraft,
  loadFinishedChecks,
  loadSubmitted,
  onCheckSessionChange,
  clearSubmittedSession,
  discardInMemorySession,
  pauseCheck,
  removeItem,
  rejectConditionLocally,
  resolveConditionLocally,
} from "../state/check-session.js";
import {
  analysisActionPriority,
  sortAnalysisCards,
  taskAnalysisCard,
} from "./analysis-results.templates.js";
import {
  errorView,
  heroBlock,
  homeResults,
  homeShell,
  homeSkeleton,
  summaryBlock,
} from "./today-view.templates.js";
import { TaskSheets } from "./task-sheets.js";
import {
  map311StatusResponse,
  submitted311Requests,
  taskWith311Status,
} from "../domain/task-311-status.js";
import "./site-switcher.js";
import "./location-dialog.js";
import { fetchProviderSites } from "../services/provider-sites.js";
import { switchToBoundSite } from "../services/site-switch.js";
import { getLocale, setLocale, t } from "../i18n/i18n.js";
import { rulebookText } from "../i18n/rulebook.js";
import { setQuestionAnswerBusy } from "./analysis-answer-controls.js";
import { finalizeCaptureScorecardInBackground } from "../services/submit-check.js";
import { isConnectionFailure } from "../services/photo-analysis.js";
import { getHomeSnapshot, saveHomeSnapshot } from "../db.js";
import {
  getSiteCheckDeviceLocation,
  getLastDeviceLocation,
  onDeviceLocationChange,
  refreshGrantedDeviceLocation,
} from "../services/device-location.js";

/**
 * The outgoing home element's last rendered state, captured on unmount and
 * painted synchronously by the next element to mount. app-root mounts a
 * fresh element for every navigation and this screen paints only after its
 * data chain resolves, so a route transition arriving here otherwise
 * snapshots a blank work list and pops the content in after the slides.
 * One snapshot; cleared when an element unmounts with nothing rendered.
 * Keys mirror the adopting instance fields: model, homeFilter,
 * historyGrouping, taskOverrides, hasPerimeterDraft, site, siteId,
 * providerName, providerSites, providerSitesStatus, boundSites,
 * task311Statuses, duplicateLinks.
 * @type {Record<string, any> | null}
 */
let lastHomeState = null;

/** @param {TodayView} view */
function stashHomeState(view) {
  lastHomeState = view._homeModel
    ? {
        model: view._homeModel,
        homeFilter: view._homeFilter,
        historyGrouping: view._historyGrouping,
        taskOverrides: view._taskOverrides,
        confirmedTasks: new Map(view._confirmedTasks),
        hasPerimeterDraft: view._hasPerimeterDraft,
        site: view._site,
        siteId: view._siteId,
        providerName: view._providerName,
        providerSites: view._providerSites,
        providerSitesStatus: view._providerSitesStatus,
        boundSites: view._boundSites,
        task311Statuses: view._311StatusByTaskId,
        duplicateLinks: new Map(view._duplicateLinks),
        remainingStatus: view._remainingStatus,
        remainingLoadedAt: view._remainingLoadedAt,
      }
    : null;
}

// How long the In-progress / History lists stay fresh enough to reuse on a
// reload (route return, or an action on this screen) without re-fetching.
// Cross-list actions expire them early — see _expireRemainingLists.
const REMAINING_LISTS_FRESH_MS = 60_000;

// The stash belongs to one site session and must never paint for the next
// one: sign-out and re-binding replace the device's binding in the same
// document (app-root re-renders setup, then `sitebound` navigates back to
// /today). A bound-site switch is a full `location.assign` reload, so the
// module state is already fresh there. Both events bubble to window
// (site-setup dispatches `sitebound` with bubbles: true).
if (typeof window !== "undefined") {
  window.addEventListener("authsignout", () => {
    lastHomeState = null;
  });
  window.addEventListener("sitebound", () => {
    lastHomeState = null;
  });
}

/**
 * The most recently started check header (any status), in UI shape.
 * @param {any[] | undefined} checks
 */
function latestStarted(checks) {
  return (checks || [])
    .map(adaptCheckHeader)
    .sort((a, b) =>
      String(b.startedAt || "").localeCompare(String(a.startedAt || "")),
    )[0];
}

/**
 * Submitted check headers from GET /v1/checks, newest first, in UI shape.
 * @param {any[] | undefined} checks
 */
function submittedChecks(checks) {
  return (checks || [])
    .map((h) => adaptCheckHeader(h))
    .filter((c) => c.status === "submitted")
    .sort((a, b) => (b.submittedAt || "").localeCompare(a.submittedAt || ""));
}

/** Server-relevant session changes; progress and duplicate projections stay local.
 * @param {any} session
 */
function sessionRefreshKey(session) {
  return JSON.stringify([
    session?.id,
    session?.status,
    (session?.items || []).map((item) => [
      item.id,
      item.analysis?.status === "analyzed"
        ? item.analysis?.sourceAnalysis?.analysisId || "analyzed"
        : null,
      item.analysis?.assessment?.assessmentId,
      item.analysis?.assessment?.assessmentRevision,
    ]),
  ]);
}

class TodayView extends HTMLElement {
  constructor() {
    super();
    this._cardDeletedHandler = (event) => {
      if (!this._deferredDeletionRender) return;
      this._deferredDeletionRender = false;
      if (event.target === this) return;
      this._focusAfterRender = "home-primary-control";
      void this.connectedCallback();
    };
    this._focusAfterRender = null;
    this._homeModel = null;
    /** @type {Promise<void> | null} */
    this._homeRefresh = null;
    this._taskListFreshness = new Map();
    this._tabRefreshes = new Map();
    /** @type {(() => void) | null} */
    this._tabRefreshStatus = null;
    /** @type {(() => "pending" | "loaded" | "error") | null} */
    this._tabListStatus = null;
    this._tabRefreshEpoch = 0;
    this._homeRefreshQueued = false;
    this._homeRefreshGeneration = 0;
    /** @type {Promise<void> | null} */
    this._remainingRefresh = null;
    this._remainingRefreshQueued = false;
    /**
     * Cards with a non-checklist action in flight (the 311 filing, 5–20 s),
     * by task id: `_applyBusyCards` restores their busy state after any
     * repaint during the request, so renders are never held for them.
     * @type {Map<string, { action?: string, label?: string }>}
     */
    this._busyCards = new Map();
    this._hydrationGeneration = 0;
    this._answeringConditionIds = new Set();
    this._settingsMenuOpen = false;
    this._settingsDocumentClick = null;
    this._attributionsDialog = null;
    this._attributionsDialogOpen = false;
    this._languageDialog = null;
    this._languageDialogOpen = false;
    /** @type {any} the persistent <site-switcher>, created on first render */
    this._siteSwitcher = null;
    this._providerSites = [];
    this._providerSitesStatus = "idle";
    this._boundSites = [];
    this._providerName = "";
    this._logoutDialog = null;
    this._logoutDialogOpen = false;
    this._logoutPending = false;
    this._logoutError = "";
    /** @type {{ checks?: number, careLogs?: number }} */
    this._logoutUnsent = {};
    this._deviceLocation = getLastDeviceLocation();
    this._locationUnsub = null;
    /** @type {any} the persistent <location-dialog>, created on first render */
    this._locationDialog = null;
    /** @type {{ flowType: string, launcher: EventTarget | null } | null} capture waiting on the prompt */
    this._locationPrompt = null;
    this._pendingLocationRender = false;
    /** A home paint held while a native dialog in the subtree was open. */
    this._pendingDialogRender = false;
    this._startingCapture = false;
    /** @type {TaskSheets | null} the 311 and updates sheets, created on first use */
    this._sheets = null;
    /** @type {Map<string, import("../domain/task-311-status.js").Ticket311State>} */
    this._311StatusByTaskId = new Map();
    this._311StatusGeneration = 0;
    this._refresh311OnReturn = () => {
      this._refresh311Statuses();
      void this._refreshChecks();
      void this._refreshActiveTab();
    };
    this._checksRefreshTimer = null;
    this._checksRefreshing = false;
    this._duplicateLinks = new Map();
    this._duplicateCloseHandler = () => {
      if (!document.querySelector("dialog[open]")) this._flushDialogRender();
      if (
        this._duplicatesNeedRender &&
        this.isConnected &&
        this._homeModel &&
        !document.querySelector("dialog[open]")
      ) {
        this._duplicatesNeedRender = false;
        this._renderHome(this._homeModel);
      }
    };
  }

  disconnectedCallback() {
    clearInterval(this._checksRefreshTimer);
    this._checksRefreshTimer = null;
    this._tabRefreshEpoch++;
    this._tabRefreshes.clear();
    this._remainingRefresh = null;
    this._remainingRefreshQueued = false;
    this._homeRefreshGeneration++;
    this._homeRefreshQueued = false;
    this._homeRefresh = null;
    this._remainingGeneration = (this._remainingGeneration || 0) + 1;
    window.removeEventListener("focus", this._refresh311OnReturn);
    this._stopQueued311?.();
    this._queued311Key = "";
    document.removeEventListener("visibilitychange", this._refresh311OnReturn);
    this._stopDuplicates?.();
    if (this._skeletonTabClick) {
      this.removeEventListener("click", this._skeletonTabClick);
      this._skeletonTabClick = null;
    }
    document.removeEventListener("close", this._duplicateCloseHandler, true);
    window.removeEventListener("phonecompletionsaved", this._phoneSaved);
    this._deletionUnsub?.();
    this._deletionUnsub = null;
    this._sessionUnsub?.();
    this._sessionUnsub = null;
    window.removeEventListener("online", this._onlineReload);
    this._onlineReload = null;
    this.removeEventListener("analysiscarddeleted", this._cardDeletedHandler);
    document.removeEventListener("click", this._settingsDocumentClick);
    this._settingsDocumentClick = null;
    document.removeEventListener("click", this._actionMenuDocumentClick);
    this._actionMenuDocumentClick = null;
    this._locationUnsub?.();
    this._locationUnsub = null;
    // Hand the freshly rendered state to the next element to mount, so route
    // transitions never snapshot a blank screen (see lastHomeState).
    stashHomeState(this);
  }

  connectedCallback() {
    this._checksRefreshTimer ??= setInterval(() => {
      void this._refreshChecks();
    }, 30_000);
    if (this._homeRefresh) {
      this._homeRefreshQueued = true;
      return this._homeRefresh;
    }
    const generation = this._homeRefreshGeneration;
    const run = async () => {
      do {
        this._homeRefreshQueued = false;
        try {
          await this._loadHome(generation);
        } catch (error) {
          // An already-requested refresh may recover from a failed local read.
          // Do not retry on our own, or discard that explicit queued request.
          if (
            !this._homeRefreshQueued ||
            generation !== this._homeRefreshGeneration
          )
            throw error;
        }
      } while (
        this._homeRefreshQueued &&
        generation === this._homeRefreshGeneration
      );
    };
    const pending = run().finally(() => {
      if (this._homeRefresh === pending) this._homeRefresh = null;
    });
    this._homeRefresh = pending;
    return pending;
  }

  /** @param {number} generation */
  async _loadHome(generation) {
    this._taskListFreshness.clear();
    this._tabRefreshEpoch++;
    this._tabRefreshes.clear();
    window.addEventListener("focus", this._refresh311OnReturn);
    document.addEventListener("visibilitychange", this._refresh311OnReturn);
    document.addEventListener("close", this._duplicateCloseHandler, true);
    if (!this._phoneSaved)
      this._phoneSaved = () => {
        void this.connectedCallback();
      };
    window.addEventListener("phonecompletionsaved", this._phoneSaved);
    if (isDeletingAnalysisCard(this) || isCompletingAnalysisCard(this)) {
      this._deferredDeletionRender = true;
      return;
    }
    if (!this._deletionUnsub) {
      this._deletionUnsub = onDeletionsChange((status) => {
        if (!this.isConnected) return;
        if (status === "saved") {
          this._expireRemainingLists();
          void this.connectedCallback();
        } else if (this._homeModel) this._renderHome(this._homeModel);
      });
    }
    if (!this._locationUnsub) {
      this._locationUnsub = onDeviceLocationChange((location) => {
        this._deviceLocation = location;
        if (this.isConnected && this._homeModel) {
          this._renderHome(this._homeModel);
        }
      });
      void refreshGrantedDeviceLocation();
    }
    if (!this._sessionUnsub) {
      // One key per check: finished checks uploading in the background emit
      // their own changes alongside the one on screen.
      const refreshKeys = new Map();
      const initial = getCurrentCheck();
      refreshKeys.set(initial?.id, sessionRefreshKey(initial));
      this._sessionUnsub = onCheckSessionChange((session) => {
        if (session?.status === "in-progress") return;
        if (
          this._homeModel &&
          this._homeModel.pendingSession?.id === session?.id
        ) {
          this._renderHome({ ...this._homeModel, pendingSession: session });
        }
        const nextKey = sessionRefreshKey(session);
        if (nextKey === refreshKeys.get(session?.id)) return;
        refreshKeys.set(session?.id, nextKey);
        // A background check only matters to home once it is the one shown.
        if (
          session &&
          session !== getCurrentCheck() &&
          this._homeModel?.pendingSession?.id !== session.id
        )
          return;
        void this.connectedCallback();
      });
    }
    if (!this._onlineReload) {
      // Offline home is a saved snapshot: reload the live lists on reconnect.
      this._onlineReload = () => {
        if (this._offline && this.isConnected) void this.connectedCallback();
      };
      window.addEventListener("online", this._onlineReload);
    }
    if (!this._settingsDocumentClick) {
      this._settingsDocumentClick = (event) => {
        if (!this._settingsMenuOpen) return;
        const path = event.composedPath?.() || [];
        const withinSettings = path.some(
          (node) =>
            node instanceof Element && node.matches(".home-settings-wrap"),
        );
        if (!withinSettings) this._closeSettingsMenu();
      };
      document.addEventListener("click", this._settingsDocumentClick);
    }

    // Refreshing a completed card is not a new screen arrival. Re-focusing
    // the heading after that refresh would scroll the worklist to the top.
    // A restored snapshot IS an arrival (the outgoing element stashed its
    // state on unmount), and it must paint synchronously: the route
    // transition snapshots this screen the moment the swap callback returns,
    // before the data chain's first await lands. The chain below still
    // refetches everything and re-renders.
    const requestedFilter = new URLSearchParams(window.location.search).get(
      "filter",
    );
    const restoring = !this._homeModel && lastHomeState != null;
    const announceArrival = !this._homeModel || restoring;
    if (restoring)
      this._restoreHomeState(
        /** @type {any} */ (lastHomeState),
        requestedFilter,
      );
    const previousSiteId = this._siteId;
    const site = await getSite();
    if (generation !== this._homeRefreshGeneration) return;
    this._site = site;
    this._siteId =
      this._site.siteId || this._site.providerSiteId || this._site.id;
    if (previousSiteId && previousSiteId !== this._siteId) {
      this._stopDuplicates?.();
      this._stopQueued311?.();
      this._queued311Key = "";
      this._duplicateLinks = new Map();
      this._confirmedTasks = new Map();
    }
    // First arrival with nothing to show yet: paint the chrome and placeholder
    // cards from the stored site record now, so first contentful paint does
    // not wait on the worklist round trip below. A refresh (model present)
    // or a restored snapshot already has real content on screen.
    if (!this._homeModel && !restoring) this._renderSkeleton(requestedFilter);
    this._providerSitesStatus = "loading";
    // The provider catalog only feeds the site switcher and the location
    // prompt, so it rides in the same round trip as the worklist below
    // instead of gating it: one network tier before first paint, not two.
    // Neither read can reject — a failed catalog is a switcher state, and a
    // failed bindings read must not take the worklist down with it. The
    // latter stays `null` (unknown) rather than an empty list so a switch
    // re-reads it instead of treating every bound site as unbound.
    const catalogLoad = Promise.all([
      fetchProviderSites().catch((error) => {
        console.error("listProviderSites failed", error);
        showSiteCatalogErrorToast();
        return null;
      }),
      listBoundSites().catch((error) => {
        console.error("listBoundSites failed", error);
        return null;
      }),
    ]);

    const active = getCurrentCheck();
    // An in-progress draft no longer re-enters capture from home: capture
    // lives on its own route (/check, /problem) and home stays the worklist.
    // A failed local read must not strand the skeleton: no pending session
    // is the safe reading, and the worklist load below carries on.
    let pendingSession =
      active && active.status === "capture-complete"
        ? active
        : await loadSubmitted().catch((err) => {
            console.error("loadSubmitted failed", err);
            return null;
          });
    // Legacy-stage records (uploading/analyzing/submitted) are unreachable now —
    // clear them instead of letting them linger in the review store forever.
    if (pendingSession && pendingSession.status !== "capture-complete") {
      await clearSubmittedSession(pendingSession.id);
      pendingSession = null;
    }

    // Checks + the open worklist are read from the backend on load (AP6/AP10) —
    // newest first, adapted to the UI record shape. Online-only: on failure show
    // an error, not a crash.
    // Only the open list gates the first paint: it is all the default To-do
    // tab shows. The In-progress and History lists (the slowest call is the
    // ever-growing completed list) load right after the first render — see
    // _loadRemainingTasks.
    let submitted, tasks, latestStartedCheck, pendingQuestions;
    let pendingGuidanceFailed = false;
    let reuseRemaining = false;
    try {
      const [[catalog, bindings], { checks }, openTasksResult, questions] =
        await Promise.all([
          catalogLoad,
          listChecks({ limit: 30 }),
          listTasks({ status: "open", limit: 50 }),
          loadPendingQuestionItems().then(
            (items) => ({ items, failed: false }),
            () => ({ items: null, failed: true }),
          ),
        ]);
      if (generation !== this._homeRefreshGeneration) return;
      this._providerSitesStatus = catalog ? "loaded" : "error";
      this._providerSites = catalog?.sites || [];
      this._providerName =
        catalog?.providerName || this._site.providerName || "";
      this._boundSites = bindings;
      // The remaining lists are reused only on a route return (restored
      // snapshot) for this site, loaded within REMAINING_LISTS_FRESH_MS and
      // not expired by a cross-list action since; then only the open list is
      // re-fetched. Every reload triggered from this screen follows an action
      // (a task update, 311 filing, deletion, phone save, check finished)
      // and re-fetches everything, so a status change made on the server is
      // never masked by a cached list. When not reused they are dropped:
      // In-progress and History show a placeholder and the tab counts stay
      // hidden until the fresh lists land. Old cards are never shown.
      const sameSite = !previousSiteId || previousSiteId === this._siteId;
      reuseRemaining =
        restoring &&
        sameSite &&
        this._remainingStatus === "loaded" &&
        Date.now() - (this._remainingLoadedAt || 0) < REMAINING_LISTS_FRESH_MS;
      const reused = reuseRemaining
        ? (this._homeModel?.tasks || []).filter(
            (task) => task.status && task.status !== "open",
          )
        : [];
      this._taskListFreshness.set("open", Date.now());
      tasks = uniqueTasks([...(openTasksResult.tasks || []), ...reused]);
      pendingGuidanceFailed = questions.failed;
      if (pendingGuidanceFailed) {
        const cached = sameSite ? this._homeModel?.pendingQuestions : null;
        const snapshot = cached
          ? null
          : await getHomeSnapshot(this._siteId).catch(() => null);
        if (generation !== this._homeRefreshGeneration) return;
        pendingQuestions = cached || snapshot?.pendingQuestions || [];
      } else pendingQuestions = questions.items || [];
      if (!reuseRemaining) this._remainingStatus = "pending";
      else
        for (const status of ["in_progress", "completing", "completed"])
          this._taskListFreshness.set(status, this._remainingLoadedAt);
      latestStartedCheck = latestStarted(checks);
      submitted = submittedChecks(checks);
      this._offline = null;
      if (!pendingGuidanceFailed)
        void saveHomeSnapshot(this._siteId, {
          checks: checks || [],
          tasks: this._reconcileConfirmedTasks(openTasksResult.tasks || []),
          pendingQuestions,
        }).catch(() => {});
    } catch (err) {
      if (generation !== this._homeRefreshGeneration) return;
      console.error("listChecks/listTasks failed", err);
      // No connection: show the last saved lists (or empty ones) so Start
      // check and checks waiting to upload stay reachable. Other failures
      // keep the error screen.
      if (!isConnectionFailure(err)) {
        this._renderError();
        return;
      }
      const snapshot = await getHomeSnapshot(this._siteId).catch(() => null);
      if (generation !== this._homeRefreshGeneration) return;
      this._offline = true;
      latestStartedCheck = latestStarted(snapshot?.checks);
      submitted = submittedChecks(snapshot?.checks);
      tasks = uniqueTasks(snapshot?.tasks || []);
      pendingQuestions = snapshot?.pendingQuestions || [];
      this._remainingStatus = "error";
    }

    const last = submitted[0];
    let effectivePendingSession =
      pendingSession && pendingSession.status === "capture-complete"
        ? pendingSession
        : null;

    // Older finished checks wait in the background; drop each one the
    // backend history now shows (offline lists are a snapshot, so never then).
    const finishedChecks = await loadFinishedChecks(this._siteId).catch(
      () => [],
    );
    const coveredCards = [
      ...tasks,
      ...(pendingQuestions || []).flatMap((item) =>
        item.analysis.conditions.map((condition) => ({
          conditionId: condition.conditionId,
          assessmentId: item.analysis.assessment.assessmentId,
        })),
      ),
    ];
    if (!this._offline && !pendingGuidanceFailed)
      for (const check of finishedChecks)
        if (
          check.id !== effectivePendingSession?.id &&
          this._isStalePendingSession(check, submitted, coveredCards)
        )
          await clearSubmittedSession(check.id);
    if (
      !this._offline &&
      !pendingGuidanceFailed &&
      this._isStalePendingSession(
        effectivePendingSession,
        submitted,
        coveredCards,
      )
    ) {
      await clearSubmittedSession(effectivePendingSession.id);
      effectivePendingSession = null;
    } else if (
      !this._offline &&
      effectivePendingSession?.status === "capture-complete" &&
      !effectivePendingSession.scorecardDone
    ) {
      finalizeCaptureScorecardInBackground(effectivePendingSession.id, {
        expectedArtifacts: effectivePendingSession.expectedArtifacts,
      });
    }

    if (generation !== this._homeRefreshGeneration) return;
    this._taskOverrides = readTaskStatusOverrides();
    this._homeFilter =
      this._homeFilter || normalizedHomeTab(requestedFilter || "");
    this._activeProblem = null;
    this._hasPerimeterDraft = await hasDraft("perimeter");
    if (generation !== this._homeRefreshGeneration) return;
    if (!duplicateUiEnabled()) this._duplicateLinks = new Map();
    this._renderHome({
      last,
      checks: submitted,
      latestStartedCheck,
      tasks,
      pendingSession: effectivePendingSession,
      pendingQuestions,
      pendingGuidanceFailed,
    });
    // Evidence hydration is for the cards on screen now. The duplicate watcher
    // (a poll) and the 311 status batch wait for the complete list, so each
    // starts once per load: here when the remaining lists were reused, else
    // in _loadRemainingTasks.
    if (this._offline) {
      if (announceArrival) announceScreenHeading(this, ".home-identity__site");
      return;
    }
    void this._hydrateVisibleHomeTasks();
    if (reuseRemaining) {
      this._remainingLoad = Promise.resolve();
      this._watchDuplicates(tasks);
      void this._hydrate311CardStatuses(tasks);
    } else {
      this._startRemainingLoad();
    }
    if (announceArrival) announceScreenHeading(this, ".home-identity__site");
  }

  /**
   * A cross-list action (a task completed, filed to 311, moved to in
   * progress, or a card deleted) changes the In-progress / History lists:
   * forget their freshness so the next reload re-fetches them.
   */
  _expireRemainingLists() {
    this._remainingLoadedAt = 0;
    // A request already in flight predates the change: its answer must not
    // land and re-stamp the lists as fresh.
    this._remainingGeneration = (this._remainingGeneration || 0) + 1;
  }

  _startRemainingLoad() {
    if (this._remainingRefresh) {
      this._remainingRefreshQueued = true;
      // The active response predates the latest open-worklist refresh.
      this._remainingGeneration = (this._remainingGeneration || 0) + 1;
      return;
    }
    const generation = this._homeRefreshGeneration;
    const run = async () => {
      do {
        this._remainingRefreshQueued = false;
        await this._loadRemainingTasks().catch((err) =>
          console.error("remaining worklist failed", err),
        );
      } while (
        this._remainingRefreshQueued &&
        generation === this._homeRefreshGeneration
      );
    };
    const pending = run().finally(() => {
      if (this._remainingRefresh === pending) this._remainingRefresh = null;
    });
    this._remainingRefresh = pending;
    this._remainingLoad = pending;
  }

  /** The retry button on a failed In-progress / History load. */
  _retryRemaining() {
    this._remainingStatus = "pending";
    // The re-render replaces the focused button with the placeholder: keep
    // keyboard users on the tab they are looking at.
    this._focusAfterRender = "home-tab-current";
    if (this._homeModel) this._renderHome(this._homeModel);
    this._startRemainingLoad();
  }

  _taskWith311CardStatus(task) {
    return taskWith311Status(task, this._311StatusByTaskId);
  }

  /**
   * Follow background 311 filings until each is filed or fails,
   * then toast the outcome and repaint the card. Restarts only when the set
   * of queued tasks changes.
   * @param {Record<string, any>[]} tasks
   */
  _watchQueued311(tasks) {
    const ids = tasks
      .filter((task) => filing311State(task) === "queued")
      .map((task) => task.taskId)
      .sort();
    const key = ids.join();
    if (key === this._queued311Key) return;
    this._stopQueued311?.();
    this._queued311Key = key;
    const siteId = this._siteId;
    this._stopQueued311 = ids.length
      ? watchQueued311Filings(ids, (task) => {
          if (!this.isConnected || this._siteId !== siteId) return;
          // Hold the outcome over list reads that lag behind the worker.
          this._confirmedTasks ??= new Map();
          this._confirmedTasks.set(task.taskId, task);
          this._applyTaskResult(task.taskId, task);
          if (filing311State(task) === "failed") show311ErrorToast();
          else if (isFiled311Completion(task))
            show311SuccessToast(
              submitted311ServiceRequestNumber(task),
              taskCardTitle(task),
            );
          void this._refreshAfterAction();
        })
      : null;
  }

  /** @param {Record<string, any>[]} tasks */
  _watchDuplicates(tasks) {
    this._stopDuplicates?.();
    const siteId = this._siteId;
    this._stopDuplicates = watchDuplicateIssues(
      tasks.map((t) => t.taskId),
      (links) => {
        if (!this.isConnected || this._siteId !== siteId) return;
        this._duplicateLinks = links;
        if (document.querySelector("dialog[open]")) {
          this._duplicatesNeedRender = true;
          return;
        }
        if (
          this._homeModel &&
          !isCompletingAnalysisCard(this) &&
          !isDeletingAnalysisCard(this)
        )
          this._renderHome(this._homeModel);
      },
    );
  }

  /**
   * Second data tier: the lists behind the In-progress and History tabs,
   * fetched after the first paint (connectedCallback loads only `open`).
   * Merges into the current model and re-renders; the tab counts stay
   * hidden until this lands. A failure leaves those tabs on a retry state
   * (`#retry-remaining`) — the To-do tab is unaffected.
   */
  async _loadRemainingTasks() {
    const generation = (this._remainingGeneration =
      (this._remainingGeneration || 0) + 1);
    const siteId = this._siteId;
    const stillCurrent = () =>
      generation === this._remainingGeneration &&
      this._siteId === siteId &&
      this.isConnected &&
      Boolean(this._homeModel);
    let results;
    try {
      results = await Promise.all(
        ["in_progress", "completing", "completed"].map((status) =>
          listTasks({ status, limit: 50 }),
        ),
      );
    } catch (err) {
      console.error("listTasks (remaining) failed", err);
      if (!stillCurrent()) return;
      this._remainingStatus = "error";
      this._renderHome(this._homeModel);
      // The open list is all we have; watch and hydrate that much.
      this._watchDuplicates(this._homeModel.tasks);
      void this._hydrate311CardStatuses(this._homeModel.tasks);
      return;
    }
    if (!stillCurrent()) return;
    this._reconcileConfirmedTasks(
      results.flatMap((result) => result.tasks || []),
      true,
    );
    const model = this._homeModel;
    // Merge the fresh status lists with the first-tier model. _renderHome
    // retains confirmed completions while any index entries are still stale.
    const tasks = uniqueTasks([
      ...results.flatMap((result) => result.tasks || []),
      ...model.tasks,
    ]);
    this._remainingStatus = "loaded";
    this._remainingLoadedAt = Date.now();
    for (const status of ["in_progress", "completing", "completed"])
      this._taskListFreshness.set(status, Date.now());
    this._renderHome({ ...model, tasks });
    this._watchDuplicates(tasks);
    void this._hydrate311CardStatuses(tasks);
    void this._hydrateVisibleHomeTasks();
  }

  async _refreshChecks() {
    if (
      !this.isConnected ||
      document.visibilityState === "hidden" ||
      !this._homeModel ||
      this._checksRefreshing
    )
      return;
    const siteId = this._siteId;
    this._checksRefreshing = true;
    try {
      const response = await listChecks({ limit: 30 });
      if (!this.isConnected || this._siteId !== siteId) return;
      const headers = (response.checks || []).map(adaptCheckHeader);
      const latestStartedCheck = [...headers].sort((a, b) =>
        String(b.startedAt || "").localeCompare(String(a.startedAt || "")),
      )[0];
      const checks = headers
        .filter((check) => check.status === "submitted")
        .sort((a, b) =>
          String(b.submittedAt || "").localeCompare(
            String(a.submittedAt || ""),
          ),
        );
      // Ignore an older snapshot and avoid rebuilding unchanged cards on each poll.
      if (
        String(latestStartedCheck?.startedAt || "") <
        String(this._homeModel.latestStartedCheck?.startedAt || "")
      )
        return;
      if (
        JSON.stringify(checks) === JSON.stringify(this._homeModel.checks) &&
        JSON.stringify(latestStartedCheck) ===
          JSON.stringify(this._homeModel.latestStartedCheck)
      )
        return;
      // Use the latest model so a background response cannot undo local actions.
      this._renderHome({
        ...this._homeModel,
        checks,
        last: checks[0],
        latestStartedCheck,
      });
    } catch {
      // Retain the last confirmed list; refresh again on return or the next poll.
    } finally {
      this._checksRefreshing = false;
    }
  }

  _refreshActiveTab() {
    return import("../services/home-task-freshness.js")
      .then(({ refreshActiveTab }) => refreshActiveTab(this))
      .catch(() => {});
  }

  _refresh311Statuses() {
    if (
      !this.isConnected ||
      document.visibilityState === "hidden" ||
      !this._homeModel ||
      document.querySelector("dialog[open]")
    )
      return;
    void this._hydrate311CardStatuses(this._homeModel.tasks);
  }

  async _hydrate311CardStatuses(tasks) {
    const generation = ++this._311StatusGeneration;
    const requests = submitted311Requests(tasks);
    if (!requests.length) return;
    let response;
    try {
      response = await get311RequestDetails(requests);
    } catch {
      return;
    }
    if (generation !== this._311StatusGeneration || !this.isConnected) return;
    this._311StatusByTaskId = map311StatusResponse(response);
    if (this._homeModel) this._renderHome(this._homeModel);
  }

  /**
   * Adopt the state the outgoing home element stashed on unmount (see
   * lastHomeState) and paint its model immediately, before the data chain
   * resolves. Everything it adopts is re-derived or refetched below; this
   * exists so the route-transition snapshot shows a fully rendered screen.
   * @param {any} snapshot
   * @param {string | null} requestedFilter a `?filter=` that the arriving
   *   URL carries explicitly — deep links and direct navigations must show
   *   the tab they name, so it wins over the restored tab
   * @returns {void}
   */
  _restoreHomeState(snapshot, requestedFilter) {
    this._homeModel = snapshot.model;
    this._homeFilter = snapshot.homeFilter;
    // An explicit URL filter request wins over the restored tab; a plain
    // back-navigation carries none and keeps the tab that was on screen —
    // the URL is rewritten to match so a refresh stays on the same tab.
    if (requestedFilter) {
      this._homeFilter = normalizedHomeTab(requestedFilter);
    } else if (this._homeFilter) {
      const url = new URL(window.location.href);
      url.searchParams.set("filter", this._homeFilter);
      window.history.replaceState(window.history.state, "", url);
    }
    this._historyGrouping = snapshot.historyGrouping;
    this._taskOverrides = snapshot.taskOverrides;
    this._confirmedTasks = new Map(snapshot.confirmedTasks);
    this._hasPerimeterDraft = snapshot.hasPerimeterDraft;
    this._site = snapshot.site;
    this._siteId = snapshot.siteId;
    this._providerName = snapshot.providerName;
    this._providerSites = snapshot.providerSites;
    this._providerSitesStatus = snapshot.providerSitesStatus;
    this._boundSites = snapshot.boundSites;
    this._311StatusByTaskId = snapshot.task311Statuses;
    this._remainingStatus = snapshot.remainingStatus;
    this._remainingLoadedAt = snapshot.remainingLoadedAt;
    this._duplicateLinks = duplicateUiEnabled()
      ? new Map(snapshot.duplicateLinks ?? [])
      : new Map();
    this._renderHome(this._homeModel);
  }

  _renderHome(model) {
    if (this._confirmedTasks?.size)
      model = { ...model, tasks: this._reconcileConfirmedTasks(model.tasks) };
    // Worklist rows omit hydrated evidence; do not blank photos on each refresh.
    const previous = new Map(
      (this._homeModel?.tasks || []).map((task) => [task.taskId, task]),
    );
    const tasks = model.tasks.map((task) => {
      const old = previous.get(task.taskId);
      if (
        !old ||
        old.checkId !== task.checkId ||
        taskArtifactIds(old).join() !== taskArtifactIds(task).join()
      )
        return task;
      const cached = {};
      for (const key of [
        "evidence",
        "mediaUrl",
        "thumbnailUrl",
        "mediaExpiresAt",
        "mediaState",
        "mediaRetryAt",
      ])
        if (!task[key] && old[key]) cached[key] = old[key];
      return Object.keys(cached).length ? { ...task, ...cached } : task;
    });
    if (tasks.some((task, index) => task !== model.tasks[index]))
      model = { ...model, tasks };
    this._homeModel = model;
    this._watchQueued311(model.tasks);
    // Keep the native dialog and its action buttons mounted while a location
    // decision is pending. A background location update can otherwise replace
    // the open dialog with a closed one.
    if (this._locationPrompt) {
      this._pendingLocationRender = true;
      return;
    }
    // Same for a native dialog open in the home subtree (success, delete,
    // edit): the innerHTML swap would remove it unseen, orphaning its overlay
    // history entry and any close handler. The paint resumes on its `close`
    // (wired below) with whatever model arrived meanwhile.
    if (this.querySelector(":scope > .home dialog[open]")) {
      this._pendingDialogRender = true;
      return;
    }
    if (isDeletingAnalysisCard(this) || isCompletingAnalysisCard(this)) {
      this._deferredDeletionRender = true;
      return;
    }
    // Index tasks by id so card action handlers can read the task (e.g. its
    // action metadata) at click time.
    this._tasksById = new Map(model.tasks.map((t) => [t.taskId, t]));
    const markup = this._render(model);
    if (markup === this._homeMarkup && this.querySelector(":scope > .home"))
      return;
    this._homeMarkup = markup;
    this.innerHTML = markup;
    this._tabRefreshStatus?.();

    // Hand the bound site id to the feedback sheet so submissions carry it as
    // optional context (the server treats it as advisory, pattern-checked).
    const feedbackDialog = /** @type {any} */ (
      this.querySelector("feedback-dialog")
    );
    if (feedbackDialog) feedbackDialog.siteId = this._siteId;

    const grouping = this.querySelector("#history-grouping");
    if (grouping) {
      void import("./history-grouping.js");
    }
    grouping?.addEventListener("change", async () => {
      this._historyGrouping = /** @type {any} */ (grouping).value;
      this._renderHome(this._homeModel);
      const replacement =
        /** @type {HTMLElement & { updateComplete?: Promise<boolean> }} */ (
          this.querySelector("#history-grouping")
        );
      await replacement?.updateComplete;
      if (replacement?.isConnected) replacement.focus({ preventScroll: true });
    });
    const start = this.querySelector("#start-check");
    if (start) {
      // Routed capture: the check screen (routed variant) owns the flow from
      // here; the draft session machinery is unchanged.
      start.addEventListener("click", (event) =>
        this._startCapture("perimeter", event.currentTarget),
      );
    }
    this.querySelector("#home-settings")?.addEventListener("click", () =>
      this._toggleSettingsMenu(),
    );
    this._mountSiteSwitcher();
    this.querySelector("#lastlog-change-site")?.addEventListener(
      "click",
      () => {
        this._siteSwitcher?.setOpen(true);
      },
    );
    this.querySelector("#settings-logout")?.addEventListener("click", () => {
      // Count first: logging out deletes work that hasn't uploaded yet.
      void countUnsentWork()
        .catch(() => ({}))
        .then((unsent) => {
          this._logoutUnsent = unsent;
          this._settingsMenuOpen = false;
          this._logoutDialogOpen = true;
          this._renderHome(this._homeModel);
        });
    });
    this.querySelector("#settings-help")?.addEventListener("click", () => {
      this._settingsMenuOpen = false;
      navigate("/help");
    });
    this.querySelector("#settings-feedback")?.addEventListener("click", () => {
      this._removeSettingsMenu();
      feedbackDialog?.open();
    });
    this.querySelector("#settings-attributions")?.addEventListener(
      "click",
      () => {
        this._removeSettingsMenu();
        this._attributionsDialogOpen = true;
        openOverlayDialog(
          /** @type {HTMLDialogElement} */ (this._attributionsDialog),
          "attributions",
        );
      },
    );
    this.querySelector("#settings-language")?.addEventListener("click", () => {
      this._removeSettingsMenu();
      this._languageDialogOpen = true;
      openOverlayDialog(
        /** @type {HTMLDialogElement} */ (this._languageDialog),
        "language",
      );
    });
    this.querySelector("#settings-access")?.addEventListener("click", () =>
      navigate("/manage-access"),
    );
    this.querySelector("#settings-site-admin")?.addEventListener("click", () =>
      navigate("/site-admin"),
    );
    this.querySelector("#settings-reports")?.addEventListener("click", () =>
      navigate("/reports"),
    );
    this._languageDialog = /** @type {HTMLDialogElement | null} */ (
      this.querySelector(":scope > .home > #language-dialog")
    );
    this._languageDialog?.addEventListener("click", (event) => {
      if (event.target === this._languageDialog) this._languageDialog.close();
    });
    this._languageDialog?.addEventListener("close", () => {
      this._languageDialogOpen = false;
      const chosen = this._languageDialog?.returnValue || "";
      if (this._languageDialog) this._languageDialog.returnValue = "";
      if (chosen && chosen !== getLocale()) {
        // app-root re-renders the view on "localechange". A failed catalog
        // load (offline first use of a language) changes nothing; say so.
        void setLocale(chosen).then((ok) => {
          if (!ok) showLanguageErrorToast();
        });
        return;
      }
      /** @type {HTMLElement | null} */ (
        this.querySelector("#home-settings")
      )?.focus();
    });
    this._attributionsDialog = /** @type {HTMLDialogElement | null} */ (
      this.querySelector(":scope > .home > #attributions-dialog")
    );
    this._attributionsDialog?.addEventListener("click", (event) => {
      if (event.target === this._attributionsDialog) {
        this._attributionsDialog.close();
      }
    });
    this._attributionsDialog?.addEventListener("close", () => {
      this._attributionsDialogOpen = false;
      /** @type {HTMLElement | null} */ (
        this.querySelector("#home-settings")
      )?.focus();
    });
    this._logoutDialog = /** @type {HTMLDialogElement | null} */ (
      this.querySelector(":scope > .home > #logout-dialog")
    );
    this._logoutDialog?.addEventListener("click", (event) => {
      if (event.target === this._logoutDialog) this._logoutDialog.close();
    });
    this._logoutDialog?.addEventListener("close", () => {
      this._logoutDialogOpen = false;
    });
    this._restoreLogoutDialog();
    this._restoreAttributionsDialog();
    this._restoreLanguageDialog();
    this._taskSheets().mount();
    this._mountLocationDialog();
    this.querySelector("#logout-confirm")?.addEventListener("click", () =>
      this._logout(),
    );
    const report = this.querySelector("#report-problem");
    if (report) {
      report.addEventListener("click", (event) =>
        this._startCapture("single-problem", event.currentTarget),
      );
    }
    const actionMenuTrigger = /** @type {HTMLButtonElement | null} */ (
      this.querySelector("#home-action-menu-trigger")
    );
    const actionMenu = /** @type {HTMLElement | null} */ (
      this.querySelector("#home-action-menu")
    );
    actionMenuTrigger?.addEventListener("click", () => {
      const opening = actionMenu.hidden;
      actionMenu.hidden = !opening;
      actionMenuTrigger.setAttribute("aria-expanded", String(opening));
      if (opening)
        /** @type {HTMLElement | null} */ (
          actionMenu.querySelector('[role="menuitem"]')
        )?.focus();
    });
    // One document-level click closer per element, added once: a re-render
    // replaces the menu's nodes, so the stable handler resolves the live
    // menu + trigger at click time (the old render-scoped closure would
    // keep firing against the detached nodes after every re-render).
    if (!this._actionMenuDocumentClick) {
      this._actionMenuDocumentClick = /** @param {Event} event */ (event) => {
        const menu = /** @type {HTMLElement | null} */ (
          this.querySelector("#home-action-menu")
        );
        const trigger = /** @type {HTMLElement | null} */ (
          this.querySelector("#home-action-menu-trigger")
        );
        if (!menu?.isConnected || menu.hidden) return;
        const path = event.composedPath?.() || [];
        if (path.includes(trigger) || path.includes(menu)) return;
        menu.hidden = true;
        trigger?.setAttribute("aria-expanded", "false");
      };
      document.addEventListener("click", this._actionMenuDocumentClick);
    }
    actionMenu?.addEventListener("keydown", (event) => {
      const keyEvent = /** @type {KeyboardEvent} */ (event);
      const items = /** @type {HTMLElement[]} */ ([
        ...actionMenu.querySelectorAll('[role="menuitem"]'),
      ]);
      const index = items.indexOf(
        /** @type {HTMLElement} */ (document.activeElement),
      );
      if (keyEvent.key === "Escape") {
        actionMenu.hidden = true;
        actionMenuTrigger.setAttribute("aria-expanded", "false");
        actionMenuTrigger.focus();
      }
      if (keyEvent.key === "ArrowDown" || keyEvent.key === "ArrowUp") {
        event.preventDefault();
        const delta = keyEvent.key === "ArrowDown" ? 1 : -1;
        items[(index + delta + items.length) % items.length]?.focus();
      }
    });
    this.querySelector("#view-care-work")?.addEventListener("click", () =>
      navigate("/care-work"),
    );
    this.querySelector("#view-complaints")?.addEventListener("click", () =>
      navigate("/complaints"),
    );
    this.querySelectorAll("[data-start-capture='single-problem']").forEach(
      (control) => {
        control.addEventListener("click", (event) => {
          event.preventDefault();
          this._startCapture("single-problem", event.currentTarget);
        });
      },
    );
    this.querySelectorAll(
      ".analysis-card__clear-copy a[href='/problem']",
    ).forEach((control) => {
      control.addEventListener("click", (event) => {
        event.preventDefault();
        void this._startCapture("single-problem", control);
      });
    });
    this.querySelector("#retry-guidance")?.addEventListener("click", () => {
      void this.connectedCallback();
    });
    this.querySelector("#retry-remaining")?.addEventListener("click", () =>
      this._retryRemaining(),
    );
    this.querySelectorAll("[data-home-filter]").forEach((button) => {
      button.addEventListener("click", () => {
        this._activateHomeTab(
          button.getAttribute("data-home-filter") || "todo",
        );
      });
      button.addEventListener("keydown", (event) => {
        const key = /** @type {KeyboardEvent} */ (event).key;
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(key)) {
          return;
        }
        event.preventDefault();
        const currentIndex = HOME_TABS.findIndex(
          ({ id }) => id === this._homeFilter,
        );
        const nextIndex =
          key === "Home"
            ? 0
            : key === "End"
              ? HOME_TABS.length - 1
              : (currentIndex +
                  (key === "ArrowRight" ? 1 : -1) +
                  HOME_TABS.length) %
                HOME_TABS.length;
        this._activateHomeTab(HOME_TABS[nextIndex].id);
      });
    });
    this._analysisDeleteDialog = /** @type {HTMLDialogElement | null} */ (
      this.querySelector(":scope > .home > #analysis-delete-dialog")
    );
    this._analysisSuccessDialog = /** @type {HTMLDialogElement | null} */ (
      this.querySelector(":scope > .home > #analysis-success-dialog")
    );
    this._analysisEditDialog = /** @type {HTMLDialogElement | null} */ (
      this.querySelector(":scope > .home > #analysis-edit-dialog")
    );
    this._analysisEditDescription = /** @type {HTMLTextAreaElement | null} */ (
      this.querySelector(
        ":scope > .home > #analysis-edit-dialog #analysis-edit-description",
      )
    );
    this.querySelector(
      ":scope > .home > #analysis-delete-dialog #analysis-delete-confirm",
    )?.addEventListener("click", () => this._confirmDeleteProblem());
    this.querySelector(
      ":scope > .home > #analysis-edit-dialog #analysis-edit-save",
    )?.addEventListener("click", () => this._saveProblemEdit());
    this.querySelectorAll(":scope > .home > .analysis-dialog").forEach(
      (dialog) => {
        dialog.addEventListener("click", (e) => {
          if (e.target === dialog) {
            /** @type {HTMLDialogElement} */ (dialog).close();
          }
        });
        dialog.addEventListener("close", () => this._flushDialogRender());
      },
    );
    this._wireCards();
    this._applyBusyCards();
    for (const conditionId of this._answeringConditionIds) {
      setQuestionAnswerBusy(this, conditionId, true);
    }

    this._restoreFocusAfterRender();
    const requestedIssue = new URLSearchParams(window.location.search).get(
      "issue",
    );
    if (
      requestedIssue &&
      requestedIssue !== this._focusedIssueId &&
      this._focusIssueCard(requestedIssue)
    )
      this._focusedIssueId = requestedIssue;
  }

  async _hydrateVisibleHomeTasks() {
    const model = this._homeModel;
    if (!model) return;
    const hydrationGeneration = ++this._hydrationGeneration;
    const visibleTasks = visibleTaskEntriesForHydration(
      this._homeTasks(model.tasks),
      this._homeFilter,
    )
      .map((entry) => entry.task)
      .filter((task) => needsTaskEvidenceHydration(task));
    if (!visibleTasks.length) return;

    const hydratedTasks = await hydrateTaskEvidence(uniqueTasks(visibleTasks));
    if (
      hydrationGeneration !== this._hydrationGeneration ||
      !this.isConnected ||
      this._homeModel !== model
    ) {
      return;
    }
    const tasks = mergeHydratedTasks(model.tasks, hydratedTasks);
    this._sheets?.updateTask(
      tasks.find((task) => task.taskId === this._sheets?.ticketTaskId),
    );
    this._renderHome({ ...model, tasks });
  }

  _render({
    last,
    checks = [],
    tasks,
    pendingSession,
    latestStartedCheck,
    pendingQuestions = [],
  }) {
    const allRecentItems = pendingSession
      ? this._sessionItems(pendingSession)
      : [];
    const taskArtifactIds = taskArtifactIdSet(tasks);
    const localRecentItems = allRecentItems.filter((item) => {
      const artifactId = item.analysis?.artifactId || item.upload?.artifactId;
      if (item.analysis?.status === "analyzed") {
        return (
          !hasProblemResults(item) ||
          !sessionProblemItemHasBackendCards(item, tasks)
        );
      }
      return !taskArtifactIds.has(artifactId);
    });
    const recentItems = mergePendingQuestionItems(
      localRecentItems,
      pendingQuestions,
      tasks,
    );
    const homeTasks = this._homeTasks(tasks);
    const taskCheckIds = new Set(
      homeTasks.map((entry) => taskCheckGroupId(entry.task)),
    );
    const clearChecks = checks.filter(
      (check) =>
        check.status === "submitted" &&
        Number(check.issueCount) === 0 &&
        !taskCheckIds.has(check.id),
    );
    const newestCheck = newestBlueCheckGroup(homeTasks, checks, pendingSession);
    const selectedTaskEntries = newestTaskEntriesFirst(
      homeTasks.filter(
        (entry) => homeTabForStatus(entry.homeStatus) === this._homeFilter,
      ),
    );
    const tabCounts = {
      todo: recentItems.reduce(
        (count, item) =>
          count +
          (item.analysis?.conditions || []).filter(
            (condition) => condition.needsAnswer,
          ).length,
        0,
      ),
      in_progress: 0,
      history: 0,
    };
    for (const entry of homeTasks) {
      const tab = homeTabForStatus(entry.homeStatus);
      if (tab === "history" && needsResolutionProof(entry.task))
        tabCounts.history += 1;
      if (tab === "todo") tabCounts.todo += 1;
      if (
        tab === "in_progress" &&
        ["cityClosed", "old", "overdue"].includes(
          statusTicker(this._taskWith311CardStatus(entry.task)).key,
        )
      )
        tabCounts.in_progress += 1;
    }
    const newTaskEntries = selectedTaskEntries.filter(
      (entry) =>
        this._homeFilter !== "history" &&
        taskCheckGroupId(entry.task) === newestCheck.id,
    );
    const visibleTasks = selectedTaskEntries.filter(
      (entry) =>
        this._homeFilter === "history" ||
        taskCheckGroupId(entry.task) !== newestCheck.id,
    );
    const latestSubmittedCheck = [...checks].sort((a, b) =>
      String(b.submittedAt || b.startedAt || "").localeCompare(
        String(a.submittedAt || a.startedAt || ""),
      ),
    )[0];
    const activeClearCheck =
      Number(latestSubmittedCheck?.issueCount) === 0
        ? clearChecks.find((check) => check.id === latestSubmittedCheck.id) ||
          null
        : null;
    const hasPendingAssessment = !!pendingSession;
    const pendingHasTaskCards = homeTasks.some(
      (entry) => entry.task.checkId === pendingSession?.id,
    );
    let displayRecentItems = pendingHasTaskCards
      ? recentItems.filter(
          (item) =>
            item.analysis?.status !== "analyzed" || hasProblemResults(item),
        )
      : recentItems;
    const latestCheck = latestStartedCheck || latestSubmittedCheck;
    const pendingSuperseded =
      latestCheck &&
      pendingSession &&
      latestCheck.id !== pendingSession.id &&
      String(latestCheck.startedAt || latestCheck.submittedAt || "") >
        String(pendingSession.submittedAt || pendingSession.startedAt || "");
    if (
      pendingSuperseded &&
      displayRecentItems.every(
        (item) =>
          item.analysis?.status === "analyzed" && !hasProblemResults(item),
      )
    )
      displayRecentItems = [];
    const visibleRecentItems =
      this._homeFilter === "todo" ? displayRecentItems : [];
    const hasPendingClearResult =
      this._homeFilter === "todo" &&
      !pendingSuperseded &&
      displayRecentItems.length > 0 &&
      displayRecentItems.every(
        (item) =>
          item.analysis?.status === "analyzed" && !hasProblemResults(item),
      );
    // A submitted check supersedes the prior result before analysis finishes.
    const newerSubmission =
      pendingSession &&
      pendingSession.id !== activeClearCheck?.id &&
      String(pendingSession.submittedAt || pendingSession.startedAt || "") >=
        String(
          activeClearCheck?.submittedAt || activeClearCheck?.startedAt || "",
        );
    const showActiveClearTray =
      this._homeFilter === "todo" &&
      Boolean(activeClearCheck) &&
      !hasPendingClearResult &&
      !newerSubmission &&
      !(
        latestStartedCheck &&
        latestStartedCheck.id !== activeClearCheck?.id &&
        String(latestStartedCheck.startedAt || "") >
          String(
            activeClearCheck?.startedAt || activeClearCheck?.submittedAt || "",
          )
      );
    const hasResultCards =
      recentItems.length || homeTasks.length || clearChecks.length;
    // First-run hero only for a truly empty account: no submitted check, no
    // worklist, no in-review session results.
    const showFirstRun = !last && tasks.length === 0 && !hasResultCards;

    return homeShell({
      settingsMenuOpen: this._settingsMenuOpen,
      adminAccess: hasAdminAccess(this._site),
      // The visible tab's list is still loading (In-progress / History
      // before the second data tier lands).
      busy:
        this._homeFilter !== "todo" &&
        (this._remainingStatus || "loaded") === "pending",
      hero: showFirstRun
        ? this._firstRunBlock()
        : this._activityBlock({ last, homeTasks }),
      results: this._homeResults({
        pendingSession,
        tabCounts,
        recentCheckTime: recentItems.some(
          (item) => item.checkId && item.checkId !== newestCheck.id,
        )
          ? ""
          : newestCheck.time ||
            pendingSession?.startedAt ||
            last?.submittedAt ||
            "",
        checks,
        recentItems: visibleRecentItems,
        newTaskEntries,
        visibleTasks,
        activeClearCheck,
        hasPendingClearResult,
        showActiveClearTray,
      }),
      showAnalysisDialogs: Boolean(hasPendingAssessment || hasResultCards),
      logoutError: this._logoutError,
      logoutPending: this._logoutPending,
      logoutUnsent: this._logoutUnsent,
    });
  }

  // Close in place so the dialog about to open keeps its mounted element.
  // This DOM edit invalidates the last rendered markup, even if opening the
  // menu again would produce exactly the same string as the previous render.
  _removeSettingsMenu() {
    this._settingsMenuOpen = false;
    this._homeMarkup = null;
    this.querySelector(".home-settings-menu")?.remove();
    this.querySelector("#home-settings")?.setAttribute(
      "aria-expanded",
      "false",
    );
  }

  _toggleSettingsMenu() {
    this._settingsMenuOpen = !this._settingsMenuOpen;
    if (this._homeModel) this._renderHome(this._homeModel);
  }

  _taskSheets() {
    if (!this._sheets) {
      this._sheets = new TaskSheets({
        host: this,
        container: () => this.querySelector(":scope > .home"),
        resolveTask: (task) => this._tasksById.get(task.taskId) || task,
        onTaskUpdated: (task) => {
          if (task.status === "completed") {
            this._confirmedTasks ??= new Map();
            this._confirmedTasks.set(task.taskId, task);
          }
          this._applyTaskResult(task.taskId, task);
          if (this._homeModel) this._renderHome(this._homeModel);
        },
        reload: () => this.connectedCallback(),
        fallbackFocus: () => this.querySelector(".home-tabs__tab--active"),
      });
    }
    this._sheets.site = this._site;
    return this._sheets;
  }

  _open311Detail(task, trigger) {
    this._taskSheets().open311(task, trigger);
  }

  async _openTaskUpdate(task, trigger) {
    await this._taskSheets().openUpdates(task, trigger);
  }

  _closeSettingsMenu() {
    if (!this._settingsMenuOpen) return;
    this._settingsMenuOpen = false;
    if (this._homeModel) this._renderHome(this._homeModel);
  }

  _restoreLogoutDialog() {
    if (!this._logoutDialogOpen || this._logoutDialog?.open) return;
    openOverlayDialog(
      /** @type {HTMLDialogElement} */ (this._logoutDialog),
      "logout",
    );
  }

  _restoreAttributionsDialog() {
    if (!this._attributionsDialogOpen || this._attributionsDialog?.open) return;
    openOverlayDialog(
      /** @type {HTMLDialogElement} */ (this._attributionsDialog),
      "attributions",
    );
  }

  _restoreLanguageDialog() {
    if (!this._languageDialogOpen || this._languageDialog?.open) return;
    openOverlayDialog(
      /** @type {HTMLDialogElement} */ (this._languageDialog),
      "language",
    );
  }

  async _logout() {
    if (this._logoutPending) return;
    this._logoutPending = true;
    this._logoutError = "";
    if (this._homeModel) this._renderHome(this._homeModel);
    try {
      // Before the session goes: retire the Home Screen handoff grant and
      // put the static manifest back (services/session-handoff.js).
      await retireHandoff();
      await clearSiteSession();
      discardInMemorySession();
      this._logoutDialogOpen = false;
      window.dispatchEvent(new CustomEvent("authsignout"));
    } catch {
      this._logoutPending = false;
      this._logoutError = t("today.logout.error");
      if (this._homeModel) this._renderHome(this._homeModel);
    }
  }

  _homeResults({
    pendingSession,
    tabCounts,
    recentCheckTime,
    checks,
    recentItems,
    newTaskEntries,
    visibleTasks,
    activeClearCheck,
    hasPendingClearResult,
    showActiveClearTray,
  }) {
    const newTaskCards = this._newTaskCardEntries(newTaskEntries);
    const remainingStatus = /** @type {"pending" | "loaded" | "error"} */ (
      this._remainingStatus || "loaded"
    );
    return homeResults({
      historyGrouping: this._historyGrouping || "resolved",
      homeFilter: this._homeFilter,
      // Counts only once every list is in — a partial count would be wrong.
      tabCounts:
        remainingStatus === "loaded"
          ? this._homeModel?.pendingGuidanceFailed
            ? { in_progress: tabCounts.in_progress, history: tabCounts.history }
            : tabCounts
          : {},
      pendingGuidanceFailed: Boolean(this._homeModel?.pendingGuidanceFailed),
      remainingStatus: this._tabListStatus?.() || remainingStatus,
      siteName: this._site?.name || "",
      siteAddress: this._site?.address || "",
      pendingSessionId: pendingSession?.id || "",
      hasPendingSession: Boolean(pendingSession),
      recentCheckTime,
      recentItems,
      newTaskCards,
      newTaskCardsMarkup: sortAnalysisCards([...newTaskCards])
        .map((card) => card.markup)
        .join(""),
      newTaskCount: newTaskEntries.length,
      counts: duplicateCounts(newTaskEntries.map((e) => e.task)),
      activeClearCheck,
      hasPendingClearResult,
      showActiveClearTray,
      historyGroups: this._historyGroups(visibleTasks, checks),
    });
  }

  _newTaskCardEntries(entries) {
    return entries.map((entry) => this._taskCardEntry(entry, true));
  }

  _taskCardEntry(entry, isNew) {
    return {
      markup: taskAnalysisCard({
        history: ["resolved", "archived"].includes(entry.homeStatus),
        task: this._taskWith311CardStatus({
          ...entry.task,
          createdAt: entry.createdAt,
          siteAddress: entry.task.siteAddress || this._site?.address || "",
        }),
        siteName: this._site?.name || "",
        action:
          entry.homeStatus === "needs_action" ||
          (entry.homeStatus === "in_progress" && entry.task.status === "open")
            ? this._primaryCardAction(entry.task)
            : entry.homeStatus === "in_progress"
              ? canRetry311Filing(entry.task)
                ? {
                    kind: "file311",
                    label: t("today.action.retryFiling"),
                    variant: "blue",
                  }
                : {
                    kind: "update",
                    label: t("card.viewUpdates"),
                    variant: "outline",
                  }
              : null,
        statusLabel: isNew
          ? this._newTaskStatusMeta(entry)
          : this._taskStatusMeta(entry),
        isNew,
        includeControls: entry.homeStatus === "needs_action",
      }),
      createdAt: entry.createdAt,
      isDuplicate: Boolean(entry.task.duplicate),
      needsAnswer: Boolean(entry.task.needsAnswer),
      actionPriority: analysisActionPriority(entry.task),
    };
  }

  // Active work stays grouped by check; History uses the selected grouping.
  // History contains issues only.
  _historyGroups(entries, checks, clearChecks = []) {
    if (this._homeFilter === "history") {
      const groups = groupHistory(
        entries,
        this._historyGrouping || "resolved",
      ).map((group) => ({
        dateKey: group.key,
        title: group.title,
        checkTime: "",
        compact: true,
        cards: group.entries
          .map((entry) => this._taskCardEntry(entry, false).markup)
          .join(""),
      }));
      return groups;
    }
    const checkTimes = new Map(
      checks.map((check) => [check.id, check.submittedAt || check.startedAt]),
    );
    const groups = new Map();
    for (const entry of entries) {
      const checkId = taskCheckGroupId(entry.task);
      if (!groups.has(checkId)) groups.set(checkId, []);
      groups.get(checkId).push(entry);
    }
    for (const check of clearChecks) {
      if (!groups.has(check.id)) groups.set(check.id, []);
    }
    return [...groups.entries()]
      .sort((a, b) => {
        const aTime = checkTimes.get(a[0]) || a[1][0]?.createdAt || "";
        const bTime = checkTimes.get(b[0]) || b[1][0]?.createdAt || "";
        return String(bTime).localeCompare(String(aTime));
      })
      .map(([checkId, group]) => ({
        checkTime: checkTimes.get(checkId) || group[0]?.createdAt || new Date(),
        counts: duplicateCounts(group.map((e) => e.task)),
        cards: sortAnalysisCards(
          group.map((entry) => this._taskCardEntry(entry, false)),
        )
          .map((card) => card.markup)
          .join(""),
      }));
  }

  async _startCapture(flowType, launcher = null) {
    if (this._startingCapture) return;
    this._startingCapture = true;
    try {
      const position = await getSiteCheckDeviceLocation();
      if (!position) {
        console.warn(
          `[location] No usable device location when starting ${flowType === "single-problem" ? "a single issue" : "a full check"}; site proximity check skipped.`,
        );
      }
      if (isOutsideSiteRadius(position, this._site?.location)) {
        this._locationPrompt = { flowType, launcher };
        this._showLocationDialog();
        return;
      }
      this._enterCaptureRoute(flowType);
    } finally {
      this._startingCapture = false;
    }
  }

  _enterCaptureRoute(flowType) {
    // Routed capture: navigate so the flow has a real URL. The routed
    // component bootstraps itself (resume-or-start) from IndexedDB on
    // connect; today-view keeps no capture phase state.
    navigate(flowType === "single-problem" ? "/problem" : "/check");
  }

  _scrollCaptureStartIntoView() {
    const scrollingElement =
      document.scrollingElement || document.documentElement || document.body;
    if (scrollingElement) {
      scrollingElement.scrollTop = 0;
      scrollingElement.scrollLeft = 0;
    }
    try {
      window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    } catch {
      window.scrollTo(0, 0);
    }
  }

  _isStalePendingSession(session, submitted, tasks) {
    return isStalePendingSession(session, submitted, tasks);
  }

  _firstRunBlock() {
    return this._activityBlock({ last: null, homeTasks: [] });
  }

  /**
   * Pre-data paint (see connectedCallback). Markup only — no handlers are
   * wired, nothing here is interactive, and the live render replaces it.
   * @param {string | null} requestedFilter the ?filter= query value
   */
  _renderSkeleton(requestedFilter) {
    this._homeFilter =
      this._homeFilter || normalizedHomeTab(requestedFilter || "");
    this.innerHTML = homeSkeleton({
      siteName: this._siteIdentity().site,
      adminAccess: hasAdminAccess(this._site),
      homeFilter: this._homeFilter,
      checkLabel: t("today.actions.startCheck"),
    });
    // The skeleton's tabs are live: a tap selects the tab the worklist will
    // open on. Delegated on the host (the markup has no handlers of its
    // own) and inert once the live render has wired the real tabs.
    if (!this._skeletonTabClick) {
      this._skeletonTabClick = (event) => {
        if (this._homeModel) return;
        const tab = /** @type {Element | null} */ (
          /** @type {any} */ (event.target)?.closest?.("[data-home-filter]")
        );
        if (!tab) return;
        this._homeFilter = normalizedHomeTab(
          tab.getAttribute("data-home-filter") || "todo",
        );
        this._renderSkeleton(null);
      };
      this.addEventListener("click", this._skeletonTabClick);
    }
  }

  _activityBlock({ last, homeTasks }) {
    const identity = this._siteIdentity();
    return heroBlock({
      siteName: identity.site,
      summary: this._summaryBlock(last, homeTasks),
      checkLabel: this._checkActionLabel(),
    });
  }

  _checkActionLabel() {
    return this._hasPerimeterDraft
      ? t("today.actions.resumeCheck")
      : t("today.actions.startCheck");
  }

  async _retryProviderSites() {
    if (this._providerSitesStatus === "loading") return;
    const requestedSiteId = this._siteId;
    this._providerSitesStatus = "loading";
    if (this._homeModel) this._renderHome(this._homeModel);
    try {
      const catalog = await fetchProviderSites();
      if (requestedSiteId !== this._siteId) return;
      this._providerSites = catalog.sites;
      this._providerName =
        catalog.providerName || this._site?.providerName || "";
      this._providerSitesStatus = "loaded";
    } catch (error) {
      console.error("listProviderSites retry failed", error);
      this._providerSitesStatus = "error";
      showSiteCatalogErrorToast();
    } finally {
      if (requestedSiteId === this._siteId && this._homeModel) {
        this._renderHome(this._homeModel);
      }
    }
  }

  _siteIdentity() {
    const org =
      this._providerName ||
      (this._site &&
        (this._site.providerName ||
          this._site.orgName ||
          this._site.organizationName)) ||
      "";
    const name = (this._site && this._site.name) || t("today.site.fallback");
    if (org) return { org, site: name };
    return splitSiteIdentity(name) || { org: "", site: name };
  }

  _mountSiteSwitcher() {
    if (!this._siteSwitcher) {
      const switcher = document.createElement("site-switcher");
      switcher.addEventListener("switchsite", (event) => {
        void this._switchToSite(
          /** @type {CustomEvent} */ (event).detail.siteId || "",
        );
      });
      switcher.addEventListener("retrysites", () => {
        void this._retryProviderSites();
      });
      this._siteSwitcher = switcher;
    }
    const switcher = this._siteSwitcher;
    switcher.providerName = this._siteIdentity().org;
    switcher.sites = this._providerSites;
    switcher.currentSite = { siteId: this._siteId, name: this._site?.name };
    switcher.status = this._providerSitesStatus;
    // Swapping the same instance in for the placeholder keeps its open state
    // across innerHTML replacement.
    this.querySelector(":scope > .home site-switcher")?.replaceWith(switcher);
  }

  _mountLocationDialog() {
    if (!this._locationDialog) {
      const dialog = document.createElement("location-dialog");
      dialog.addEventListener("locationclosed", (event) =>
        this._onLocationDialogClosed(/** @type {CustomEvent} */ (event).detail),
      );
      dialog.addEventListener("locationconfirm", (event) => {
        void this._switchToSite(
          /** @type {CustomEvent} */ (event).detail.siteId || "",
        );
      });
      dialog.addEventListener("locationstay", (event) =>
        this._onLocationStay(/** @type {CustomEvent} */ (event).detail),
      );
      this._locationDialog = dialog;
    }
    const dialog = this._locationDialog;
    dialog.siteName = this._site?.name || t("today.site.thisSite");
    dialog.sites = this._providerSites;
    dialog.currentSite = {
      siteId: this._siteId,
      name: this._site?.name || t("today.site.fallback"),
    };
    this.querySelector(":scope > .home location-dialog")?.replaceWith(dialog);
  }

  _showLocationDialog() {
    this._locationDialog?.open(this._locationPrompt);
  }

  /**
   * The prompt closed (Stay, Confirm, Escape, backdrop). A home render that
   * was deferred while it was open runs now, unless a site switch is about
   * to replace the page anyway.
   * @param {{ changingSite: boolean }} detail
   */
  /** A home dialog closed: paint whatever `_renderHome` held while it was open. */
  _flushDialogRender() {
    if (!this._pendingDialogRender) return;
    this._pendingDialogRender = false;
    if (this._homeModel) this._renderHome(this._homeModel);
  }

  _onLocationDialogClosed({ changingSite }) {
    this._locationPrompt = null;
    if (this._pendingLocationRender) {
      this._pendingLocationRender = false;
      if (!changingSite && this._homeModel) {
        this._renderHome(this._homeModel);
      }
    }
  }

  /** @param {{ prompt: { flowType: string, launcher: EventTarget | null } | null }} detail */
  async _onLocationStay({ prompt }) {
    // The user explicitly confirmed the bound site is correct. Rechecking the
    // same out-of-radius fix here would immediately reopen the prompt.
    if (!prompt) return;
    await awaitOverlayUnwind("location");
    this._enterCaptureRoute(prompt.flowType);
  }

  async _requestAnotherSite(mode = "code", siteId = "", siteName = "") {
    const active = getCurrentCheck();
    if (active?.status === "capture-complete") {
      showSiteSwitchBlockedToast();
      return;
    }
    try {
      if (active) await pauseCheck();
      discardInMemorySession();
      this._siteSwitcher?.close();
      this.dispatchEvent(
        new CustomEvent("siterequested", {
          bubbles: true,
          detail: { siteId, siteName, mode },
        }),
      );
    } catch (error) {
      console.error("site switch preparation failed", error);
      showSiteSwitchErrorToast();
    }
  }

  async _switchToSite(siteId) {
    // The bindings read failed at load (kept as null, not an empty list):
    // retry it now rather than offer enrollment for a site that is bound.
    if (!this._boundSites) {
      this._boundSites = await listBoundSites().catch((error) => {
        console.error("listBoundSites failed", error);
        return null;
      });
      if (!this._boundSites) {
        showSiteCatalogErrorToast();
        return;
      }
    }
    const outcome = await switchToBoundSite({
      siteId,
      currentSiteId: this._siteId,
      boundSites: this._boundSites,
      destination: "/today",
    });
    if (outcome === "same") {
      this._siteSwitcher?.close();
      return;
    }
    if (outcome === "needs-binding") {
      const target = this._providerSites.find((site) => site.siteId === siteId);
      await this._requestAnotherSite("code", siteId, target?.name || "");
    }
  }

  _summaryBlock(last, homeTasks) {
    return summaryBlock({
      outsideRadius: isOutsideSiteRadius(
        this._deviceLocation,
        this._site?.location,
      ),
      label: lastLogSummary(last, homeTasks),
    });
  }

  _sessionItems(session) {
    return Array.isArray(session?.items) ? session.items : [];
  }

  _homeTasks(tasks) {
    // Repair overrides left by older clients before duplicate separation.
    const separated = tasks.filter(
      (task) =>
        task.status === "open" &&
        this._duplicateLinks?.get(task.taskId)?.state === "separated",
    );
    if (separated.length)
      this._taskOverrides = repairSeparatedTaskStatusOverrides(
        ...separated.map((task) => task.taskId),
      );
    const now = new Date();
    return projectDuplicateTasks(tasks, this._duplicateLinks)
      .filter((task) => !isTaskPendingDeletion(task))
      .map((task) => ({
        task,
        createdAt: taskCreatedAt(task),
        homeStatus: homeTaskStatus(
          task,
          this._taskOverrides?.[task.taskId],
          now,
        ),
        isNew: isNewHomeTask(task, this._taskOverrides?.[task.taskId], now),
      }));
  }

  _activateHomeTab(tabId) {
    this._homeFilter = normalizedHomeTab(tabId);
    const url = new URL(window.location.href);
    url.searchParams.set("filter", this._homeFilter);
    window.history.replaceState(window.history.state, "", url);
    this._focusAfterRender = "home-tab-current";
    if (this._homeModel) {
      this._renderHome(this._homeModel);
      void this._hydrateVisibleHomeTasks();
      this._refresh311Statuses();
      void this._refreshActiveTab();
    }
  }

  _restoreFocusAfterRender() {
    const target = this._focusAfterRender;
    this._focusAfterRender = null;
    if (!target) return;
    const selector = this._focusSelector(target);
    window.requestAnimationFrame(() => {
      const element = selector ? this.querySelector(selector) : null;
      if (element instanceof HTMLElement) element.focus();
    });
  }

  _focusSelector(target) {
    if (target === "home-tab-current") return ".home-tabs__tab--active";
    if (target === "capture-heading") {
      return ".check-timeline__title, .single-issue__title, .home-region--capture button";
    }
    if (target === "home-primary-control") {
      return "#start-check, #report-problem, .screen--today-hero h1";
    }
    return target;
  }

  _primaryCardAction(task) {
    return this._cardActions(task)[0] || null;
  }

  _taskStatusMeta(entry) {
    const createdAt = taskCreatedAt(entry.task);
    const when = createdAt
      ? t("today.card.when", {
          day: relativeDay(createdAt),
          time: timeOf(createdAt),
        })
      : t("today.card.existing");
    const id = displayTaskId(entry.task);
    return id ? t("today.card.meta", { when, id }) : when;
  }

  _newTaskStatusMeta(entry) {
    const id = displayTaskId(entry.task);
    return id ? t("today.card.newMeta", { id }) : t("card.meta.new");
  }

  // Resolve a task's persisted actions into the concrete controls this screen
  // renders. Driven by the task's STRUCTURED `appActions` (create_311_ticket /
  // compose_email / …) paired with its `buttons` labels —
  // NOT by string-matching the label. Falls back to a sensible per-type default
  // when a task carries neither, and always offers the task's allowlisted
  // resolutions when present, so every card is actionable and closeable.
  _cardActions(task) {
    const buttons = Array.isArray(task.buttons) ? task.buttons : [];
    const appActions = Array.isArray(task.appActions) ? task.appActions : [];
    const actions = [];
    const count = Math.max(buttons.length, appActions.length);
    for (let i = 0; i < count; i++) {
      const label = buttons[i] != null ? String(buttons[i]) : "";
      const a = this._resolveAction(appActions[i], label);
      if (a) actions.push(a);
    }
    if (!actions.length) {
      actions.push({
        kind: "done",
        label: t("common.done"),
        variant: "ink",
      });
    }
    return actions;
  }

  // Map one persisted app action (+ its display label) to a rendered control.
  // Returns null for actions with no wired behavior yet (fire-hazard report,
  // generic manual steps) — they always co-occur with a call/311 action, so the
  // card stays actionable without rendering a dead button.
  // `storedLabel` is the English rulebook string persisted on the task: the
  // label-shape checks below run against it, and only the rendered `label`
  // goes through the active-language lookup.
  _resolveAction(appAction, storedLabel) {
    const code = appAction?.code;
    const payload = appAction?.payload || {};
    const l = storedLabel.toLowerCase();
    const label = rulebookText(storedLabel);
    if (payload.executionTrigger === "task_created") {
      return label ? { kind: "done", label, variant: "ink" } : null;
    }
    if (code === "open_phone" || /^call\b/.test(l)) {
      return {
        kind: "done",
        label:
          rulebookText(payload.completionLabel) || label || t("common.done"),
        variant: "blue",
      };
    }
    if (code === "create_311_ticket") {
      return {
        kind: "file311",
        label: label || t("today.action.file311"),
        variant: "blue",
      };
    }
    if (code === "compose_email") {
      const to = String(payload.to || "");
      return {
        kind: "email",
        label: label || t("today.action.email"),
        variant: "blue",
        href: to ? `mailto:${to}` : null,
      };
    }
    if (l === "done") {
      return { kind: "done", label: t("common.done"), variant: "ink" };
    }
    return null;
  }

  _focusIssueCard(taskId) {
    const card = [
      ...this.querySelectorAll(
        ":scope > .home > .home-region--results article[data-task-id]",
      ),
    ].find((candidate) => candidate.getAttribute("data-task-id") === taskId);
    if (!(card instanceof HTMLElement)) return false;
    card.focus({ preventScroll: true });
    card.scrollIntoView({ block: "center", behavior: "instant" });
    return true;
  }

  _wireCards() {
    this.querySelectorAll(".duplicate-earlier-link").forEach((link) => {
      link.addEventListener("click", (event) => {
        if (!(event instanceof MouseEvent)) return;
        if (
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        if (this._focusIssueCard(link.getAttribute("data-original-task-id")))
          event.preventDefault();
      });
    });
    this.querySelectorAll(
      ":scope > .home > .home-region--results [data-task-id]",
    ).forEach((card) => {
      const taskId = card.getAttribute("data-task-id");
      const task = this._tasksById.get(taskId);
      if (!task) return;
      this._wireCardButtons(card, task);
    });
    this.querySelectorAll(
      ":scope > .home > .home-region--results .analysis-card",
    ).forEach((card) => {
      if (!card.querySelector("[data-analysis-action]")) return;
      const taskId = card.getAttribute("data-task-id");
      const task = taskId ? this._tasksById.get(taskId) || null : null;
      this._wireAnalysisCardButtons(card, task);
    });
  }

  // Attach click handlers to every [data-action] button currently inside a card.
  _wireCardButtons(card, task) {
    card.querySelectorAll("[data-action]").forEach((btn) => {
      btn.addEventListener("click", () => this._onAction(card, task, btn));
    });
  }

  _wireAnalysisCardButtons(card, task = null) {
    card.querySelectorAll("[data-analysis-action]").forEach((btn) => {
      btn.addEventListener("click", () =>
        this._onAnalysisAction(card, task, btn),
      );
    });
  }

  _onAnalysisAction(card, task, btn) {
    task = this._tasksById?.get(card.getAttribute("data-task-id")) || task;
    const action = btn.getAttribute("data-analysis-action");
    const problem = this._problemFromCard(card, task);
    if (action === "add-proof" && task) {
      void this._taskSheets().openUpdates(task, btn, "results");
    } else if (action === "mark-resolved") {
      const current =
        task ||
        this._sessionItem(problem)?.analysis?.tasks?.find(
          (candidate) => candidate.taskId === problem.taskId,
        );
      if (current) void this._taskSheets().openUpdates(current, btn, "resolve");
    } else if (action === "view311" && task) {
      void this._open311Detail(task, btn);
    } else if (action === "delete") {
      this._openDeleteProblem(problem);
    } else if (action === "edit") {
      if (task && btn instanceof HTMLElement) {
        void import("./task-details-dialog.js").then(({ openTaskDetails }) =>
          openTaskDetails(task, problem, btn, () => this.connectedCallback()),
        );
      } else {
        this._openEditProblem(problem);
      }
    } else if (action === "resolve") {
      if (
        btn.getAttribute("role") === "checkbox" ||
        btn.hasAttribute("data-phone-number")
      ) {
        toggleCardCompletion(this, card, btn, {
          task,
          onSaved: (saved) => {
            this._markAnalysisProblemResolved(problem, {
              taskStatus:
                saved.status === "in_progress" ? "in_progress" : "resolved",
            });
            this._applyTaskResult(problem.taskId, saved);
          },
          render: () => this._refreshAfterAction(),
        });
      } else this._resolveAnalysisProblem(problem, card);
    } else if (action === "answer") {
      this._answerAnalysisQuestion(problem, btn);
    } else if (action === "retry") {
      if (problem.itemId) retryEvidenceItem(problem.itemId);
    } else if (action === "remove-item") {
      if (problem.itemId) this._removeFailedItem(problem);
    }
  }

  /** Drop a failed, never-uploaded item from the pending session. */
  _removeFailedItem(problem) {
    const item = this._sessionItem(problem);
    if (!item || item.upload?.status === "uploaded") return;
    removeItem(problem.itemId);
  }

  // Home cards may be backed by a backend task; fill any coordinates the
  // card markup lacks from the task record.
  _problemFromCard(card, task = null) {
    const base = problemFromCard(card);
    return {
      ...base,
      checkId: base.checkId || task?.checkId || "",
      artifactId:
        base.artifactId || (task ? taskArtifactIds(task)[0] : "") || "",
      taskId: base.taskId || task?.taskId || "",
      conditionId: base.conditionId || task?.conditionId || "",
      actionKind: base.actionKind || task?.kind || "",
      title:
        card.getAttribute("data-card-title") ||
        rulebookText(task?.category) ||
        t("card.title.problemFallback"),
      description:
        card.getAttribute("data-card-edit-description") ||
        task?.description ||
        card.getAttribute("data-card-description") ||
        "",
    };
  }

  _openDeleteProblem(problem) {
    if (this._deletingProblem) return;
    this._activeProblem = problem;
    this._setDialogError("analysis-delete-error", "");
    const title = this.querySelector(
      ":scope > .home > #analysis-delete-dialog #analysis-delete-title",
    );
    if (title) {
      title.textContent = t("analysis.deleteDialog.titleFor", {
        title: problem.title,
      });
    }
    openOverlayDialog(
      /** @type {HTMLDialogElement} */ (this._analysisDeleteDialog),
      "analysis-delete",
    );
  }

  _openEditProblem(problem) {
    this._activeProblem = problem;
    this._setDialogError("analysis-edit-error", "");
    if (this._analysisEditDescription) {
      this._analysisEditDescription.value = problem.description;
    }
    openOverlayDialog(
      /** @type {HTMLDialogElement} */ (this._analysisEditDialog),
      "analysis-edit",
    );
  }

  async _confirmDeleteProblem() {
    const problem = this._activeProblem;
    if (!problem || this._deletingProblem) return;
    if (!problem.checkId || !problem.artifactId || !problem.conditionId) {
      this._setDialogError(
        "analysis-delete-error",
        missingConditionMessage(problem, "deleted"),
      );
      return;
    }

    this._deletingProblem = true;
    const button = this.querySelector(
      ":scope > .home > #analysis-delete-dialog #analysis-delete-confirm",
    );
    const focusUndo = button?.matches(":focus-visible") || false;
    setBusy(button, true);
    this._setDialogError("analysis-delete-error", "");
    try {
      await deleteAnalysisCard(
        this,
        problem,
        async () => {
          const localProblem = {
            ...problem,
            itemId: (await this._localQuestionItemId(problem.itemId)) || "",
          };
          let removed = false;
          const deleteLocally = () => {
            if (removed) return;
            removed = true;
            this._deleteProblemLocally(localProblem);
          };
          await rejectProblemCondition(localProblem, {
            requestId: this._requestId("delete", problem),
            deleteLocally,
            onRefreshFailure: deleteLocally,
          });
          // Retained finished checks must also remember the rejection, even
          // when the shared refresh helper only updates the current check.
          deleteLocally();
        },
        () => {
          if (this._homeModel) this._renderHome(this._homeModel);
        },
        { focusUndo, address: this._site?.address || "" },
      );
      this._activeProblem = null;
    } catch (err) {
      console.error("delete analysis condition failed", err);
      showDeleteErrorToast();
    } finally {
      this._deletingProblem = false;
      setBusy(button, false);
    }
  }

  async _saveProblemEdit() {
    const problem = this._activeProblem;
    if (!problem) return;
    const description = this._analysisEditDescription?.value?.trim() || "";
    if (description.length < 5) {
      this._setDialogError(
        "analysis-edit-error",
        t("analysis.editDialog.tooShort"),
      );
      return;
    }
    if (description === problem.description.trim()) {
      this._analysisEditDialog?.close();
      this._activeProblem = null;
      return;
    }
    if (!problem.conditionId) {
      if (!problem.itemId) {
        this._setDialogError(
          "analysis-edit-error",
          missingConditionMessage(problem, "edited"),
        );
        return;
      }
      const button = this.querySelector(
        ":scope > .home > #analysis-edit-dialog #analysis-edit-save",
      );
      setBusy(button, true);
      this._setDialogError("analysis-edit-error", "");
      try {
        await analyzeNoIssueDescriptionEdit(problem.itemId, description);
        this._analysisEditDialog?.close();
        this._activeProblem = null;
        await this.connectedCallback();
        showEditSavedToast();
      } catch (err) {
        console.error("text-only no-issue reanalysis failed", err);
        showReanalysisErrorToast();
      } finally {
        setBusy(button, false);
      }
      return;
    }
    if (!problem.checkId || !problem.artifactId || !problem.conditionId) {
      this._setDialogError(
        "analysis-edit-error",
        missingConditionMessage(problem, "edited"),
      );
      return;
    }

    const button = this.querySelector(
      ":scope > .home > #analysis-edit-dialog #analysis-edit-save",
    );
    setBusy(button, true);
    this._setDialogError("analysis-edit-error", "");
    try {
      const result = await editAnalysisCondition(
        problem.checkId,
        problem.artifactId,
        problem.conditionId,
        {
          description,
          language: getLocale(),
          caller: { request_id: this._requestId("edit", problem) },
        },
      );
      const localItemId = await this._localQuestionItemId(problem.itemId);
      if (localItemId) {
        try {
          await refreshEvidenceAnalysis(localItemId, result);
        } catch (error) {
          console.error("refresh after saved edit failed", error);
          this._analysisEditDialog?.close();
          this._activeProblem = null;
          showEditRefreshErrorToast();
          return;
        }
      }
      const recovered = (this._homeModel?.pendingQuestions || []).find(
        (item) => item.id === problem.itemId,
      );
      if (recovered && !localItemId) {
        const guidance = await refreshRecoveredQuestion(recovered, result);
        for (const task of guidance.tasks || []) {
          this._confirmedTasks ??= new Map();
          this._confirmedTasks.set(task.taskId, task);
        }
      }
      this._analysisEditDialog?.close();
      this._activeProblem = null;
      await this.connectedCallback();
      showEditSavedToast();
    } catch (err) {
      console.error("edit analysis condition failed", err);
      if (err?.status === 404 && err?.body?.code === "unknown_analysis") {
        this._setDialogError(
          "analysis-edit-error",
          t("analysis.editDialog.expired"),
        );
      } else showEditErrorToast();
    } finally {
      setBusy(button, false);
    }
  }

  _deleteProblemLocally(problem) {
    rejectConditionLocally(problem);
  }

  async _resolveAnalysisProblem(problem, card) {
    if (!problem.taskId) {
      if (card.isConnected) await slideCompletedCard(card);
      this._markAnalysisProblemResolved(problem);
      openOverlayDialog(
        /** @type {HTMLDialogElement} */ (this._analysisSuccessDialog),
        "analysis-success",
      );
      return;
    }

    if (problem.actionKind === "escalation") {
      const result = await completeCardAction(problem.taskId, {
        completionMethod: "311_filed",
      }).catch((err) => {
        console.error("escalation failed", err);
        return null;
      });
      if (!isAccepted311Filing(result?.task)) {
        show311ErrorToast();
        return;
      }
      show311FilingToast(result.task);
      this._expireRemainingLists(); // filed → In-progress on the server
      if (card.isConnected) await slideCompletedCard(card);
      this._markAnalysisProblemResolved(problem, { taskStatus: null });
      this._applyTaskResult(problem.taskId, result.task);
      void this._refreshAfterAction();
      return;
    }

    try {
      const result = await completeCardAction(problem.taskId, {
        completionMethod: "manual",
      });
      if (card.isConnected) await slideCompletedCard(card);
      this._markAnalysisProblemResolved(problem, {
        taskStatus:
          result?.task?.status === "in_progress" ? "in_progress" : "resolved",
      });
      this._applyTaskResult(problem.taskId, result?.task);
      openOverlayDialog(
        /** @type {HTMLDialogElement} */ (this._analysisSuccessDialog),
        "analysis-success",
      );
      // The reload starts now; every paint it (or anything else) requests is
      // held by _renderHome while the dialog is open and lands on its close.
      void this._refreshAfterAction();
    } catch (err) {
      console.error("resolve task failed", err);
      showActionSaveErrorToast();
    }
  }

  async _answerAnalysisQuestion(problem, button) {
    if (!(button instanceof HTMLButtonElement)) return;
    const answerKey = button.getAttribute("data-answer-key") || "";
    const answerValue = button.getAttribute("data-answer-value") === "true";
    if (!problem.itemId || !problem.conditionId || !answerKey) {
      showAnswerSaveErrorToast();
      return;
    }
    if (this._answeringConditionIds.has(problem.conditionId)) return;

    this._answeringConditionIds.add(problem.conditionId);
    setQuestionAnswerBusy(this, problem.conditionId, true);
    this._setInlineProblemError(problem, "");
    try {
      const persisted = (this._homeModel?.pendingQuestions || []).find(
        (item) => item.id === problem.itemId,
      );
      const localItemId = persisted
        ? await this._localQuestionItemId(problem.itemId)
        : problem.itemId;
      const result =
        persisted && !localItemId
          ? await submitConditionAnswers(
              persisted.analysis.assessment.assessmentId,
              problem.conditionId,
              { answers: { [answerKey]: answerValue } },
            )
          : await answerAnalysisQuestion(
              localItemId,
              problem.conditionId,
              answerKey,
              answerValue,
            );
      if (persisted) {
        // Publish the authoritative answer immediately, even while GSI2 catches up.
        if (this._homeModel)
          this._homeModel = {
            ...this._homeModel,
            pendingQuestions: (this._homeModel.pendingQuestions || []).flatMap(
              (item) => {
                if (item.id !== persisted.id) return [item];
                return result.conditionItem?.status === "needs_answer"
                  ? [
                      {
                        ...item,
                        analysis: {
                          ...item.analysis,
                          conditions: [result.conditionItem],
                          assessment:
                            result.assessmentItem || item.analysis.assessment,
                        },
                      },
                    ]
                  : [];
              },
            ),
          };
        if (result.taskItem) {
          this._confirmedTasks ??= new Map();
          this._confirmedTasks.set(result.taskItem.taskId, result.taskItem);
          this._applyTaskResult(result.taskItem.taskId, result.taskItem);
        }
        await this._refreshAfterAction();
      }
    } catch (err) {
      console.error("answer condition failed", err);
      showAnswerSaveErrorToast();
    } finally {
      this._answeringConditionIds.delete(problem.conditionId);
      setQuestionAnswerBusy(this, problem.conditionId, false);
    }
  }

  _markAnalysisProblemResolved(problem, { taskStatus = "resolved" } = {}) {
    if (problem.itemId) resolveConditionLocally(problem);
    if (problem.taskId && taskStatus) {
      this._setTaskOverride(problem.taskId, taskStatus);
    }
  }

  /** Resolve synthetic recovered-card ids to their retained local evidence. */
  async _localQuestionItemId(itemId) {
    const persisted = (this._homeModel?.pendingQuestions || []).find(
      (item) => item.id === itemId,
    );
    if (!persisted) return itemId;
    const items = [
      ...this._sessionItems(getCurrentCheck()),
      ...(await loadFinishedChecks(this._siteId)).flatMap((check) =>
        this._sessionItems(check),
      ),
    ];
    return (
      items.find(
        (item) =>
          item.analysis?.assessment?.assessmentId ===
          persisted.analysis.assessment.assessmentId,
      )?.id || null
    );
  }

  _sessionItem(problem) {
    return [
      ...this._sessionItems(getCurrentCheck()),
      ...(this._homeModel?.pendingQuestions || []),
    ].find((item) => item.id === problem.itemId);
  }

  _setInlineProblemError(problem, message) {
    const card = [
      ...this.querySelectorAll(
        ":scope > .home > .home-region--results .analysis-card",
      ),
    ].find(
      (candidate) =>
        candidate.getAttribute("data-task-id") === problem.taskId &&
        (!problem.conditionId ||
          candidate.getAttribute("data-condition-id") === problem.conditionId),
    );
    const error = card?.querySelector(".actioncard__error");
    if (!(error instanceof HTMLElement)) return;
    error.textContent = message;
    error.hidden = !message;
  }

  _setDialogError(id, message) {
    // Scoped past the embedded <perimeter-check>, which renders the same dialog ids.
    setDialogError(this, `:scope > .home > .analysis-dialog #${id}`, message);
  }

  _requestId(action, problem) {
    return requestId(
      problem.checkId,
      problem.artifactId,
      problem.conditionId,
      action,
    );
  }

  _onAction(card, task, btn) {
    task = this._tasksById?.get(task.taskId) || task;
    const action = btn.getAttribute("data-action");
    if (action === "duplicate") {
      const decorated = projectDuplicateTasks(
        [task],
        this._duplicateLinks,
      ).find((t) => t.taskId === task.taskId);
      if (!decorated?.duplicate) return;
      openDuplicateIssue(decorated, btn, {
        onSeparated: (restored) => {
          this._taskOverrides = readTaskStatusOverrides();
          this._confirmedTasks?.delete(task.taskId);
          if (restored) this._applyTaskResult(restored.taskId, restored);
          this._duplicateLinks.delete(task.taskId);
          if (this.isConnected) void this.connectedCallback();
        },
        onOriginal: (original, trigger) =>
          void this._openTaskUpdate(original, trigger),
      });
    } else if (action === "add-proof") {
      void this._taskSheets().openUpdates(task, btn, "results");
    } else if (action === "mark-resolved") {
      void this._taskSheets().openUpdates(task, btn, "resolve");
    } else if (action === "update") {
      void this._openTaskUpdate(task, btn);
    } else if (action === "view311") {
      void this._open311Detail(task, btn);
    } else if (action === "done") {
      toggleCardCompletion(this, card, btn, {
        task,
        onSaved: (taskResult) => {
          this._setTaskOverride(
            taskResult.taskId || task.taskId,
            taskResult.status === "in_progress" ? "in_progress" : "resolved",
          );
          this._applyTaskResult(task.taskId, taskResult);
        },
        render: () => this._refreshAfterAction(),
      });
    } else if (action === "file311") {
      // Filing runs inside the request (5–20 s) unless it is queued for the
      // background worker: the button says so at once, and the toast names
      // the card the moment the response lands, before the slide and the
      // reload. A retry after a failed background filing is already in
      // progress, so its card stays put.
      const title = taskCardTitle(task);
      const retry = filing311State(task) === "failed";
      void this._run(
        card,
        () =>
          completeCardAction(task.taskId, {
            completionMethod: "311_filed",
          }),
        {
          requireSubmitted311: true,
          animateOnSuccess: !retry,
          pending: { button: btn, label: t("today.action.filing") },
          onSuccess: (result) => show311FilingToast(result.task, title),
        },
      ).then((result) => {
        if (!result) return;
        this._applyTaskResult(task.taskId, result.task);
        // A retry replaces the failed outcome the watcher held over lists.
        const savedId = result.task.taskId || task.taskId;
        if (this._confirmedTasks?.has(savedId))
          this._confirmedTasks.set(savedId, result.task);
        // Filed → In-progress on the server. The override (which also expires
        // the remaining lists) keeps the card there if a reload's open-list
        // read lands before the worklist index has caught up.
        this._setTaskOverride(savedId, "in_progress");
        void this._refreshAfterAction();
      });
    }
  }

  /** Keep confirmed completions through missing or stale status-index reads.
   * @param {Record<string, any>[]} tasks
   * @param {boolean} [acknowledge] only a full status-list read can retire entries
   */
  _reconcileConfirmedTasks(tasks, acknowledge = false) {
    const confirmed = this._confirmedTasks;
    if (!confirmed?.size) return tasks;
    if (acknowledge) {
      for (const [id, task] of confirmed) {
        const matches = tasks.filter((entry) => entry.taskId === id);
        if (
          matches.length &&
          matches.every(
            (entry) =>
              entry.status === task.status && entry.updatedAt >= task.updatedAt,
          )
        )
          confirmed.delete(id);
      }
    }
    const merged = new Map(tasks.map((task) => [task.taskId, task]));
    for (const [id, task] of confirmed)
      merged.set(id, { ...merged.get(id), ...task });
    return [...merged.values()];
  }

  /**
   * Fold a completion response into the model so the card changes tabs on
   * the next paint instead of after a full reload. The server record is
   * authoritative; it is merged over the list record to keep hydrated
   * fields (thumbnail, 311 status) the response does not carry.
   */
  _applyTaskResult(taskId, task) {
    if (task?.taskId && task.taskId !== taskId) {
      this._taskOverrides = clearTaskStatusOverrides(taskId);
      this._confirmedTasks?.delete(taskId);
    }
    const model = this._homeModel;
    if (!model || !taskId || !task) return;
    // Shared duplicate actions return the original task, not the clicked
    // observation. Never merge its identity or evidence into that observation.
    taskId = task.taskId || taskId;
    // Keep the authoritative action result over cached or lagging list reads.
    // Otherwise a refresh after the exit animation can briefly repaint the
    // pre-action card (or an older queued-filing confirmation can win).
    this._confirmedTasks ??= new Map();
    this._confirmedTasks.set(taskId, task);
    const known = model.tasks.some((entry) => entry.taskId === taskId);
    const tasks = known
      ? model.tasks.map((entry) =>
          entry.taskId === taskId ? { ...entry, ...task } : entry,
        )
      : [...model.tasks, task];
    this._homeModel = { ...model, tasks };
    // Duplicate projections prefer the original cached on their link over
    // the worklist record. Keep every linked observation on the same state.
    this._duplicateLinks = new Map(
      [...this._duplicateLinks].map(([sourceId, link]) => [
        sourceId,
        link.original?.taskId === taskId
          ? { ...link, original: { ...link.original, ...task } }
          : link,
      ]),
    );
  }

  /**
   * Paint the updated model now; the full reload (every list, 311 statuses,
   * duplicates) runs behind it rather than gating the UI. Returns the reload
   * so a caller that places focus afterwards (the checklist) waits for the
   * final paint, which replaces the home subtree again.
   */
  _refreshAfterAction() {
    if (this._homeModel) this._renderHome(this._homeModel);
    return this.connectedCallback();
  }

  /**
   * @param {Element} card
   * @param {{ action?: string, label?: string }} busy the in-flight action's
   *   button kind and pending label
   */
  _setCardBusy(card, { action, label }) {
    card.querySelectorAll("button").forEach((b) => (b.disabled = true));
    const button = action
      ? card.querySelector(`[data-action="${action}"]`)
      : null;
    if (button && label) {
      // Label as text (it's translated copy), animated dots as trusted
      // presentation markup; restore() resets textContent, dropping the span.
      button.textContent = label;
      button.insertAdjacentHTML("beforeend", animatedEllipsis());
    }
    // Busy goes on the triggering button, not the card: the card-level hook
    // styles the checklist box as a spinner, which is wrong for a filing.
    (button || card).setAttribute("aria-busy", "true");
  }

  /** Re-apply in-flight action state to freshly rendered cards. */
  _applyBusyCards() {
    if (!this._busyCards.size) return;
    this.querySelectorAll(
      ":scope > .home > .home-region--results [data-task-id]",
    ).forEach((card) => {
      const busy = this._busyCards.get(card.getAttribute("data-task-id"));
      if (busy) this._setCardBusy(card, busy);
    });
  }

  _setTaskOverride(taskId, status) {
    const overrides = {
      ...readTaskStatusOverrides(),
      // Only new action results get this marker; never stamp legacy entries.
      [taskId]: { status, updatedAt: new Date().toISOString(), version: 1 },
    };
    writeTaskStatusOverrides(overrides);
    this._taskOverrides = overrides;
    this._expireRemainingLists();
  }

  // Run a task mutation: disable the card's buttons, and on success re-render the
  // whole view so the worklist and the "To do" count stay consistent; on failure
  // re-enable the card. Failures use the standardized app toast. A 200 with a
  // failed app action still counts as a failure and leaves the task available
  // to retry.
  async _run(
    card,
    fn,
    {
      requireSubmitted311 = false,
      animateOnSuccess = false,
      pending = null,
      onSuccess = null,
    } = {},
  ) {
    const err = card.querySelector(".actioncard__error");
    // The card shows it is busy from the first frame. Renders are not held
    // during the request: `_busyCards` lets `_applyBusyCards` re-apply the
    // state to a repainted card, so tabs, remaining lists and hydration keep
    // painting while a 5–20 s filing runs.
    const taskId = card.getAttribute("data-task-id");
    const busy = {
      action: pending?.button?.dataset.action,
      label: pending?.label,
    };
    const pendingLabel = pending?.button?.textContent;
    if (taskId) this._busyCards.set(taskId, busy);
    this._setCardBusy(card, busy);
    const release = () => {
      if (taskId) this._busyCards.delete(taskId);
    };
    const restore = () => {
      release();
      if (!card.isConnected && this._homeModel) {
        // A repaint during the request replaced the card: paint it idle.
        this._renderHome(this._homeModel);
        return;
      }
      card.querySelectorAll("button").forEach((b) => (b.disabled = false));
      if (pending?.button) {
        pending.button.textContent = pendingLabel;
        pending.button.removeAttribute("aria-busy");
      } else card.removeAttribute("aria-busy");
    };
    if (err) {
      err.hidden = true;
      err.textContent = "";
    }
    try {
      const result = await fn();
      const task = result?.task;
      const failure =
        requireSubmitted311 && !isAccepted311Filing(task)
          ? appActionFailureMessage(task, { includeUnsubmitted311: true }) ||
            "We couldn't file this ticket right now. Please try again."
          : appActionFailureMessage(task);
      if (failure) {
        // A worklist read during filing can replace the open task with its
        // temporary `completing` record. Restore the authoritative failure
        // response before repainting, and discard reads from that attempt.
        if (task && taskId) {
          this._applyTaskResult(taskId, task);
          this._expireRemainingLists();
          if (this._remainingStatus === "pending") this._startRemainingLoad();
          if (task.taskId && task.taskId !== taskId && this._homeModel) {
            // Cancel duplicate reads started before the failed shared action.
            this._watchDuplicates(this._homeModel.tasks);
          }
        }
        restore();
        if (requireSubmitted311) show311ErrorToast();
        else showActionSaveErrorToast();
        return;
      }
      onSuccess?.(result);
      if (animateOnSuccess && card.isConnected) {
        await slideCompletedCard(card);
      }
      return result || true;
    } catch (e) {
      console.error("task action failed", e);
      restore();
      if (requireSubmitted311) show311ErrorToast();
      else showActionSaveErrorToast();
      return false;
    } finally {
      release();
    }
  }

  // Backend unreachable on load. Online-only: surface it with a retry rather than
  // silently degrading (offline is post-MVP; no local read fallback).
  _renderError() {
    if (isDeletingAnalysisCard(this) || isCompletingAnalysisCard(this)) {
      this._deferredDeletionRender = true;
      return;
    }
    const identity = this._siteIdentity();
    this.innerHTML = errorView({ identity });
    this.querySelector("#retry")?.addEventListener("click", () =>
      this.connectedCallback(),
    );
  }
}

customElements.define("today-view", TodayView);
