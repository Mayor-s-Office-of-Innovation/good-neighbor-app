/*
  today-view — the home hub (the screen with the "Perimeter check" button).

  One always-on screen (no due/up-to-date fork), driven by real data. When we have
  the data, it shows a timestamp for the last check, the current issue count,
  and the site's real TASK# worklist. Cards carry the task's own action buttons,
  wired to the real complete / cannot-do endpoints.

  311 filing is a backend app action: explicit escalation buttons file during
  completion, while action/non-actionable escalation rules may file silently when
  tasks are created. Markup lives in today-view.templates.js; this file owns
  state, data loading, and DOM wiring.
*/
import "./today-view.css";
import { show311SuccessToast, show311ErrorToast } from "../state/toasts.js";
import {
  onDeletionsChange,
  isTaskPendingDeletion,
} from "../state/pending-deletions.js";
import {
  deleteAnalysisCard,
  isDeletingAnalysisCard,
} from "./analysis-card-deletion.js";
import { navigate } from "../router.js";
import { pushOverlay, closeOverlay, onOverlayPop } from "../router.js";
import { openOverlayDialog } from "../dialog-history.js";
import {
  activateSiteBinding,
  clearSiteSession,
  getSite,
  hasAdminAccess,
  listBoundSites,
} from "../db.js";
import {
  listChecks,
  listTasks,
  completeTask,
  cannotDoTask,
  editAnalysisCondition,
  get311RequestDetails,
} from "../services/api.js";
import {
  answerAnalysisQuestion,
  analyzeNoIssueDescriptionEdit,
  refreshEvidenceAnalysis,
  retryEvidenceItem,
} from "../services/photo-analysis.js";
import { adaptCheckHeader } from "../domain/check-adapter.js";
import {
  HOME_TABS,
  captureAnimationFallbackMs,
  displayTaskId,
  hasProblemResults,
  homeTabForStatus,
  homeTaskStatus,
  isNewHomeTask,
  isOutsideSiteRadius,
  isStalePendingSession,
  lastLogSummary,
  newestBlueCheckGroup,
  newestTaskEntriesFirst,
  normalizedHomeTab,
  relativeDay,
  sessionProblemItemHasBackendCards,
  shouldDeferSessionRenderDuringCapture,
  shouldInertHomeResults,
  shouldShowFirstRunHome,
  splitSiteIdentity,
  submitted311Ticket,
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
  isFiled311Completion,
} from "../domain/task-actions.js";
import {
  getCurrentCheck,
  hasDraft,
  loadSubmitted,
  onCheckSessionChange,
  clearSubmittedSession,
  discardInMemorySession,
  pauseCheck,
  resumeOrStartCheck,
  resumeOrStartProblemReport,
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
  actionButton,
  captureRegion,
  errorView,
  heroBlock,
  homeResults,
  homeShell,
  reasonPicker,
  summaryBlock,
} from "./today-view.templates.js";
import "./ticket-detail-dialog.js";
import "./site-switcher.js";
import "./location-dialog.js";
import { fetchProviderSites } from "../services/provider-sites.js";
import { setQuestionAnswerBusy } from "./analysis-answer-controls.js";
import { finalizeCaptureScorecardInBackground } from "../services/submit-check.js";
import {
  getSiteCheckDeviceLocation,
  getLastDeviceLocation,
  onDeviceLocationChange,
  refreshGrantedDeviceLocation,
} from "../services/device-location.js";

class TodayView extends HTMLElement {
  constructor() {
    super();
    this._viewPhase = "home";
    this._captureFlow = null;
    /** @param {CustomEvent<{ discarded?: boolean }>} event */
    this._captureFinishedHandler = (event) => this._finishCapture(event);
    this._discardingCapture = false;
    this._cardDeletedHandler = (event) => {
      if (!this._deferredDeletionRender) return;
      this._deferredDeletionRender = false;
      if (event.target === this) return;
      this._focusAfterRender = ["capture", "entering-capture"].includes(
        this._viewPhase,
      )
        ? "capture-heading"
        : "home-primary-control";
      void this.connectedCallback();
    };
    this._captureFinishedListening = false;
    this._capturePhaseTimer = 0;
    this._overlayPopUnsub = null;
    this._focusAfterRender = null;
    this._captureLauncherSelector = null;
    this._homeModel = null;
    this._hydrationGeneration = 0;
    this._answeringConditionIds = new Set();
    this._settingsMenuOpen = false;
    this._settingsDocumentClick = null;
    this._attributionsDialog = null;
    this._attributionsDialogOpen = false;
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
    this._deviceLocation = getLastDeviceLocation();
    this._locationUnsub = null;
    /** @type {any} the persistent <location-dialog>, created on first render */
    this._locationDialog = null;
    /** @type {{ flowType: string, launcher: EventTarget | null } | null} capture waiting on the prompt */
    this._locationPrompt = null;
    this._pendingLocationRender = false;
    this._startingCapture = false;
    /** @type {any} the persistent <ticket-detail-dialog>, created on first render */
    this._ticketDetailDialog = null;
    this._311StatusByTaskId = new Map();
    this._311StatusGeneration = 0;
  }

  disconnectedCallback() {
    this._deletionUnsub?.();
    this._deletionUnsub = null;
    this._sessionUnsub?.();
    this._sessionUnsub = null;
    this.removeEventListener("capturefinished", this._captureFinishedHandler);
    this.removeEventListener("analysiscarddeleted", this._cardDeletedHandler);
    document.removeEventListener("click", this._settingsDocumentClick);
    this._settingsDocumentClick = null;
    this._captureFinishedListening = false;
    this._overlayPopUnsub?.();
    this._overlayPopUnsub = null;
    this._locationUnsub?.();
    this._locationUnsub = null;
    window.clearTimeout(this._capturePhaseTimer);
  }

  async connectedCallback() {
    if (isDeletingAnalysisCard(this)) {
      this._deferredDeletionRender = true;
      return;
    }
    if (!this._deletionUnsub) {
      this._deletionUnsub = onDeletionsChange((status) => {
        if (!this.isConnected) return;
        if (status === "saved") void this.connectedCallback();
        else if (this._homeModel) this._renderHome(this._homeModel);
      });
    }
    if (!this._locationUnsub) {
      this._locationUnsub = onDeviceLocationChange((location) => {
        this._deviceLocation = location;
        if (this.isConnected && this._homeModel && this._viewPhase === "home") {
          this._renderHome(this._homeModel);
        }
      });
      void refreshGrantedDeviceLocation();
    }
    if (!this._sessionUnsub) {
      this._sessionUnsub = onCheckSessionChange((session) => {
        if (session?.status === "in-progress") {
          return;
        }
        if (shouldDeferSessionRenderDuringCapture(this._viewPhase, session)) {
          return;
        }
        this.connectedCallback();
      });
    }
    if (!this._captureFinishedListening) {
      this.addEventListener("capturefinished", this._captureFinishedHandler);
      this.addEventListener("analysiscarddeleted", this._cardDeletedHandler);
      this._captureFinishedListening = true;
    }
    if (!this._overlayPopUnsub) {
      // System back with the capture phase open unwinds its sentinel; route
      // through the same leaving-capture animation as the in-app Finish.
      // (Dialog overlays are closed by dialog-history's own pop bridge.)
      this._overlayPopUnsub = onOverlayPop((overlayId) => {
        if (overlayId !== "capture") return;
        if (this._viewPhase === "home" || this._viewPhase === "leaving-capture")
          return;
        this._finishCapture(new CustomEvent("capturefinished", { detail: {} }));
      });
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

    this._site = await getSite();
    this._siteId =
      this._site.siteId || this._site.providerSiteId || this._site.id;
    this._providerSitesStatus = "loading";
    const [catalog, bindings] = await Promise.all([
      fetchProviderSites().catch((error) => {
        console.error("listProviderSites failed", error);
        return null;
      }),
      listBoundSites(),
    ]);
    this._providerSitesStatus = catalog ? "loaded" : "error";
    this._providerSites = catalog?.sites || [];
    this._providerName = catalog?.providerName || this._site.providerName || "";
    this._boundSites = bindings;

    const active = getCurrentCheck();
    const requestedFilter = new URLSearchParams(window.location.search).get(
      "filter",
    );
    const recognizedFilter = [
      ...HOME_TABS.map(({ id }) => id),
      "needs_action",
      "resolved",
      "archived",
    ].includes(requestedFilter || "");
    // Explicit worklist links retain the resumable draft without reopening it.
    const showRequestedWorklist =
      recognizedFilter && this._viewPhase === "home";
    const captureSession =
      active?.status === "in-progress" && !showRequestedWorklist
        ? active
        : null;
    if (captureSession) {
      this._captureFlow = captureSession.flowType || "perimeter";
      if (this._viewPhase === "home") this._viewPhase = "capture";
    }
    let pendingSession =
      active && active.status === "capture-complete"
        ? active
        : await loadSubmitted();
    // Legacy-stage records (uploading/analyzing/submitted) are unreachable now —
    // clear them instead of letting them linger in the review store forever.
    if (pendingSession && pendingSession.status !== "capture-complete") {
      await clearSubmittedSession();
      pendingSession = null;
    }

    // Checks + the open worklist are read from the backend on load (AP6/AP10) —
    // newest first, adapted to the UI record shape. Online-only: on failure show
    // an error, not a crash.
    let submitted, tasks;
    try {
      const [
        { checks },
        openTasksResult,
        completingTasksResult,
        completedTasksResult,
        cannotDoTasksResult,
      ] = await Promise.all([
        listChecks({ limit: 30 }),
        listTasks({ status: "open", limit: 50 }),
        listTasks({ status: "completing", limit: 50 }),
        listTasks({ status: "completed", limit: 50 }),
        listTasks({ status: "cannot_do", limit: 50 }),
      ]);
      tasks = uniqueTasks([
        ...(openTasksResult.tasks || []),
        ...(completingTasksResult.tasks || []),
        ...(completedTasksResult.tasks || []),
        ...(cannotDoTasksResult.tasks || []),
      ]);
      submitted = (checks || [])
        .map((h) => adaptCheckHeader(h))
        .filter((c) => c.status === "submitted")
        .sort((a, b) =>
          (b.submittedAt || "").localeCompare(a.submittedAt || ""),
        );
    } catch (err) {
      console.error("listChecks/listTasks failed", err);
      this._renderError();
      return;
    }

    const last = submitted[0];
    let effectivePendingSession =
      pendingSession && pendingSession.status === "capture-complete"
        ? pendingSession
        : null;

    if (
      this._isStalePendingSession(effectivePendingSession, submitted, tasks)
    ) {
      await clearSubmittedSession();
      effectivePendingSession = null;
    } else if (effectivePendingSession?.status === "capture-complete") {
      finalizeCaptureScorecardInBackground(effectivePendingSession.id, {
        expectedArtifacts: effectivePendingSession.expectedArtifacts,
      });
    }

    // A resumable in-progress walk (Cancel from /check keeps it) still reopens
    // the draft, even though the home CTAs now use the simplified Figma copy.
    this._taskOverrides = readTaskStatusOverrides();
    this._homeFilter =
      this._homeFilter || normalizedHomeTab(requestedFilter || "");
    this._activeProblem = null;
    this._hasPerimeterDraft = await hasDraft("perimeter");
    this._renderHome({
      last,
      checks: submitted,
      tasks,
      captureSession,
      pendingSession: effectivePendingSession,
    });
    void this._hydrate311CardStatuses(tasks);
    void this._hydrateVisibleHomeTasks();
  }

  _taskWith311CardStatus(task) {
    if (!submitted311Ticket(task)) return task;
    const cardState = this._311StatusByTaskId.get(task.taskId);
    return {
      ...task,
      ticketStatus: cardState?.status || "",
      ticketStatusDetail: cardState?.statusDetail || "",
      ticketResponseOverdue: Boolean(cardState?.responseOverdue),
      ticketUpdatedAt: cardState?.updatedAt || task.createdAt || "",
    };
  }

  async _hydrate311CardStatuses(tasks) {
    const generation = ++this._311StatusGeneration;
    const submittedTasks = tasks
      .map((task) => ({ task, ticket: submitted311Ticket(task) }))
      .filter(({ task, ticket }) => task.taskId && ticket?.srNum);
    if (!submittedTasks.length) return;
    let response;
    try {
      response = await get311RequestDetails(
        submittedTasks.map(({ task, ticket }) => ({
          taskId: task.taskId,
          srNum: ticket.srNum,
        })),
      );
    } catch {
      return;
    }
    if (generation !== this._311StatusGeneration || !this.isConnected) return;
    this._311StatusByTaskId = new Map(
      (response.requests || []).flatMap(({ taskId, request }) =>
        taskId && request?.status
          ? [
              [
                taskId,
                {
                  status: request.status,
                  statusDetail: request.statusDetail || "",
                  responseOverdue: Boolean(request.responseOverdue),
                  updatedAt: request.relevantDate || request.submittedAt || "",
                },
              ],
            ]
          : [],
      ),
    );
    if (this._homeModel) this._renderHome(this._homeModel);
  }

  _renderHome(model) {
    this._homeModel = model;
    // Keep the native dialog and its action buttons mounted while a location
    // decision is pending. A background location update can otherwise replace
    // the open dialog with a closed one.
    if (this._locationPrompt) {
      this._pendingLocationRender = true;
      return;
    }
    if (isDeletingAnalysisCard(this)) {
      this._deferredDeletionRender = true;
      return;
    }
    // Index tasks by id so card action handlers can read the task (e.g. its
    // allowlisted cannot-do reasons) at click time.
    this._tasksById = new Map(model.tasks.map((t) => [t.taskId, t]));
    this.innerHTML = this._render(model);

    // Hand the bound site id to the feedback sheet so submissions carry it as
    // optional context (the server treats it as advisory, pattern-checked).
    const feedbackDialog = /** @type {any} */ (
      this.querySelector("feedback-dialog")
    );
    if (feedbackDialog) feedbackDialog.siteId = this._siteId;

    const start = this.querySelector("#start-check");
    if (start) {
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
      this._settingsMenuOpen = false;
      this._logoutDialogOpen = true;
      this._renderHome(this._homeModel);
    });
    this.querySelector("#settings-feedback")?.addEventListener("click", () => {
      this._settingsMenuOpen = false;
      this.querySelector(".home-settings-menu")?.remove();
      this.querySelector("#home-settings")?.setAttribute(
        "aria-expanded",
        "false",
      );
      feedbackDialog?.open();
    });
    this.querySelector("#settings-attributions")?.addEventListener(
      "click",
      () => {
        this._settingsMenuOpen = false;
        this.querySelector(".home-settings-menu")?.remove();
        this.querySelector("#home-settings")?.setAttribute(
          "aria-expanded",
          "false",
        );
        this._attributionsDialogOpen = true;
        openOverlayDialog(
          /** @type {HTMLDialogElement} */ (this._attributionsDialog),
          "attributions",
        );
      },
    );
    this.querySelector("#settings-site-admin")?.addEventListener("click", () =>
      navigate("/site-admin"),
    );
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
    this._mountTicketDetailDialog();
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
      },
    );
    this._wireCards();
    this._restoreFocusAfterRender();
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
    this._ticketDetailDialog?.updateTask(
      tasks.find((task) => task.taskId === this._ticketDetailDialog.taskId),
    );
    this._renderHome({ ...model, tasks });
  }

  _render({ last, checks = [], tasks, captureSession, pendingSession }) {
    const allRecentItems = pendingSession
      ? this._sessionItems(pendingSession)
      : [];
    const taskArtifactIds = taskArtifactIdSet(tasks);
    const recentItems = allRecentItems.filter((item) => {
      const artifactId = item.analysis?.artifactId || item.upload?.artifactId;
      if (item.analysis?.status === "analyzed") {
        return (
          !hasProblemResults(item) ||
          !sessionProblemItemHasBackendCards(item, tasks)
        );
      }
      return !taskArtifactIds.has(artifactId);
    });
    const homeTasks = this._homeTasks(tasks);
    const taskCheckIds = new Set(
      homeTasks.map((entry) => taskCheckGroupId(entry.task)),
    );
    const clearChecks = checks.filter(
      (check) => Number(check.issueCount) === 0 && !taskCheckIds.has(check.id),
    );
    const newestCheck = newestBlueCheckGroup(homeTasks, checks, pendingSession);
    const selectedTaskEntries = newestTaskEntriesFirst(
      homeTasks.filter(
        (entry) => homeTabForStatus(entry.homeStatus) === this._homeFilter,
      ),
    );
    const newTaskEntries = selectedTaskEntries.filter(
      (entry) => taskCheckGroupId(entry.task) === newestCheck.id,
    );
    const visibleTasks = selectedTaskEntries.filter(
      (entry) => taskCheckGroupId(entry.task) !== newestCheck.id,
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
    const historicalClearChecks =
      this._homeFilter === "history"
        ? clearChecks.filter((check) => check.id !== activeClearCheck?.id)
        : [];
    const hasPendingAssessment = !!pendingSession;
    const pendingHasTaskCards = homeTasks.some(
      (entry) => entry.task.checkId === pendingSession?.id,
    );
    const displayRecentItems = pendingHasTaskCards
      ? recentItems.filter(
          (item) =>
            item.analysis?.status !== "analyzed" || hasProblemResults(item),
        )
      : recentItems;
    const visibleRecentItems =
      this._homeFilter === "todo" ? displayRecentItems : [];
    const hasPendingClearResult =
      displayRecentItems.length > 0 &&
      displayRecentItems.every(
        (item) =>
          item.analysis?.status === "analyzed" && !hasProblemResults(item),
      );
    const hasResultCards =
      recentItems.length || homeTasks.length || clearChecks.length;
    const captureVisible =
      Boolean(captureSession) || this._viewPhase === "leaving-capture";
    const showFirstRun = shouldShowFirstRunHome({
      captureVisible,
      last,
      taskCount: tasks.length,
      hasResultCards,
    });
    const phaseClass = `home--${this._viewPhase}`;
    const resultsInactive = shouldInertHomeResults(this._viewPhase);

    return homeShell({
      phaseClass,
      captureVisible,
      resultsInactive,
      settingsMenuOpen: this._settingsMenuOpen,
      adminAccess: hasAdminAccess(this._site),
      hero: showFirstRun
        ? this._firstRunBlock()
        : this._activityBlock({ last, homeTasks }),
      capture: captureVisible ? captureRegion({ flow: this._captureFlow }) : "",
      results: this._homeResults({
        pendingSession,
        recentCheckTime:
          newestCheck.time ||
          pendingSession?.startedAt ||
          last?.submittedAt ||
          "",
        checks,
        recentItems: visibleRecentItems,
        newTaskEntries,
        visibleTasks,
        activeClearCheck,
        hasPendingClearResult,
        historicalClearChecks,
      }),
      showAnalysisDialogs: Boolean(hasPendingAssessment || hasResultCards),
      logoutError: this._logoutError,
      logoutPending: this._logoutPending,
    });
  }

  _toggleSettingsMenu() {
    this._settingsMenuOpen = !this._settingsMenuOpen;
    if (this._homeModel) this._renderHome(this._homeModel);
  }

  _mountTicketDetailDialog() {
    if (!this._ticketDetailDialog) {
      const dialog = document.createElement("ticket-detail-dialog");
      dialog.addEventListener("ticketdetailclosed", (event) => {
        const { taskId, trigger } = /** @type {CustomEvent} */ (event).detail;
        // The card that opened the sheet was re-rendered since; find its
        // current button and fall back to the original trigger.
        const current = taskId
          ? this.querySelector(
              `[data-task-id="${CSS.escape(taskId)}"] [data-action="view311"]`,
            )
          : null;
        (current || trigger)?.focus?.();
      });
      this._ticketDetailDialog = dialog;
    }
    this._ticketDetailDialog.site = this._site;
    // Re-appending the same element keeps its state across innerHTML
    // replacement; it restores its open state on reconnect.
    this.querySelector(":scope > .home")?.append(this._ticketDetailDialog);
  }

  _open311Detail(task, trigger) {
    this._mountTicketDetailDialog();
    void this._ticketDetailDialog.open(
      this._tasksById.get(task.taskId) || task,
      trigger,
    );
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

  async _logout() {
    if (this._logoutPending) return;
    this._logoutPending = true;
    this._logoutError = "";
    if (this._homeModel) this._renderHome(this._homeModel);
    try {
      await clearSiteSession();
      discardInMemorySession();
      this._logoutDialogOpen = false;
      window.dispatchEvent(new CustomEvent("authsignout"));
    } catch {
      this._logoutPending = false;
      this._logoutError = "We couldn't log you out. Please try again.";
      if (this._homeModel) this._renderHome(this._homeModel);
    }
  }

  _homeResults({
    pendingSession,
    recentCheckTime,
    checks,
    recentItems,
    newTaskEntries,
    visibleTasks,
    activeClearCheck,
    hasPendingClearResult,
    historicalClearChecks,
  }) {
    const newTaskCards = this._newTaskCardEntries(newTaskEntries);
    return homeResults({
      homeFilter: this._homeFilter,
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
      activeClearCheck,
      hasPendingClearResult,
      historyGroups: this._historyGroups(
        visibleTasks,
        checks,
        historicalClearChecks,
      ),
    });
  }

  _newTaskCardEntries(entries) {
    return entries.map((entry) => this._taskCardEntry(entry, true));
  }

  _taskCardEntry(entry, isNew) {
    return {
      markup: taskAnalysisCard({
        task: this._taskWith311CardStatus({
          ...entry.task,
          createdAt: entry.createdAt,
          siteAddress: entry.task.siteAddress || this._site?.address || "",
        }),
        siteName: this._site?.name || "",
        action:
          entry.homeStatus === "needs_action"
            ? this._primaryCardAction(entry.task)
            : entry.homeStatus === "in_progress" &&
                submitted311Ticket(entry.task)
              ? { kind: "view311", label: "View details", variant: "outline" }
              : null,
        statusLabel: isNew
          ? this._newTaskStatusMeta(entry)
          : this._taskStatusMeta(entry),
        isNew,
        includeControls: entry.homeStatus === "needs_action",
      }),
      createdAt: entry.createdAt,
      needsAnswer: Boolean(entry.task.needsAnswer),
      actionPriority: analysisActionPriority(entry.task),
    };
  }

  // One history tray per past check, newest first. A clear check (no
  // findings) gets an entry with no cards so its tray shows the clear card.
  _historyGroups(entries, checks, clearChecks = []) {
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
      await this._enterCapture(flowType, launcher);
    } finally {
      this._startingCapture = false;
    }
  }

  async _enterCapture(flowType, launcher = null) {
    this._captureFlow = flowType;
    this._viewPhase = "entering-capture";
    this._captureLauncherSelector =
      launcher instanceof HTMLElement && launcher.id
        ? `#${CSS.escape(launcher.id)}`
        : null;
    this._focusAfterRender = "capture-heading";
    this._scrollCaptureStartIntoView();
    if (flowType === "single-problem") {
      await resumeOrStartProblemReport(this._siteId);
    } else {
      await resumeOrStartCheck(this._siteId);
    }
    await this.connectedCallback();
    this._scrollCaptureStartIntoView();
    this._afterCaptureAnimation("entering-capture", () => {
      this._viewPhase = "capture";
      this._syncPhaseClass();
    });
    // History sentinel for the capture phase: system back unwinds it to the
    // home phase (same as the in-app cancel), instead of leaving the app.
    pushOverlay("capture");
  }

  /** @param {CustomEvent<{ discarded?: boolean }>} event */
  async _finishCapture(event) {
    if (this._viewPhase === "leaving-capture") return;
    this._discardingCapture = Boolean(event.detail?.discarded);
    this._viewPhase = "leaving-capture";
    this._focusAfterRender =
      this._captureLauncherSelector || "home-primary-control";
    this._syncPhaseClass();
    // Unwind the capture sentinel (a no-op if system back already did).
    closeOverlay("capture");
    this._afterCaptureAnimation("leaving-capture", async () => {
      this._viewPhase = "home";
      this._captureFlow = null;
      this._discardingCapture = false;
      await this.connectedCallback();
      this._captureLauncherSelector = null;
    });
  }

  _syncPhaseClass() {
    const root = this.querySelector(".home");
    if (!root) return;
    root.classList.toggle("home--home", this._viewPhase === "home");
    root.classList.toggle(
      "home--entering-capture",
      this._viewPhase === "entering-capture",
    );
    root.classList.toggle("home--capture", this._viewPhase === "capture");
    root.classList.toggle(
      "home--leaving-capture",
      this._viewPhase === "leaving-capture",
    );
    root.classList.toggle("home--discarding-capture", this._discardingCapture);
    const results = this.querySelector(".home-region--results");
    if (results) {
      const inactive = shouldInertHomeResults(this._viewPhase);
      results.toggleAttribute("inert", inactive);
      if (inactive) {
        results.setAttribute("aria-hidden", "true");
      } else {
        results.removeAttribute("aria-hidden");
      }
    }
  }

  _afterCaptureAnimation(expectedPhase, callback) {
    window.clearTimeout(this._capturePhaseTimer);
    const capture = this.querySelector(".home-region--capture");
    if (!capture) {
      void callback();
      return;
    }
    let completed = false;
    const finish = () => {
      if (completed || this._viewPhase !== expectedPhase) return;
      completed = true;
      capture.removeEventListener("animationend", onAnimationEnd);
      window.clearTimeout(this._capturePhaseTimer);
      void callback();
    };
    const onAnimationEnd = (event) => {
      if (event.target === capture) finish();
    };
    const fallbackMs = captureAnimationFallbackMs(
      window.getComputedStyle(capture),
    );
    capture.addEventListener("animationend", onAnimationEnd);
    this._capturePhaseTimer = window.setTimeout(finish, fallbackMs);
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

  _activityBlock({ last, homeTasks }) {
    const identity = this._siteIdentity();
    return heroBlock({
      siteName: identity.site,
      summary: this._summaryBlock(last, homeTasks),
      checkLabel: this._checkActionLabel(),
      reportLabel: "Flag a single issue",
    });
  }

  _checkActionLabel() {
    return this._hasPerimeterDraft ? "Resume a check" : "Start a full check";
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
    const name = (this._site && this._site.name) || "Your site";
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
    dialog.siteName = this._site?.name || "this site";
    dialog.sites = this._providerSites;
    dialog.currentSite = {
      siteId: this._siteId,
      name: this._site?.name || "Your site",
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
  _onLocationDialogClosed({ changingSite }) {
    this._locationPrompt = null;
    if (this._pendingLocationRender) {
      this._pendingLocationRender = false;
      if (!changingSite && this._viewPhase === "home" && this._homeModel) {
        this._renderHome(this._homeModel);
      }
    }
  }

  /** @param {{ prompt: { flowType: string, launcher: EventTarget | null } | null }} detail */
  _onLocationStay({ prompt }) {
    if (prompt) void this._enterCapture(prompt.flowType, prompt.launcher);
  }

  async _requestAnotherSite(mode = "code", siteId = "", siteName = "") {
    const active = getCurrentCheck();
    if (active?.status === "capture-complete") {
      this._siteSwitcher?.showError(
        "Wait for this check to finish analyzing before switching sites.",
      );
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
      this._siteSwitcher?.showError(
        "We couldn't save this check before switching sites.",
      );
    }
  }

  async _switchToSite(siteId) {
    if (!siteId || siteId === this._siteId) {
      this._siteSwitcher?.close();
      return;
    }
    const target = this._providerSites.find((site) => site.siteId === siteId);
    const bound = this._boundSites.some(
      (site) => site.siteId === siteId && site.token && site.refreshToken,
    );
    if (!bound) {
      await this._requestAnotherSite("code", siteId, target?.name || "");
      return;
    }
    const active = getCurrentCheck();
    if (active?.status === "capture-complete") {
      this._siteSwitcher?.showError(
        "Wait for this check to finish analyzing before switching sites.",
      );
      return;
    }
    try {
      if (active) await pauseCheck();
      const selected = await activateSiteBinding(siteId);
      if (!selected) {
        await this._requestAnotherSite("code", siteId, target?.name || "");
        return;
      }
      discardInMemorySession();
      window.location.assign("/today");
    } catch (error) {
      console.error("site switch failed", error);
      this._siteSwitcher?.showError("We couldn't switch sites. Try again.");
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
    const now = new Date();
    return tasks
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
      ? `${relativeDay(createdAt)} • ${timeOf(createdAt)}`
      : "Existing";
    const id = displayTaskId(entry.task);
    return id ? `${when} • ${id}` : when;
  }

  _newTaskStatusMeta(entry) {
    const id = displayTaskId(entry.task);
    return id ? `NEW • ${id}` : "NEW";
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
      actions.push({ kind: "done", label: "Done", variant: "ink" });
    }
    if ((task.cannotDoReasons || []).length) {
      actions.push({ kind: "cant", label: "Can't", variant: "outline" });
    }
    return actions;
  }

  // Map one persisted app action (+ its display label) to a rendered control.
  // Returns null for actions with no wired behavior yet (fire-hazard report,
  // generic manual steps) — they always co-occur with a call/311 action, so the
  // card stays actionable without rendering a dead button.
  _resolveAction(appAction, label) {
    const code = appAction?.code;
    const payload = appAction?.payload || {};
    const l = label.toLowerCase();
    if (payload.executionTrigger === "task_created") {
      return label ? { kind: "done", label, variant: "ink" } : null;
    }
    if (code === "open_phone" || /^call\b/.test(l)) {
      return {
        kind: "done",
        label: String(payload.completionLabel || label || "Done"),
        variant: "blue",
      };
    }
    if (code === "create_311_ticket") {
      return {
        kind: "file311",
        label: label || "File 311 ticket",
        variant: "blue",
      };
    }
    if (code === "compose_email") {
      const to = String(payload.to || "");
      return {
        kind: "email",
        label: label || "Email",
        variant: "blue",
        href: to ? `mailto:${to}` : null,
      };
    }
    if (l === "done") return { kind: "done", label: "Done", variant: "ink" };
    return null;
  }

  _wireCards() {
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

  // (Re)attach click handlers to every [data-action] button currently inside a
  // card — used on first render and after swapping in the reason picker.
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
    const action = btn.getAttribute("data-analysis-action");
    const problem = this._problemFromCard(card, task);
    if (action === "view311" && task) {
      void this._open311Detail(task, btn);
    } else if (action === "delete") {
      this._openDeleteProblem(problem);
    } else if (action === "edit") {
      this._openEditProblem(problem);
    } else if (action === "resolve") {
      this._resolveAnalysisProblem(problem);
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
        card.getAttribute("data-card-title") || task?.category || "problem",
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
    if (title) title.textContent = `Delete "${problem.title}"?`;
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
        () =>
          rejectProblemCondition(problem, {
            requestId: this._requestId("delete", problem),
            deleteLocally: () => this._deleteProblemLocally(problem),
            onRefreshFailure: () => {
              if (getCurrentCheck()?.id === problem.checkId)
                this._deleteProblemLocally(problem);
            },
          }),
        () => {
          if (this._homeModel) this._renderHome(this._homeModel);
        },
        { focusUndo },
      );
      this._activeProblem = null;
    } catch (err) {
      console.error("delete analysis condition failed", err);
      this._setDialogError(
        "analysis-delete-error",
        "Could not delete this problem. Please try again.",
      );
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
        "Description must be at least 5 characters.",
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
      } catch (err) {
        console.error("text-only no-issue reanalysis failed", err);
        this._setDialogError(
          "analysis-edit-error",
          "Could not analyze this description. Please try again.",
        );
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
          caller: { request_id: this._requestId("edit", problem) },
        },
      );
      if (problem.itemId) {
        await refreshEvidenceAnalysis(problem.itemId, result);
      }
      this._analysisEditDialog?.close();
      this._activeProblem = null;
      await this.connectedCallback();
    } catch (err) {
      console.error("edit analysis condition failed", err);
      this._setDialogError(
        "analysis-edit-error",
        "Could not save this edit. Please try again.",
      );
    } finally {
      setBusy(button, false);
    }
  }

  _deleteProblemLocally(problem) {
    rejectConditionLocally(problem);
  }

  async _resolveAnalysisProblem(problem) {
    if (!problem.taskId) {
      this._markAnalysisProblemResolved(problem);
      openOverlayDialog(
        /** @type {HTMLDialogElement} */ (this._analysisSuccessDialog),
        "analysis-success",
      );
      return;
    }

    if (problem.actionKind === "escalation") {
      const result = await completeTask(problem.taskId, {
        completionMethod: "311_filed",
      }).catch((err) => {
        console.error("escalation failed", err);
        return null;
      });
      if (!isFiled311Completion(result?.task)) {
        show311ErrorToast();
        return;
      }
      show311SuccessToast();
      this._markAnalysisProblemResolved(problem, { taskStatus: null });
      await this.connectedCallback();
      return;
    }

    try {
      await completeTask(problem.taskId, { completionMethod: "manual" });
      this._markAnalysisProblemResolved(problem);
      openOverlayDialog(
        /** @type {HTMLDialogElement} */ (this._analysisSuccessDialog),
        "analysis-success",
      );
      await this.connectedCallback();
    } catch (err) {
      console.error("resolve task failed", err);
      this._setInlineProblemError(
        problem,
        "Could not save that action. Please try again.",
      );
    }
  }

  async _answerAnalysisQuestion(problem, button) {
    if (!(button instanceof HTMLButtonElement)) return;
    const answerKey = button.getAttribute("data-answer-key") || "";
    const answerValue = button.getAttribute("data-answer-value") === "true";
    if (!problem.itemId || !problem.conditionId || !answerKey) {
      this._setInlineProblemError(
        problem,
        "Could not save that answer. Please try again.",
      );
      return;
    }
    if (this._answeringConditionIds.has(problem.conditionId)) return;

    this._answeringConditionIds.add(problem.conditionId);
    setQuestionAnswerBusy(this, problem.conditionId, true);
    this._setInlineProblemError(problem, "");
    try {
      await answerAnalysisQuestion(
        problem.itemId,
        problem.conditionId,
        answerKey,
        answerValue,
      );
    } catch (err) {
      console.error("answer condition failed", err);
      this._setInlineProblemError(
        problem,
        "Could not save that answer. Please try again.",
      );
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

  _sessionItem(problem) {
    return this._sessionItems(getCurrentCheck()).find(
      (item) => item.id === problem.itemId,
    );
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
    const action = btn.getAttribute("data-action");
    if (action === "view311") {
      void this._open311Detail(task, btn);
    } else if (action === "done") {
      this._run(card, () =>
        completeTask(task.taskId, { completionMethod: "manual" }),
      ).then((ok) => {
        if (ok) {
          this._setTaskOverride(task.taskId, "resolved");
          this.connectedCallback();
        }
      });
    } else if (action === "file311") {
      this._run(
        card,
        () => completeTask(task.taskId, { completionMethod: "311_filed" }),
        { requireSubmitted311: true },
      ).then((ok) => {
        if (ok) {
          show311SuccessToast();
          this.connectedCallback();
        }
      });
    } else if (action === "cant") {
      this._renderReasonPicker(card, task);
    } else if (action === "cant-reason") {
      const reason = btn.getAttribute("data-reason") || "";
      this._run(card, () => cannotDoTask(task.taskId, { reason })).then(
        (ok) => {
          if (ok) {
            this._setTaskOverride(task.taskId, "resolved");
            this.connectedCallback();
          }
        },
      );
    } else if (action === "cant-cancel") {
      this._restoreActions(card, task);
    }
  }

  _setTaskOverride(taskId, status) {
    const overrides = {
      ...readTaskStatusOverrides(),
      [taskId]: { status, updatedAt: new Date().toISOString() },
    };
    writeTaskStatusOverrides(overrides);
    this._taskOverrides = overrides;
  }

  // A "failed" app action holds the task open but still returns 200, so the
  // caller must read the stored results to know the filing didn't happen.
  // Map the recorded reason to one actionable line (mirrors SUBMIT_MESSAGES).
  // "Can't" -> swap the action row for the task's allowlisted reasons (the backend
  // rejects arbitrary ones), plus a cancel.
  _renderReasonPicker(card, task) {
    const actions = card.querySelector(
      ".analysis-card__actions, .actioncard__actions",
    );
    if (!actions) return;
    const reasons = task.cannotDoReasons || [];
    actions.innerHTML = reasonPicker({ reasons });
    this._wireCardButtons(card, task);
  }

  _restoreActions(card, task) {
    const actions = card.querySelector(
      ".analysis-card__actions, .actioncard__actions",
    );
    if (!actions) return;
    actions.innerHTML = this._cardActions(task)
      .map((a) => actionButton(a))
      .join("");
    this._wireCardButtons(card, task);
  }

  // Run a task mutation: disable the card's buttons, and on success re-render the
  // whole view so the worklist and the "To do" count stay consistent; on failure
  // re-enable the card. Explicit 311 failures use the app error toast; other
  // actions keep their inline error. A 200 with a failed app action still
  // counts as a failure and leaves the task available to retry.
  async _run(card, fn, { requireSubmitted311 = false } = {}) {
    const buttons = card.querySelectorAll("button");
    const err = card.querySelector(".actioncard__error");
    buttons.forEach((b) => (b.disabled = true));
    if (err) {
      err.hidden = true;
      err.textContent = "";
    }
    try {
      const result = await fn();
      const task = result?.task;
      const failure =
        requireSubmitted311 && !isFiled311Completion(task)
          ? appActionFailureMessage(task, { includeUnsubmitted311: true }) ||
            "We couldn't file this ticket right now. Please try again."
          : appActionFailureMessage(task);
      if (failure) {
        buttons.forEach((b) => (b.disabled = false));
        if (requireSubmitted311) show311ErrorToast();
        else if (err) {
          err.hidden = false;
          err.textContent = failure;
        }
        return;
      }
      return true;
    } catch (e) {
      console.error("task action failed", e);
      buttons.forEach((b) => (b.disabled = false));
      if (requireSubmitted311) show311ErrorToast();
      else if (err) {
        err.hidden = false;
        err.textContent = "Couldn’t save that — please try again.";
      }
      return false;
    }
  }

  // Backend unreachable on load. Online-only: surface it with a retry rather than
  // silently degrading (offline is post-MVP; no local read fallback).
  _renderError() {
    if (isDeletingAnalysisCard(this)) {
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
