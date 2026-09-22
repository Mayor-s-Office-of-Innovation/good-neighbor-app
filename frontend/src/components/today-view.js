/*
  today-view — the home hub (the screen with the "Perimeter check" button).

  One always-on screen (no due/up-to-date fork), driven by real data. When we have
  the data, it shows a timestamp for the last check, the current issue count,
  and the site's real TASK# worklist. Cards carry the task's own action buttons,
  wired to the real complete / cannot-do endpoints.

  311 filing is a backend app action: explicit escalation buttons file during
  completion, while action/non-actionable escalation rules may file silently when
  tasks are created. Markup is inline via the `html` tag; split into a
  .templates.js file if it grows (see CLAUDE.md convention).
*/
import { show311SuccessToast, show311ErrorToast } from "../state/toasts.js";
import {
  onDeletionsChange,
  isTaskPendingDeletion,
} from "../state/pending-deletions.js";
import {
  deleteAnalysisCard,
  isDeletingAnalysisCard,
} from "./analysis-card-deletion.js";
import { html, escapeHtml, escapeAttr } from "../lib/html.js";
import {
  activateSiteBinding,
  clearSiteSession,
  getSite,
  listBoundSites,
} from "../db.js";
import {
  listChecks,
  listTasks,
  listProviderSites,
  getCheck,
  getMediaUrl,
  ApiError,
  completeTask,
  cannotDoTask,
  editAnalysisCondition,
  rejectAnalysisCondition,
} from "../services/api.js";
import {
  answerAnalysisQuestion,
  analyzeNoIssueDescriptionEdit,
  refreshEvidenceAnalysis,
  retryEvidenceItem,
} from "../services/photo-analysis.js";
import { adaptCheckHeader } from "../domain/check-adapter.js";
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
  updateItemAnalysis,
} from "../state/check-session.js";
import {
  analysisResultsTray,
  analysisActionPriority,
  clearCheckCard,
  historicalCheckTitle,
  recentCheckTitle,
  sortAnalysisCards,
  taskAnalysisCard,
} from "./analysis-results.templates.js";
import { setQuestionAnswerBusy } from "./analysis-answer-controls.js";
import { analysisDialogs } from "./perimeter-check.templates.js";
import { finalizeCaptureScorecardInBackground } from "../services/submit-check.js";
import {
  getSiteCheckDeviceLocation,
  getLastDeviceLocation,
  onDeviceLocationChange,
  refreshGrantedDeviceLocation,
} from "../services/device-location.js";

const HOME_TABS = [
  { id: "todo", label: "To do" },
  { id: "in_progress", label: "In progress" },
  { id: "history", label: "History" },
];
const NEW_TASK_WINDOW_MS = 3 * 60 * 60 * 1000;
const ARCHIVE_AFTER_MS = 72 * 60 * 60 * 1000;
const TASK_STATUS_OVERRIDES_KEY = "gnp-home-task-status-overrides";
const CHECK_ARTIFACTS_CACHE = new Map();
const MEDIA_URL_CACHE = new Map();
const SITE_RADIUS_METERS = 201.168; // One eighth of a mile.

/**
 * @param {{latitude: number, longitude: number} | null | undefined} position
 * @param {{latitude: number, longitude: number} | null | undefined} site
 * @returns {boolean}
 */
export function isOutsideSiteRadius(position, site) {
  if (!position || !site) return false;
  const { latitude: lat1, longitude: lon1 } = position;
  const { latitude: lat2, longitude: lon2 } = site;
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return false;
  if (
    Math.abs(lat1) > 90 ||
    Math.abs(lat2) > 90 ||
    Math.abs(lon1) > 180 ||
    Math.abs(lon2) > 180
  )
    return false;
  const radians = Math.PI / 180;
  const deltaLat = (lat2 - lat1) * radians;
  const deltaLon = (lon2 - lon1) * radians;
  const arc =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1 * radians) *
      Math.cos(lat2 * radians) *
      Math.sin(deltaLon / 2) ** 2;
  return (
    6371000 * 2 * Math.asin(Math.min(1, Math.sqrt(arc))) > SITE_RADIUS_METERS
  );
}

/**
 * Decide whether a local pending/review session has been superseded by backend history.
 * @param {{ id: string, status?: string, submittedAt?: string } | null} session
 * @param {Array<{ id: string, status?: string, submittedAt?: string }>} submitted
 * @returns {boolean}
 */
export function isStalePendingSession(session, submitted) {
  if (!session) return false;
  if (session.status === "capture-complete") {
    // The background scorecard has no terminal transition, so a completed
    // backend check with the same id is the only signal the run has landed —
    // the local mirror can then be dropped (re-finalizing it is idempotent,
    // but repeats on every home load otherwise).
    return submitted.some((check) => check.id === session.id);
  }
  if (submitted.some((check) => check.id === session.id)) return false;
  if (!session.submittedAt || !submitted.length) return false;
  return submitted.some(
    (check) =>
      check.submittedAt &&
      check.submittedAt.localeCompare(session.submittedAt) >= 0,
  );
}

/**
 * Sort task records by creation time without mutating the caller's array.
 * @template {{ createdAt?: string }} T
 * @param {T[]} tasks
 * @returns {T[]}
 */
export function newestTasksFirst(tasks) {
  return [...tasks].sort((a, b) =>
    String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")),
  );
}

export function activeHomeFilterLabel(filterId, counts) {
  const tab =
    HOME_TABS.find((candidate) => candidate.id === filterId) || HOME_TABS[0];
  return `${tab.label} • ${counts[filterId] || 0}`;
}

/**
 * @param {string} status
 * @returns {"todo" | "in_progress" | "history"}
 */
export function homeTabForStatus(status) {
  if (status === "needs_action") return "todo";
  if (status === "in_progress") return "in_progress";
  return "history";
}

function normalizedHomeTab(value) {
  if (value === "needs_action") return "todo";
  if (value === "resolved" || value === "archived") return "history";
  return HOME_TABS.some((tab) => tab.id === value) ? value : "todo";
}

export function homeTaskStatus(task, override, now = new Date()) {
  const status = String(task.status || "open");
  if (status === "completing" || status === "in_progress") {
    return "in_progress";
  }
  if (status === "completed" || status === "cannot_do") {
    if (
      status === "completed" &&
      task.completionMethod === "311_filed" &&
      !hasCompleted311Ticket(task)
    ) {
      return "in_progress";
    }
    const resolvedAt =
      task.completedAt ||
      task.completed_at ||
      task.resolvedAt ||
      task.resolved_at ||
      task.updatedAt ||
      task.updated_at ||
      taskCreatedAt(task);
    return ageMs(resolvedAt, now) >= ARCHIVE_AFTER_MS ? "archived" : "resolved";
  }
  if (override?.status === "in_progress") return "in_progress";
  if (override?.status === "resolved") {
    return ageMs(override.updatedAt, now) >= ARCHIVE_AFTER_MS
      ? "archived"
      : "resolved";
  }
  return "needs_action";
}

function hasCompleted311Ticket(task) {
  const terminalStatuses = new Set(["closed", "completed", "resolved"]);
  return (task.appActionResults || []).some(
    (result) =>
      result?.code === "create_311_ticket" &&
      terminalStatuses.has(String(result.status || "").toLowerCase()),
  );
}

export function isNewHomeTask(task, override, now = new Date()) {
  return (
    homeTaskStatus(task, override, now) === "needs_action" &&
    ageMs(taskCreatedAt(task), now) < NEW_TASK_WINDOW_MS
  );
}

export function taskCreatedAt(task) {
  if (task.createdAt) return task.createdAt;
  if (task.created_at) return task.created_at;
  if (task.updatedAt) return task.updatedAt;
  if (task.updated_at) return task.updated_at;
  const gsiDate = /^([^#]+)#/.exec(String(task.gsi2sk || ""));
  return gsiDate?.[1] || "";
}

export function displayTaskId(task) {
  return String(
    task.shortId ||
      task.displayId ||
      task.display_id ||
      task.assessmentId ||
      task.taskId ||
      "",
  );
}

export function shouldShowFirstRunHome({
  captureVisible,
  last,
  taskCount,
  hasResultCards,
}) {
  return !captureVisible && !last && taskCount === 0 && !hasResultCards;
}

/** @returns {string} */
export function homeAllDonePanel() {
  return html`
    <section
      class="home-results__complete"
      aria-labelledby="home-all-done-title"
    >
      <div class="home-results__complete-content">
        <img src="/clear-check-icon.png" alt="" width="96" height="98" />
        <h2 id="home-all-done-title">All done!</h2>
        <p>
          Your site is in great shape. Nothing needs your attention right now.
        </p>
        <p class="home-results__complete-note">
          <a href="/problem" data-start-capture="single-problem">
            Add a problem
          </a>
          if we missed something.
        </p>
      </div>
    </section>
  `;
}

export function shouldDeferSessionRenderDuringCapture(viewPhase, session) {
  if (!["entering-capture", "capture", "leaving-capture"].includes(viewPhase)) {
    return false;
  }
  return !session || session.status === "capture-complete";
}

export function shouldInertHomeResults(viewPhase) {
  return ["entering-capture", "capture"].includes(viewPhase);
}

export function captureAnimationFallbackMs(style) {
  const durations = cssTimeListMs(style.animationDuration);
  const delays = cssTimeListMs(style.animationDelay);
  const count = Math.max(durations.length, delays.length, 1);
  let max = 0;
  for (let i = 0; i < count; i++) {
    max = Math.max(
      max,
      (durations[i % durations.length] || 0) + (delays[i % delays.length] || 0),
    );
  }
  return max > 0 ? max + 50 : 1;
}

export function issueCountLabel(count) {
  if (!count) return "";
  return `${count} ${count === 1 ? "issue" : "issues"} found`;
}

/**
 * @param {{ id?: string, submittedAt?: string | null, issueCount?: number } | null | undefined} last
 * @param {Array<{ task: { checkId?: string }, homeStatus: string }>} entries
 * @param {Date} [now]
 * @returns {string}
 */
export function lastLogSummary(last, entries, now = new Date()) {
  if (!last?.submittedAt) return "";
  const date = new Date(last.submittedAt);
  if (Number.isNaN(date.getTime())) return "";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const day =
    date.toDateString() === now.toDateString()
      ? "today"
      : date.toDateString() === yesterday.toDateString()
        ? "yesterday"
        : new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(date);
  const time = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
  const count = Number(last.issueCount) || 0;
  const needsAction = entries.some(
    (entry) =>
      entry.task.checkId === last.id && entry.homeStatus === "needs_action",
  );
  const outcome =
    count === 0
      ? "No issues found"
      : last.id && !needsAction
        ? "All issues handled"
        : issueCountLabel(count);
  return `Last log: ${day} at ${time} · ${outcome}`;
}

export function taskSignaturesFromSessionItems(items) {
  const signatures = {
    taskIds: new Set(),
    conditionIds: new Set(),
    assessmentIds: new Set(),
    artifactIds: new Set(),
  };
  for (const item of items || []) {
    const artifactId = item?.analysis?.artifactId || item?.upload?.artifactId;
    if (artifactId) signatures.artifactIds.add(artifactId);
    const assessmentId = item?.analysis?.assessment?.assessmentId;
    if (assessmentId) signatures.assessmentIds.add(assessmentId);
    for (const condition of item?.analysis?.conditions || []) {
      if (condition?.conditionId) {
        signatures.conditionIds.add(condition.conditionId);
      }
    }
    for (const task of item?.analysis?.tasks || []) {
      if (task?.taskId) signatures.taskIds.add(task.taskId);
      if (task?.conditionId) signatures.conditionIds.add(task.conditionId);
      if (task?.assessmentId) signatures.assessmentIds.add(task.assessmentId);
      for (const artifact of task?.sourceArtifactIds || []) {
        if (artifact) signatures.artifactIds.add(artifact);
      }
    }
  }
  return signatures;
}

export function taskMatchesSessionSignatures(task, signatures) {
  if (!task || !signatures) return false;
  if (task.taskId && signatures.taskIds.has(task.taskId)) return true;
  if (task.conditionId && signatures.conditionIds.has(task.conditionId)) {
    return true;
  }
  if (task.assessmentId && signatures.assessmentIds.has(task.assessmentId)) {
    return true;
  }
  return taskArtifactIds(task).some((artifactId) =>
    signatures.artifactIds.has(artifactId),
  );
}

function ageMs(iso, now) {
  if (!iso) return 0;
  const timestamp = new Date(iso).getTime();
  if (!Number.isFinite(timestamp)) return 0;
  return Math.max(0, now.getTime() - timestamp);
}

function uniqueTasks(tasks) {
  const byId = new Map();
  for (const task of tasks) {
    if (!task?.taskId || byId.has(task.taskId)) continue;
    byId.set(task.taskId, task);
  }
  return [...byId.values()];
}

function taskArtifactIdSet(tasks) {
  const artifactIds = new Set();
  for (const task of tasks || []) {
    for (const artifactId of taskArtifactIds(task)) {
      if (artifactId) artifactIds.add(artifactId);
    }
  }
  return artifactIds;
}

function taskArtifactIds(task) {
  const explicitIds = Array.isArray(task?.sourceArtifactIds)
    ? task.sourceArtifactIds
    : [];
  const assessmentArtifactId = artifactIdFromAssessmentId(task?.assessmentId);
  return [...explicitIds, assessmentArtifactId].filter(Boolean);
}

function hasProblemResults(item) {
  return Boolean(
    (item.analysis?.tasks || []).length ||
      (item.analysis?.conditions || []).length,
  );
}

export function sessionProblemItemHasBackendCards(item, tasks) {
  const backendTasks = Array.isArray(tasks) ? tasks : [];
  const localTasks = item?.analysis?.tasks || [];
  if (localTasks.length) {
    return localTasks.every((localTask) =>
      backendTasks.some((backendTask) =>
        sameProblemCard(localTask, backendTask),
      ),
    );
  }
  const localConditions = item?.analysis?.conditions || [];
  if (localConditions.length) {
    return localConditions.every((condition) =>
      backendTasks.some(
        (backendTask) =>
          condition.conditionId &&
          condition.conditionId === backendTask.conditionId,
      ),
    );
  }
  return false;
}

function sameProblemCard(localTask, backendTask) {
  return Boolean(
    (localTask.taskId && localTask.taskId === backendTask.taskId) ||
      (localTask.conditionId &&
        localTask.conditionId === backendTask.conditionId) ||
      (localTask.assessmentId &&
        localTask.assessmentId === backendTask.assessmentId),
  );
}

async function hydrateTaskEvidence(tasks) {
  const checkIds = [
    ...new Set(tasks.map((task) => task?.checkId).filter(Boolean)),
  ];
  if (!checkIds.length) return tasks;

  const artifactsByCheck = new Map();
  await Promise.all(
    checkIds.map(async (checkId) => {
      artifactsByCheck.set(checkId, await cachedCheckArtifacts(checkId));
    }),
  );

  return Promise.all(
    tasks.map(async (task) => {
      const artifact = firstTaskArtifact(task, artifactsByCheck);
      if (!artifact) return task;
      // `positionDescriptor` is not a fallback here: since ADR 0014 it is a
      // fixed literal, not a location. Only pre-Phase-2 rows carry a place
      // name; the card falls back to the site name otherwise.
      const evidence = {
        artifactId: artifact.artifactId || "",
        placeName: artifact.placeName || task.placeName || task.location || "",
        text: artifact.text || "",
      };
      if (artifact.s3Key && artifact.contentType?.startsWith?.("image/")) {
        try {
          const downloadUrl = await cachedMediaUrl(
            task.checkId,
            artifact.artifactId,
          );
          return {
            ...task,
            evidence,
            mediaUrl: downloadUrl,
            thumbnailUrl: downloadUrl,
          };
        } catch (err) {
          console.warn("Could not hydrate task media", {
            checkId: task.checkId,
            artifactId: artifact.artifactId,
            err,
          });
        }
      }
      return { ...task, evidence };
    }),
  );
}

async function cachedCheckArtifacts(checkId) {
  if (!CHECK_ARTIFACTS_CACHE.has(checkId)) {
    CHECK_ARTIFACTS_CACHE.set(
      checkId,
      getCheck(checkId)
        .then((result) => result.artifacts || [])
        .catch((err) => {
          console.warn("Could not hydrate task evidence", { checkId, err });
          CHECK_ARTIFACTS_CACHE.delete(checkId);
          return [];
        }),
    );
  }
  return CHECK_ARTIFACTS_CACHE.get(checkId);
}

async function cachedMediaUrl(checkId, artifactId) {
  const key = `${checkId}:${artifactId}`;
  if (!MEDIA_URL_CACHE.has(key)) {
    MEDIA_URL_CACHE.set(
      key,
      getMediaUrl(checkId, artifactId)
        .then((media) => media.downloadUrl)
        .catch((err) => {
          MEDIA_URL_CACHE.delete(key);
          throw err;
        }),
    );
  }
  return MEDIA_URL_CACHE.get(key);
}

function firstTaskArtifact(task, artifactsByCheck) {
  const artifacts = artifactsByCheck.get(task?.checkId) || [];
  const sourceIds = new Set(taskArtifactIds(task));
  return (
    artifacts.find((artifact) =>
      sourceIds.has(String(artifact.artifactId || "")),
    ) || null
  );
}

function artifactIdFromAssessmentId(assessmentId) {
  const value = String(assessmentId || "");
  const uuidPair =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(
      value,
    );
  return uuidPair?.[1] || "";
}

function newestTaskEntriesFirst(entries) {
  return [...entries].sort((a, b) =>
    String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")),
  );
}

function taskCheckGroupId(task) {
  return task?.checkId || "unknown";
}

/**
 * @param {Array<{task: {checkId?: string}, createdAt?: string}>} entries
 * @param {Array<{id: string, submittedAt?: string, startedAt?: string, issueCount?: number}>} checks
 * @param {{id?: string, startedAt?: string, submittedAt?: string} | null} pendingSession
 * @param {Date} [now]
 * @returns {{id: string, time: string}}
 */
export function newestBlueCheckGroup(
  entries,
  checks,
  pendingSession,
  now = new Date(),
) {
  const checkTimes = new Map(
    (checks || []).map((check) => [
      check.id,
      check.submittedAt || check.startedAt || "",
    ]),
  );
  const candidates = new Map();
  for (const entry of entries || []) {
    const id = taskCheckGroupId(entry.task);
    const timestamp = checkTimes.get(id) || entry.createdAt || "";
    const previous = candidates.get(id) || "";
    if (String(timestamp).localeCompare(String(previous)) > 0) {
      candidates.set(id, timestamp);
    }
  }
  for (const check of checks || []) {
    if (Number(check.issueCount) !== 0 || !check.id) continue;
    candidates.set(
      check.id,
      check.submittedAt || check.startedAt || candidates.get(check.id) || "",
    );
  }
  if (pendingSession?.id) {
    candidates.set(
      pendingSession.id,
      pendingSession.startedAt || pendingSession.submittedAt || "",
    );
  }
  const newest = [...candidates.entries()].sort((a, b) =>
    String(b[1]).localeCompare(String(a[1])),
  )[0];
  if (!newest) return { id: "", time: "" };
  const date = new Date(newest[1]);
  if (
    Number.isNaN(date.getTime()) ||
    date.toDateString() !== now.toDateString()
  ) {
    return { id: "", time: "" };
  }
  return { id: newest[0], time: newest[1] };
}

export function visibleTaskEntriesForHydration(entries, homeFilter) {
  return entries.filter(
    (entry) => homeTabForStatus(entry.homeStatus) === homeFilter,
  );
}

function needsTaskEvidenceHydration(task) {
  return Boolean(
    task?.checkId &&
      taskArtifactIds(task).length &&
      !task?.evidence?.artifactId &&
      !task?.mediaUrl &&
      !task?.thumbnailUrl,
  );
}

function mergeHydratedTasks(tasks, hydratedTasks) {
  const hydratedById = new Map(
    hydratedTasks
      .filter((task) => task?.taskId)
      .map((task) => [task.taskId, task]),
  );
  return tasks.map((task) => hydratedById.get(task.taskId) || task);
}

function readTaskStatusOverrides() {
  try {
    const raw = localStorage.getItem(TASK_STATUS_OVERRIDES_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeTaskStatusOverrides(overrides) {
  try {
    localStorage.setItem(TASK_STATUS_OVERRIDES_KEY, JSON.stringify(overrides));
  } catch {
    // Losing this overlay only affects the temporary home bucket assignment.
  }
}

function cssTimeListMs(value) {
  return String(value || "0s")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const numeric = Number.parseFloat(part);
      if (!Number.isFinite(numeric)) return 0;
      return part.endsWith("ms") ? numeric : numeric * 1000;
    });
}

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
    this._focusAfterRender = null;
    this._captureLauncherSelector = null;
    this._homeModel = null;
    this._hydrationGeneration = 0;
    this._answeringConditionIds = new Set();
    this._settingsMenuOpen = false;
    this._settingsDocumentClick = null;
    this._siteSwitcherOpen = false;
    this._siteDocumentClick = null;
    this._providerSites = [];
    this._boundSites = [];
    this._providerName = "";
    this._siteSwitchError = "";
    this._logoutDialog = null;
    this._logoutDialogOpen = false;
    this._logoutPending = false;
    this._logoutError = "";
    this._deviceLocation = getLastDeviceLocation();
    this._locationUnsub = null;
    this._locationPrompt = null;
    this._locationSelectedSiteId = "";
    this._pendingLocationRender = false;
    this._startingCapture = false;
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
    document.removeEventListener("click", this._siteDocumentClick);
    this._siteDocumentClick = null;
    this._captureFinishedListening = false;
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
    if (!this._siteDocumentClick) {
      this._siteDocumentClick = (event) => {
        if (!this._siteSwitcherOpen) return;
        const path = event.composedPath?.() || [];
        if (
          !path.some(
            (node) =>
              node instanceof Element &&
              node.matches(".home-site-switcher, #lastlog-change-site"),
          )
        ) {
          this._siteSwitcherOpen = false;
          if (this._homeModel) this._renderHome(this._homeModel);
        }
      };
      document.addEventListener("click", this._siteDocumentClick);
    }

    this._site = await getSite();
    this._siteId =
      this._site.siteId || this._site.providerSiteId || this._site.id;
    const [catalog, bindings] = await Promise.all([
      listProviderSites().catch((error) => {
        console.error("listProviderSites failed", error);
        return null;
      }),
      listBoundSites(),
    ]);
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

    if (this._isStalePendingSession(effectivePendingSession, submitted)) {
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
    void this._hydrateVisibleHomeTasks();
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
    this.querySelector("#site-switcher-trigger")?.addEventListener(
      "click",
      () => {
        this._setSiteSwitcherOpen(!this._siteSwitcherOpen);
      },
    );
    this.querySelector("#lastlog-change-site")?.addEventListener(
      "click",
      () => {
        this._setSiteSwitcherOpen(true);
      },
    );
    this.querySelector(".home-site-switcher")?.addEventListener(
      "keydown",
      (event) => {
        if (/** @type {KeyboardEvent} */ (event).key !== "Escape") return;
        this._siteSwitcherOpen = false;
        this._renderHome(this._homeModel);
        /** @type {HTMLElement | null} */ (
          this.querySelector("#site-switcher-trigger")
        )?.focus();
      },
    );
    this.querySelectorAll("[data-switch-site]").forEach((button) => {
      button.addEventListener("click", () => {
        void this._switchToSite(button.getAttribute("data-switch-site") || "");
      });
    });
    this.querySelector("#settings-logout")?.addEventListener("click", () => {
      this._settingsMenuOpen = false;
      this._logoutDialogOpen = true;
      this._renderHome(this._homeModel);
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
    this._wireLocationDialog();
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
    const selectedClearChecks =
      this._homeFilter === "history" ? clearChecks : [];
    const newClearCheck = selectedClearChecks.find(
      (check) => check.id === newestCheck.id,
    );
    const historicalClearChecks = selectedClearChecks.filter(
      (check) => check.id !== newestCheck.id,
    );
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
    const recentSessionIsClear = Boolean(
      displayRecentItems.length &&
        !pendingHasTaskCards &&
        displayRecentItems.every(
          (item) =>
            item.analysis?.status === "analyzed" && !hasProblemResults(item),
        ),
    );
    const visibleRecentItems =
      this._homeFilter === (recentSessionIsClear ? "history" : "todo")
        ? displayRecentItems
        : [];
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

    return html`
      <div
        class="home ${phaseClass} ${captureVisible ? "home--has-capture" : ""}"
      >
        <section class="home-region home-region--header">
          <div class="home-top-actions">
            <div class="home-settings-wrap">
              <button
                class="home-settings"
                id="home-settings"
                type="button"
                aria-label="Settings"
                aria-haspopup="menu"
                aria-expanded="${this._settingsMenuOpen ? "true" : "false"}"
              >
                <span class="home-settings__icon" aria-hidden="true"></span>
              </button>
              ${this._settingsMenuOpen
                ? html`<div
                    class="home-settings-menu"
                    role="menu"
                    aria-label="Settings"
                  >
                    <button id="settings-logout" type="button" role="menuitem">
                      <wa-icon
                        name="arrow-right-from-bracket"
                        aria-hidden="true"
                      ></wa-icon>
                      Logout
                    </button>
                  </div>`
                : ""}
            </div>
            <feedback-dialog class="feedback-dialog"></feedback-dialog>
          </div>
          <div
            class="screen screen--today-hero"
            role="group"
            aria-label="Today"
          >
            ${showFirstRun
              ? this._firstRunBlock()
              : this._activityBlock({
                  last,
                  homeTasks,
                })}
          </div>
        </section>

        <section class="home-region home-region--capture" aria-live="polite">
          ${captureVisible ? this._captureRegion() : ""}
        </section>

        <section
          class="home-region home-region--results"
          ${resultsInactive ? html`inert aria-hidden="true"` : ""}
        >
          ${this._homeResults({
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
            newClearCheck,
            historicalClearChecks,
          })}
        </section>
        ${hasPendingAssessment || hasResultCards ? analysisDialogs() : ""}
        ${this._locationDialogMarkup()}
        <dialog
          class="places-modal logout-dialog"
          id="logout-dialog"
          aria-labelledby="logout-title"
          aria-describedby="logout-copy"
        >
          <form class="places-modal__card" method="dialog">
            <div class="places-modal__copy">
              <h2 class="places-modal__title" id="logout-title">
                Confirm you'd like to logout
              </h2>
              <p class="places-modal__text" id="logout-copy">
                This will log you out and unlink this device: you'll need to
                request a new code to access the app
              </p>
              ${this._logoutError
                ? html`<p class="logout-dialog__error" role="alert">
                    ${this._logoutError}
                  </p>`
                : ""}
            </div>
            <div class="places-modal__actions logout-dialog__actions">
              <button
                class="places-modal__primary logout-dialog__confirm"
                id="logout-confirm"
                type="button"
                ${this._logoutPending ? "disabled" : ""}
              >
                ${this._logoutPending ? "Logging out..." : "Log me out"}
              </button>
              <button class="logout-dialog__cancel" type="submit">
                Return to app
              </button>
            </div>
          </form>
        </dialog>
      </div>
    `;
  }

  _toggleSettingsMenu() {
    this._settingsMenuOpen = !this._settingsMenuOpen;
    if (this._homeModel) this._renderHome(this._homeModel);
  }

  _closeSettingsMenu() {
    if (!this._settingsMenuOpen) return;
    this._settingsMenuOpen = false;
    if (this._homeModel) this._renderHome(this._homeModel);
  }

  _restoreLogoutDialog() {
    if (!this._logoutDialogOpen || this._logoutDialog?.open) return;
    this._logoutDialog?.showModal();
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

  _captureRegion() {
    return html`
      <div class="home-capture">
        ${this._captureFlow === "single-problem"
          ? html`<problem-report embedded></problem-report>`
          : html`<perimeter-check embedded></perimeter-check>`}
      </div>
    `;
  }

  _homeResults({
    pendingSession,
    recentCheckTime,
    checks,
    recentItems,
    newTaskEntries,
    visibleTasks,
    newClearCheck,
    historicalClearChecks,
  }) {
    const newTaskCards = this._newTaskCardEntries(newTaskEntries);
    const hasVisibleCards =
      recentItems.length ||
      newTaskEntries.length ||
      visibleTasks.length ||
      Boolean(newClearCheck) ||
      historicalClearChecks.length;
    return html`
      <div class="home-results">
        ${this._taskTabs()}
        ${recentItems.length
          ? analysisResultsTray(recentItems, pendingSession.id, {
              id: "home-analysis-results",
              title: "",
              ariaLabel: "New analysis results",
              tone: "new",
              siteName: this._site?.name || "",
              siteAddress: this._site?.address || "",
              checkTime: recentCheckTime,
              extraCards: newTaskCards,
            })
          : ""}
        ${newTaskEntries.length && !recentItems.length
          ? this._newTaskCards(newTaskEntries, recentCheckTime)
          : ""}
        ${newClearCheck && !recentItems.length && !newTaskEntries.length
          ? this._clearCheckTray(newClearCheck, true)
          : ""}
        ${visibleTasks.length || historicalClearChecks.length
          ? html`
              <div class="home-results__cards">
                ${this._historicalTaskGroups(
                  visibleTasks,
                  checks,
                  historicalClearChecks,
                )}
              </div>
            `
          : ""}
        ${!hasVisibleCards
          ? this._homeFilter === "todo" && !pendingSession
            ? homeAllDonePanel()
            : html`<p class="home-results__empty" role="status">
                ${this._homeFilter === "todo"
                  ? "No tasks to do."
                  : this._homeFilter === "in_progress"
                    ? "No tasks in progress."
                    : "No task history yet."}
              </p>`
          : ""}
      </div>
    `;
  }

  _newTaskCardEntries(entries) {
    return entries.map((entry) => ({
      markup: taskAnalysisCard({
        task: {
          ...entry.task,
          createdAt: entry.createdAt,
          siteAddress: entry.task.siteAddress || this._site?.address || "",
        },
        action:
          entry.homeStatus === "needs_action"
            ? this._primaryCardAction(entry.task)
            : null,
        statusLabel: this._newTaskStatusMeta(entry),
        isNew: true,
        includeControls: entry.homeStatus === "needs_action",
      }),
      createdAt: entry.createdAt,
      needsAnswer: Boolean(entry.task.needsAnswer),
      actionPriority: analysisActionPriority(entry.task),
    }));
  }

  _newTaskCards(entries, checkTime = "") {
    return html`
      <section
        class="analysis-tray analysis-tray--new analysis-tray--recent"
        aria-label="New analysis results"
      >
        <div class="analysis-tray__cards">
          <h2 class="analysis-tray__check-title">
            ${escapeHtml(recentCheckTitle(checkTime))}
          </h2>
          ${sortAnalysisCards(this._newTaskCardEntries(entries))
            .map((card) => card.markup)
            .join("")}
        </div>
      </section>
    `;
  }

  _clearCheckTray(check, recent = false) {
    const checkTime = check.submittedAt || check.startedAt || "";
    const title = recent
      ? recentCheckTitle(checkTime)
      : historicalCheckTitle(checkTime);
    return html`
      <section
        class="analysis-tray ${recent
          ? "analysis-tray--new analysis-tray--recent"
          : "analysis-tray--history"}"
        aria-label="${escapeAttr(title)}"
      >
        <div class="analysis-tray__cards">
          <h2 class="analysis-tray__check-title">${escapeHtml(title)}</h2>
          ${clearCheckCard()}
        </div>
      </section>
    `;
  }

  _historicalTaskGroups(entries, checks, clearChecks = []) {
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
      .map(([checkId, group]) => {
        const checkTime =
          checkTimes.get(checkId) || group[0]?.createdAt || new Date();
        return html`
          <section
            class="analysis-tray analysis-tray--history"
            aria-label="${escapeAttr(historicalCheckTitle(checkTime))}"
          >
            <div class="analysis-tray__cards">
              <h2 class="analysis-tray__check-title">
                ${escapeHtml(historicalCheckTitle(checkTime))}
              </h2>
              ${group.length
                ? sortAnalysisCards(
                    group.map((entry) => ({
                      markup: taskAnalysisCard({
                        task: {
                          ...entry.task,
                          createdAt: entry.createdAt,
                          siteAddress:
                            entry.task.siteAddress || this._site?.address || "",
                        },
                        action:
                          entry.homeStatus === "needs_action"
                            ? this._primaryCardAction(entry.task)
                            : null,
                        statusLabel: this._taskStatusMeta(entry),
                        isNew: false,
                        includeControls: entry.homeStatus === "needs_action",
                      }),
                      createdAt: entry.createdAt,
                      needsAnswer: Boolean(entry.task.needsAnswer),
                      actionPriority: analysisActionPriority(entry.task),
                    })),
                  )
                    .map((card) => card.markup)
                    .join("")
                : clearCheckCard()}
            </div>
          </section>
        `;
      })
      .join("");
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
        this._locationSelectedSiteId = this._siteId;
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
  }

  /** @param {CustomEvent<{ discarded?: boolean }>} event */
  async _finishCapture(event) {
    if (this._viewPhase === "leaving-capture") return;
    this._discardingCapture = Boolean(event.detail?.discarded);
    this._viewPhase = "leaving-capture";
    this._focusAfterRender =
      this._captureLauncherSelector || "home-primary-control";
    this._syncPhaseClass();
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

  _isStalePendingSession(session, submitted) {
    return isStalePendingSession(session, submitted);
  }

  _firstRunBlock() {
    return this._activityBlock({ last: null, homeTasks: [] });
  }

  _activityBlock({ last, homeTasks }) {
    const identity = this._siteIdentity();
    return html`
      <div class="screen__sec home-lead">
        ${this._siteSwitcher(identity.org)}
        <div class="home-identity home-identity--with-summary">
          <h1 class="home-identity__site">${escapeHtml(identity.site)}</h1>
          ${this._summaryBlock(last, homeTasks)}
        </div>
        ${this._homeActions({
          checkLabel: this._checkActionLabel(),
          reportLabel: "Flag a single issue",
        })}
      </div>
    `;
  }

  _checkActionLabel() {
    return this._hasPerimeterDraft ? "Resume a check" : "Start a full check";
  }

  _homeActions({ checkLabel = "Start a check", reportLabel, stacked = false }) {
    return html`
      <div class="home-actions ${stacked ? "home-actions--stacked" : ""}">
        <button id="start-check" class="btn-ink" type="button">
          ${escapeHtml(checkLabel)}
        </button>
        <button id="report-problem" class="btn-outline" type="button">
          ${escapeHtml(reportLabel)}
        </button>
      </div>
    `;
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

  _siteSwitcher(providerName) {
    const sites = this._providerSites.length
      ? this._providerSites
      : [{ siteId: this._siteId, name: this._site.name }];
    if (!sites.some((site) => site.siteId === this._siteId)) {
      sites.push({ siteId: this._siteId, name: this._site.name });
    }
    return html`
      <div class="home-site-switcher">
        <button
          id="site-switcher-trigger"
          class="home-site-switcher__trigger"
          type="button"
          aria-expanded="${this._siteSwitcherOpen ? "true" : "false"}"
          aria-controls="site-switcher-list"
        >
          <span>${escapeHtml(providerName || "Your provider")}</span>
          <wa-icon name="chevron-left" aria-hidden="true"></wa-icon>
        </button>
        ${this._siteSwitcherOpen
          ? html`<div id="site-switcher-list" class="home-site-switcher__menu">
              ${sites
                .map(
                  (site) =>
                    html`<button
                      class="home-site-switcher__item ${site.siteId ===
                      this._siteId
                        ? "home-site-switcher__item--selected"
                        : ""}"
                      type="button"
                      data-switch-site="${escapeAttr(site.siteId)}"
                      ${site.siteId === this._siteId
                        ? 'aria-current="page"'
                        : ""}
                    >
                      <span class="home-site-switcher__check" aria-hidden="true"
                        >${site.siteId === this._siteId ? "✓" : ""}</span
                      >
                      <span>${escapeHtml(site.name)}</span>
                    </button>`,
                )
                .join("")}
              ${this._siteSwitchError
                ? html`<p class="home-site-switcher__error" role="alert">
                    ${escapeHtml(this._siteSwitchError)}
                  </p>`
                : ""}
            </div>`
          : ""}
      </div>
    `;
  }

  _setSiteSwitcherOpen(open) {
    this._siteSwitcherOpen = open;
    this._siteSwitchError = "";
    this._renderHome(this._homeModel);
    /** @type {HTMLElement | null} */ (
      this.querySelector("#site-switcher-trigger")
    )?.focus();
  }

  _locationDialogMarkup() {
    const sites = this._providerSites.length
      ? [...this._providerSites]
      : [{ siteId: this._siteId, name: this._site?.name || "Your site" }];
    if (!sites.some((site) => site.siteId === this._siteId)) {
      sites.unshift({
        siteId: this._siteId,
        name: this._site?.name || "Your site",
      });
    }
    return html`<dialog
      class="location-dialog"
      id="location-dialog"
      aria-labelledby="location-dialog-title"
      aria-describedby="location-dialog-copy"
    >
      <div class="location-dialog__card">
        <div class="location-dialog__copy">
          <h2 id="location-dialog-title">
            Is your app set to the right location
          </h2>
          <p id="location-dialog-copy">
            It looks like you're not near
            ${escapeHtml(this._site?.name || "this site")}. Consider changing
            your app's site.
          </p>
        </div>
        <div
          class="location-dialog__sites"
          role="group"
          aria-label="Choose a site"
        >
          ${sites
            .map(
              (site) =>
                html`<button
                  class="home-site-switcher__item location-dialog__site"
                  type="button"
                  data-location-site="${escapeAttr(site.siteId)}"
                  aria-pressed="${site.siteId === this._siteId
                    ? "true"
                    : "false"}"
                >
                  <span class="home-site-switcher__check" aria-hidden="true"
                    >${site.siteId === this._siteId ? "✓" : ""}</span
                  >
                  <span>${escapeHtml(site.name)}</span>
                </button>`,
            )
            .join("")}
        </div>
        <div class="location-dialog__actions">
          <button
            class="location-dialog__confirm"
            id="location-confirm"
            type="button"
            disabled
          >
            Confirm site change
          </button>
          <button
            class="location-dialog__stay"
            id="location-stay"
            type="button"
          >
            I'm in the right location
          </button>
        </div>
      </div>
    </dialog>`;
  }

  _wireLocationDialog() {
    const dialog = /** @type {HTMLDialogElement | null} */ (
      this.querySelector("#location-dialog")
    );
    if (!dialog) return;
    dialog.addEventListener("close", () => {
      const changingSite = this._locationSelectedSiteId !== this._siteId;
      this._locationPrompt = null;
      if (this._pendingLocationRender) {
        this._pendingLocationRender = false;
        if (!changingSite && this._viewPhase === "home" && this._homeModel) {
          this._renderHome(this._homeModel);
        }
      }
    });
    dialog.querySelectorAll("[data-location-site]").forEach((button) => {
      button.addEventListener("click", () => {
        this._locationSelectedSiteId =
          button.getAttribute("data-location-site") || this._siteId;
        dialog.querySelectorAll("[data-location-site]").forEach((option) => {
          const selected =
            option.getAttribute("data-location-site") ===
            this._locationSelectedSiteId;
          option.setAttribute("aria-pressed", String(selected));
          const check = option.querySelector(".home-site-switcher__check");
          if (check) check.textContent = selected ? "✓" : "";
        });
        const confirm = /** @type {HTMLButtonElement | null} */ (
          dialog.querySelector("#location-confirm")
        );
        if (confirm)
          confirm.disabled = this._locationSelectedSiteId === this._siteId;
      });
    });
    dialog.querySelector("#location-confirm")?.addEventListener("click", () => {
      if (this._locationSelectedSiteId === this._siteId) return;
      dialog.close();
      void this._switchToSite(this._locationSelectedSiteId);
    });
    dialog.querySelector("#location-stay")?.addEventListener("click", () => {
      const prompt = this._locationPrompt;
      dialog.close();
      if (prompt) void this._enterCapture(prompt.flowType, prompt.launcher);
    });
  }

  _showLocationDialog() {
    /** @type {HTMLDialogElement | null} */ (
      this.querySelector("#location-dialog")
    )?.showModal();
  }

  async _requestAnotherSite(mode = "code", siteId = "", siteName = "") {
    const active = getCurrentCheck();
    if (active?.status === "capture-complete") {
      this._siteSwitchError =
        "Wait for this check to finish analyzing before switching sites.";
      this._renderHome(this._homeModel);
      return;
    }
    try {
      if (active) await pauseCheck();
      discardInMemorySession();
      this._siteSwitcherOpen = false;
      this.dispatchEvent(
        new CustomEvent("siterequested", {
          bubbles: true,
          detail: { siteId, siteName, mode },
        }),
      );
    } catch (error) {
      console.error("site switch preparation failed", error);
      this._siteSwitchError =
        "We couldn't save this check before switching sites.";
      this._renderHome(this._homeModel);
    }
  }

  async _switchToSite(siteId) {
    if (!siteId || siteId === this._siteId) {
      this._siteSwitcherOpen = false;
      this._renderHome(this._homeModel);
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
      this._siteSwitchError =
        "Wait for this check to finish analyzing before switching sites.";
      this._renderHome(this._homeModel);
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
      this._siteSwitchError = "We couldn't switch sites. Try again.";
      this._renderHome(this._homeModel);
    }
  }

  // Last submitted check only: its recorded issue count and remaining actions.
  _summaryBlock(last, homeTasks) {
    if (isOutsideSiteRadius(this._deviceLocation, this._site?.location)) {
      return html`<div class="lastlog">
        <p class="lastlog__eyebrow">
          Looks like you're not near this site.
          <button
            id="lastlog-change-site"
            class="lastlog__switch"
            type="button"
            appearance="plain"
          >
            Change the site
          </button>
        </p>
      </div>`;
    }
    const label = lastLogSummary(last, homeTasks);
    if (!label) return "";
    return html`
      <div class="lastlog">
        <p class="lastlog__eyebrow">${escapeHtml(label)}</p>
      </div>
    `;
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

  _taskTabs() {
    return html`
      <div class="home-tabs" role="tablist" aria-label="Tasks">
        ${HOME_TABS.map(
          (tab) => html`
            <button
              class="home-tabs__tab ${tab.id === this._homeFilter
                ? "home-tabs__tab--active"
                : ""}"
              type="button"
              role="tab"
              aria-selected="${tab.id === this._homeFilter ? "true" : "false"}"
              tabindex="${tab.id === this._homeFilter ? "0" : "-1"}"
              data-home-filter="${escapeAttr(tab.id)}"
            >
              ${escapeHtml(tab.label)}
            </button>
          `,
        ).join("")}
      </div>
    `;
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

  // A boxed worklist group (design "D2 boxed groups"). Omitted when empty.
  _group(title, items, className) {
    if (!items.length) return "";
    return html`
      <section class="worklist__group ${className}">
        <h2 class="worklist__label">${escapeHtml(title)}</h2>
        <div class="worklist__cards">
          ${items.map((t) => this._actionCard(t)).join("")}
        </div>
      </section>
    `;
  }

  // A single open task, rendered from its real TASK# fields: when it was flagged,
  // the guidance label, the guidance text, and the task's own action buttons.
  _actionCard(task) {
    const when = task.createdAt
      ? `${relativeDay(task.createdAt)} · ${timeOf(task.createdAt)}`
      : "";
    const title =
      task.userFriendlyLabel ||
      task.user_friendly_label ||
      task.label ||
      task.category ||
      "Finding";
    const detail = task.guidance || task.category || "";
    const category = task.category || "";
    const actions = this._cardActions(task);
    return html`
      <div class="actioncard" data-task-id="${escapeHtml(task.taskId)}">
        <div class="actioncard__body">
          ${when
            ? html`<span class="actioncard__time">${escapeHtml(when)}</span>`
            : ""}
          <h3 class="actioncard__title">${escapeHtml(title)}</h3>
          ${detail
            ? html`<p class="actioncard__detail">${escapeHtml(detail)}</p>`
            : ""}
          ${category
            ? html`<p class="actioncard__category">${escapeHtml(category)}</p>`
            : ""}
        </div>
        ${actions.length
          ? html`<div class="actioncard__actions">
              ${actions.map((a) => this._actionButton(a)).join("")}
            </div>`
          : ""}
        <p class="actioncard__error" role="alert" hidden></p>
      </div>
    `;
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

  _actionButton(a) {
    const cls =
      a.variant === "ink"
        ? "btn-ink btn-ink--sm"
        : a.variant === "blue"
          ? "btn-blue btn-blue--sm"
          : "btn-outline btn-outline--sm";
    // Link-style actions render as native anchors with no data-action, so the
    // click wiring skips them and the browser handles the URL.
    if (a.href) {
      return html`<a class="${cls}" href="${a.href}"
        >${escapeHtml(a.label)}</a
      >`;
    }
    // An email whose target isn't known yet: surface the instruction but keep
    // it non-interactive rather than misdialing or opening an empty composer.
    if (a.kind === "email") {
      return html`<button type="button" class="${cls}" disabled>
        ${escapeHtml(a.label)}
      </button>`;
    }
    return html`<button type="button" class="${cls}" data-action="${a.kind}">
      ${escapeHtml(a.label)}
    </button>`;
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
    if (action === "delete") {
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

  _problemFromCard(card, task = null) {
    return {
      itemId: card.getAttribute("data-item-id") || "",
      checkId: card.getAttribute("data-check-id") || task?.checkId || "",
      artifactId:
        card.getAttribute("data-artifact-id") ||
        (task ? taskArtifactIds(task)[0] : "") ||
        "",
      taskId: card.getAttribute("data-task-id") || task?.taskId || "",
      conditionId:
        card.getAttribute("data-condition-id") || task?.conditionId || "",
      actionKind: card.getAttribute("data-action-kind") || task?.kind || "",
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
    this._analysisDeleteDialog?.showModal();
  }

  _openEditProblem(problem) {
    this._activeProblem = problem;
    this._setDialogError("analysis-edit-error", "");
    if (this._analysisEditDescription) {
      this._analysisEditDescription.value = problem.description;
    }
    this._analysisEditDialog?.showModal();
  }

  async _confirmDeleteProblem() {
    const problem = this._activeProblem;
    if (!problem || this._deletingProblem) return;
    if (!problem.checkId || !problem.artifactId || !problem.conditionId) {
      this._setDialogError(
        "analysis-delete-error",
        "This result is missing its original evidence coordinates, so it cannot be deleted. Take a new photo and try again.",
      );
      return;
    }

    this._deletingProblem = true;
    const button = this.querySelector(
      ":scope > .home > #analysis-delete-dialog #analysis-delete-confirm",
    );
    const focusUndo = button?.matches(":focus-visible") || false;
    this._setBusy(button, true);
    this._setDialogError("analysis-delete-error", "");
    try {
      await deleteAnalysisCard(
        this,
        problem,
        async () => {
          let result;
          try {
            result = await rejectAnalysisCondition(
              problem.checkId,
              problem.artifactId,
              problem.conditionId,
              {
                reason: { key: "not_a_problem" },
                ...(problem.taskId ? { taskId: problem.taskId } : {}),
                caller: { request_id: this._requestId("delete", problem) },
              },
            );
          } catch (err) {
            if (!(err instanceof ApiError) || err.status !== 404) throw err;
            if (getCurrentCheck()?.id === problem.checkId)
              this._deleteProblemLocally(problem);
            return;
          }
          if (!result?.assessment) {
            this._deleteProblemLocally(problem);
            return;
          }
          if (getCurrentCheck()?.id === problem.checkId && problem.itemId) {
            await refreshEvidenceAnalysis(problem.itemId, result, {
              rejectedConditionId: problem.conditionId,
            }).catch((error) => {
              console.error("refresh after saved deletion failed", error);
              if (getCurrentCheck()?.id === problem.checkId)
                this._deleteProblemLocally(problem);
            });
          }
        },
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
      this._setBusy(button, false);
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
          "This result is missing its original evidence coordinates, so it cannot be edited. Take a new photo and try again.",
        );
        return;
      }
      const button = this.querySelector(
        ":scope > .home > #analysis-edit-dialog #analysis-edit-save",
      );
      this._setBusy(button, true);
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
        this._setBusy(button, false);
      }
      return;
    }
    if (!problem.checkId || !problem.artifactId || !problem.conditionId) {
      this._setDialogError(
        "analysis-edit-error",
        "This result is missing its original evidence coordinates, so it cannot be edited. Take a new photo and try again.",
      );
      return;
    }

    const button = this.querySelector(
      ":scope > .home > #analysis-edit-dialog #analysis-edit-save",
    );
    this._setBusy(button, true);
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
      this._setBusy(button, false);
    }
  }

  _deleteProblemLocally(problem) {
    if (!problem.itemId) return;
    const item = this._sessionItem(problem);
    updateItemAnalysis(problem.itemId, {
      tasks: (item?.analysis?.tasks || []).filter(
        (task) => task.taskId !== problem.taskId,
      ),
      rejectedConditionIds: [
        ...(item?.analysis?.rejectedConditionIds || []),
        problem.conditionId,
      ].filter(Boolean),
    });
  }

  async _resolveAnalysisProblem(problem) {
    if (!problem.taskId) {
      this._markAnalysisProblemResolved(problem);
      this._analysisSuccessDialog?.showModal();
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
      this._analysisSuccessDialog?.showModal();
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
    if (problem.itemId) {
      const item = this._sessionItem(problem);
      updateItemAnalysis(problem.itemId, {
        tasks: (item?.analysis?.tasks || []).filter(
          (task) => task.taskId !== problem.taskId,
        ),
        resolvedConditionIds: [
          ...(item?.analysis?.resolvedConditionIds || []),
          problem.conditionId,
        ].filter(Boolean),
      });
    }
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
    const error = this.querySelector(
      `:scope > .home > .analysis-dialog #${id}`,
    );
    if (!(error instanceof HTMLElement)) return;
    error.textContent = message;
    error.hidden = !message;
  }

  _setBusy(button, busy) {
    if (!(button instanceof HTMLButtonElement)) return;
    button.disabled = busy;
    button.setAttribute("aria-busy", busy ? "true" : "false");
  }

  _requestId(action, problem) {
    const suffix =
      globalThis.crypto?.randomUUID?.() ||
      `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return `${problem.checkId}:${problem.artifactId}:${problem.conditionId}:${action}:${suffix}`;
  }

  _onAction(card, task, btn) {
    const action = btn.getAttribute("data-action");
    if (action === "done") {
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
    actions.innerHTML = html`
      ${reasons
        .map(
          (r) =>
            html`<button
              type="button"
              class="btn-outline btn-outline--sm"
              data-action="cant-reason"
              data-reason="${escapeHtml(r)}"
            >
              ${escapeHtml(r)}
            </button>`,
        )
        .join("")}
      <button
        type="button"
        class="home-cta__link actioncard__cancel"
        data-action="cant-cancel"
      >
        Cancel
      </button>
    `;
    this._wireCardButtons(card, task);
  }

  _restoreActions(card, task) {
    const actions = card.querySelector(
      ".analysis-card__actions, .actioncard__actions",
    );
    if (!actions) return;
    actions.innerHTML = this._cardActions(task)
      .map((a) => this._actionButton(a))
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
    this.innerHTML = html`
      <div class="home">
        <div class="screen" role="group" aria-label="Today">
          <div class="screen__sec home-lead">
            <div class="home-identity">
              ${identity.org
                ? html`<p class="home-identity__org">
                    ${escapeHtml(identity.org)}
                  </p>`
                : ""}
              <h1 class="home-identity__site">${escapeHtml(identity.site)}</h1>
            </div>
            <div class="lastlog">
              <p class="lastlog__eyebrow">CAN’T REACH THE SERVER</p>
              <p class="lastlog__summary">Checks are unavailable</p>
            </div>
            <div class="home-actions">
              <button id="retry" class="btn-ink" type="button">
                Try again
              </button>
            </div>
          </div>
        </div>
      </div>
    `;
    this.querySelector("#retry")?.addEventListener("click", () =>
      this.connectedCallback(),
    );
  }
}

function timeOf(iso) {
  return new Date(iso)
    .toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    .replace(/\s/g, "")
    .toUpperCase();
}

// "TODAY" / "YESTERDAY" for the last 2 days, else the uppercase weekday.
function relativeDay(iso) {
  const d = new Date(iso);
  const dStart = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const ago = Math.round((todayStart.getTime() - dStart.getTime()) / 86400000);
  if (ago <= 0) return "TODAY";
  if (ago === 1) return "YESTERDAY";
  return d.toLocaleDateString([], { weekday: "long" }).toUpperCase();
}

function splitSiteIdentity(name) {
  for (const delimiter of [" · ", " — ", " – ", " - ", ": "]) {
    if (!name.includes(delimiter)) continue;
    const [org, ...rest] = name.split(delimiter);
    const site = rest.join(delimiter).trim();
    if (org.trim() && site) {
      return { org: org.trim(), site };
    }
  }
  return null;
}

customElements.define("today-view", TodayView);
