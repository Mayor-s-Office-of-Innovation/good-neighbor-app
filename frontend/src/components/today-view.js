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
import { html, escapeHtml, escapeAttr } from "../lib/html.js";
import { getSite } from "../db.js";
import {
  listChecks,
  listTasks,
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
} from "../services/photo-analysis.js";
import {
  adaptCheckHeader,
  cityCategoriesByCheck,
} from "../domain/check-adapter.js";
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
  resumeOrStartCheck,
  resumeOrStartProblemReport,
  updateItemAnalysis,
} from "../state/check-session.js";
import { navigate } from "../router.js";
import { mark } from "../services/instrument.js";
import {
  analysisResultsTray,
  taskAnalysisCard,
} from "./analysis-results.templates.js";
import { setQuestionAnswerBusy } from "./analysis-answer-controls.js";
import { analysisDialogs } from "./perimeter-check.templates.js";
import {
  finalizeCaptureScorecardInBackground,
  resumeSubmittedCheckInBackground,
  resumeUploadingCheckInBackground,
} from "../services/submit-check.js";

const HOME_FILTERS = [
  { id: "needs_action", label: "Needs Action" },
  { id: "in_progress", label: "In progress" },
  { id: "resolved", label: "Resolved" },
  { id: "archived", label: "Archived" },
];
const NEW_TASK_WINDOW_MS = 3 * 60 * 60 * 1000;
const ARCHIVE_AFTER_MS = 72 * 60 * 60 * 1000;
const TASK_STATUS_OVERRIDES_KEY = "gnp-home-task-status-overrides";
const CHECK_ARTIFACTS_CACHE = new Map();
const MEDIA_URL_CACHE = new Map();

/**
 * Decide whether a local pending/review session has been superseded by backend history.
 * @param {{ id: string, status?: string, submittedAt?: string } | null} session
 * @param {Array<{ id: string, status?: string, submittedAt?: string }>} submitted
 * @returns {boolean}
 */
export function isStalePendingSession(session, submitted) {
  if (!session) return false;
  if (session.status === "submitted") {
    return submitted.length > 0 && submitted[0].id !== session.id;
  }
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
  const filter =
    HOME_FILTERS.find((candidate) => candidate.id === filterId) ||
    HOME_FILTERS[0];
  return `${filter.label} • ${counts[filter.id] || 0}`;
}

export function homeTaskStatus(task, override, now = new Date()) {
  const status = String(task.status || "open");
  if (status === "completing" || status === "in_progress") {
    return "in_progress";
  }
  if (status === "completed" || status === "cannot_do") {
    if (status === "completed" && task.completionMethod === "311_filed") {
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

export function currentIssueCount(entries) {
  return entries.filter((entry) =>
    ["needs_action", "in_progress"].includes(entry.homeStatus),
  ).length;
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
      const evidence = {
        artifactId: artifact.artifactId || "",
        placeId: artifact.placeId || task.placeId || "",
        placeName:
          artifact.placeName ||
          task.placeName ||
          task.positionDescriptor ||
          task.position_descriptor ||
          task.location ||
          "",
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

export function visibleTaskEntriesForHydration(entries, homeFilter) {
  return entries.filter(
    (entry) => entry.isNew || entry.homeStatus === homeFilter,
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
    this._captureFinishedHandler = () => this._finishCapture();
    this._captureFinishedListening = false;
    this._capturePhaseTimer = 0;
    this._focusAfterRender = null;
    this._captureLauncherSelector = null;
    this._homeModel = null;
    this._hydrationGeneration = 0;
    this._answeringConditionIds = new Set();
  }

  disconnectedCallback() {
    this._sessionUnsub?.();
    this._sessionUnsub = null;
    this.removeEventListener("capturefinished", this._captureFinishedHandler);
    this._captureFinishedListening = false;
    window.clearTimeout(this._capturePhaseTimer);
  }

  async connectedCallback() {
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
      this._captureFinishedListening = true;
    }

    this._site = await getSite();
    this._siteId =
      this._site.siteId || this._site.providerSiteId || this._site.id;

    const active = getCurrentCheck();
    const captureSession = active?.status === "in-progress" ? active : null;
    if (captureSession) {
      this._captureFlow = captureSession.flowType || "perimeter";
      if (this._viewPhase === "home") this._viewPhase = "capture";
    }
    const pendingSession =
      active &&
      [
        "capture-complete",
        "uploading",
        "analyzing",
        "analysis_failed",
        "submitted",
      ].includes(active.status)
        ? active
        : await loadSubmitted();

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
      const cityByCheck = cityCategoriesByCheck(tasks);
      submitted = (checks || [])
        .map((h) => adaptCheckHeader(h, cityByCheck.get(h.checkId)))
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
      pendingSession &&
      [
        "capture-complete",
        "uploading",
        "analyzing",
        "analysis_failed",
        "submitted",
      ].includes(pendingSession.status)
        ? pendingSession
        : null;

    if (this._isStalePendingSession(effectivePendingSession, submitted)) {
      await clearSubmittedSession();
      effectivePendingSession = null;
    } else if (effectivePendingSession?.status === "capture-complete") {
      finalizeCaptureScorecardInBackground(effectivePendingSession.id, {
        expectedArtifacts: effectivePendingSession.expectedArtifacts,
      });
    } else if (effectivePendingSession?.status === "uploading") {
      resumeUploadingCheckInBackground(effectivePendingSession.id, {
        flowType: effectivePendingSession.flowType,
        submissionKind: effectivePendingSession.submissionKind,
      });
    } else if (effectivePendingSession?.status === "analyzing") {
      resumeSubmittedCheckInBackground(effectivePendingSession.id, {
        expectedArtifacts: effectivePendingSession.expectedArtifacts,
      });
    }

    // A resumable in-progress walk (Cancel from /check keeps it) still reopens
    // the draft, even though the home CTAs now use the simplified Figma copy.
    this._taskOverrides = readTaskStatusOverrides();
    this._homeFilter = this._homeFilter || "needs_action";
    this._activeProblem = null;
    this._hasPerimeterDraft = await hasDraft("perimeter");
    this._renderHome({
      last,
      tasks,
      captureSession,
      pendingSession: effectivePendingSession,
    });
    void this._hydrateVisibleHomeTasks();
  }

  _renderHome(model) {
    this._homeModel = model;
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
    this.querySelector("#edit-places")?.addEventListener("click", () =>
      navigate("/places/edit"),
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
    this.querySelector("#task-filter-button")?.addEventListener("click", () =>
      this._toggleTaskFilter(),
    );
    this.querySelectorAll("[data-home-filter]").forEach((button) => {
      button.addEventListener("click", () => {
        this._homeFilter =
          button.getAttribute("data-home-filter") || "needs_action";
        this._filterOpen = false;
        this._focusAfterRender = "task-filter-button";
        if (this._homeModel) {
          this._renderHome(this._homeModel);
          void this._hydrateVisibleHomeTasks();
        }
      });
    });
    const review = this.querySelector("#review-assessment");
    if (review) {
      review.addEventListener("click", () => {
        // Brackets human think-time: submit:done → review:open is the user
        // deciding to review; review:open → review:rendered is the screen load.
        mark("review:open");
        navigate("/results");
      });
    }
    this._cancelDialog = /** @type {HTMLDialogElement | null} */ (
      this.querySelector("#cancel-assessment-dialog")
    );
    this._analysisDeleteDialog = /** @type {HTMLDialogElement | null} */ (
      this.querySelector("#analysis-delete-dialog")
    );
    this._analysisSuccessDialog = /** @type {HTMLDialogElement | null} */ (
      this.querySelector("#analysis-success-dialog")
    );
    this._analysisEditDialog = /** @type {HTMLDialogElement | null} */ (
      this.querySelector("#analysis-edit-dialog")
    );
    this._analysisEditDescription = /** @type {HTMLTextAreaElement | null} */ (
      this.querySelector("#analysis-edit-description")
    );
    this.querySelector("#cancel-assessment-open")?.addEventListener(
      "click",
      () => this._cancelDialog?.showModal(),
    );
    this.querySelector("#cancel-assessment-keep")?.addEventListener(
      "click",
      () => this._cancelDialog?.close(),
    );
    this.querySelector("#cancel-assessment-confirm")?.addEventListener(
      "click",
      async () => {
        await clearSubmittedSession();
        this._cancelDialog?.close();
        this.connectedCallback();
      },
    );
    this._cancelDialog?.addEventListener("click", (e) => {
      if (e.target === this._cancelDialog) this._cancelDialog.close();
    });
    this.querySelector("#analysis-delete-confirm")?.addEventListener(
      "click",
      () => this._confirmDeleteProblem(),
    );
    this.querySelector("#analysis-edit-save")?.addEventListener("click", () =>
      this._saveProblemEdit(),
    );
    this.querySelectorAll(".analysis-dialog").forEach((dialog) => {
      dialog.addEventListener("click", (e) => {
        if (e.target === dialog) {
          /** @type {HTMLDialogElement} */ (dialog).close();
        }
      });
    });
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

  _render({ last, tasks, captureSession, pendingSession }) {
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
    const issueCount = currentIssueCount(homeTasks);
    const newTaskEntries = homeTasks.filter((entry) => entry.isNew);
    const bucketTaskEntries = homeTasks.filter((entry) => !entry.isNew);
    const statusCounts = this._statusCounts(bucketTaskEntries);
    const visibleTasks = newestTasksFirst(
      bucketTaskEntries.filter(
        (entry) => entry.homeStatus === this._homeFilter,
      ),
    );
    const hasPendingAssessment = !!pendingSession;
    const hasResultCards = recentItems.length || newTaskEntries.length;
    const captureVisible =
      Boolean(captureSession) || this._viewPhase === "leaving-capture";
    const showFirstRun = shouldShowFirstRunHome({
      captureVisible,
      last,
      taskCount: tasks.length,
      hasResultCards,
    });
    const showWorklist =
      hasPendingAssessment ||
      recentItems.length ||
      newTaskEntries.length ||
      bucketTaskEntries.length > 0;
    const phaseClass = `home--${this._viewPhase}`;
    const resultsInactive = shouldInertHomeResults(this._viewPhase);

    return html`
      <div
        class="home ${showFirstRun
          ? "home--first-run"
          : ""} ${phaseClass} ${captureVisible ? "home--has-capture" : ""}"
      >
        <section class="home-region home-region--header">
          <div class="home-top-actions">
            <button
              class="home-settings"
              id="edit-places"
              type="button"
              aria-label="Edit places"
            >
              <span class="home-settings__icon" aria-hidden="true"></span>
            </button>
            <feedback-dialog class="feedback-dialog"></feedback-dialog>
          </div>
          <div
            class="screen screen--today-hero ${showFirstRun
              ? "screen--first-run"
              : ""}"
            role="group"
            aria-label="Today"
          >
            ${showFirstRun
              ? this._firstRunBlock()
              : this._activityBlock({
                  last,
                  issueCount,
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
          ${showWorklist
            ? html`
                ${hasResultCards
                  ? ""
                  : html`<div class="home-divider" aria-hidden="true"></div>`}
                ${this._homeResults({
                  pendingSession,
                  recentItems,
                  newTaskEntries,
                  visibleTasks,
                  statusCounts,
                  hasBucketTasks: bucketTaskEntries.length > 0,
                })}
              `
            : ""}
        </section>
        ${pendingSession ? this._cancelAssessmentDialog() : ""}
        ${showWorklist ? analysisDialogs() : ""}
      </div>
    `;
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
    recentItems,
    newTaskEntries,
    visibleTasks,
    statusCounts,
    hasBucketTasks,
  }) {
    const hasNewResults = recentItems.length || newTaskEntries.length;
    const hasActiveNewAnalysis = recentItems.some((item) =>
      ["queued", "analyzing"].includes(item.analysis?.status),
    );
    const wrapSection =
      hasNewResults && !hasActiveNewAnalysis ? this._wrapSection() : "";
    return html`
      <div class="home-results">
        ${pendingSession &&
        pendingSession.status !== "capture-complete" &&
        !recentItems.length
          ? this._assessmentTile(pendingSession)
          : ""}
        ${recentItems.length
          ? analysisResultsTray(recentItems, pendingSession.id, {
              id: "home-analysis-results",
              title: "",
              ariaLabel: "New analysis results",
              tone: "new",
              footer: newTaskEntries.length ? "" : wrapSection,
            })
          : ""}
        ${newTaskEntries.length
          ? this._newTaskCards(newTaskEntries, wrapSection)
          : ""}
        ${hasBucketTasks
          ? html`
              ${recentItems.length || newTaskEntries.length
                ? html`<div
                    class="home-results__divider"
                    aria-hidden="true"
                  ></div>`
                : ""}
              ${this._taskFilter(statusCounts)}
              <div class="home-results__cards">
                ${visibleTasks
                  .map((entry) =>
                    taskAnalysisCard({
                      task: entry.task,
                      action:
                        entry.homeStatus === "needs_action"
                          ? this._primaryCardAction(entry.task)
                          : null,
                      statusLabel: this._taskStatusMeta(entry),
                      isNew: false,
                      includeControls: entry.homeStatus === "needs_action",
                    }),
                  )
                  .join("")}
              </div>
            `
          : ""}
      </div>
    `;
  }

  _wrapSection() {
    return html`
      <section class="home-wrap" aria-label="New issue summary">
        <h2>That's a wrap</h2>
        <p>
          We didn't identify any other new issues.
          <a
            class="home-wrap__link"
            href="#flag-single-issue"
            data-start-capture="single-problem"
          >
            Flag a single issue
          </a>
          if we missed something, or check below for older pending or resolved
          issues.
        </p>
      </section>
    `;
  }

  _newTaskCards(entries, footer = "") {
    return html`
      <section
        class="analysis-tray analysis-tray--new"
        aria-label="New analysis results"
      >
        <div class="analysis-tray__cards">
          ${newestTaskEntriesFirst(entries)
            .map((entry) =>
              taskAnalysisCard({
                task: entry.task,
                action: this._primaryCardAction(entry.task),
                statusLabel: this._newTaskStatusMeta(entry),
                isNew: true,
              }),
            )
            .join("")}
          ${footer}
        </div>
      </section>
    `;
  }

  async _startCapture(flowType, launcher = null) {
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
      await resumeOrStartCheck(this._siteId, this._site.places || []);
    }
    await this.connectedCallback();
    this._scrollCaptureStartIntoView();
    this._afterCaptureAnimation("entering-capture", () => {
      this._viewPhase = "capture";
      this._syncPhaseClass();
    });
  }

  async _finishCapture() {
    if (this._viewPhase === "leaving-capture") return;
    this._viewPhase = "leaving-capture";
    this._focusAfterRender =
      this._captureLauncherSelector || "home-primary-control";
    this._syncPhaseClass();
    this._afterCaptureAnimation("leaving-capture", async () => {
      this._viewPhase = "home";
      this._captureFlow = null;
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

  _assessmentTile(session) {
    if (session.status === "submitted") {
      return html`
        <section
          class="assessment-tile assessment-tile--ready"
          aria-live="polite"
        >
          <div class="assessment-tile__card">
            <div class="assessment-tile__top">
              <p class="assessment-tile__eyebrow">
                <span class="assessment-tile__spark" aria-hidden="true">✦</span>
                AI analysis complete
              </p>
              <wa-button
                id="cancel-assessment-open"
                class="assessment-tile__dismiss"
                type="button"
                appearance="plain"
                size="small"
                aria-label="Cancel existing submission"
              >
                <wa-icon name="xmark" aria-hidden="true"></wa-icon>
              </wa-button>
            </div>
            <p class="assessment-tile__headline">
              Report ready to review and confirm.
            </p>
            <div class="assessment-tile__actions">
              <wa-button
                id="review-assessment"
                type="button"
                appearance="outlined"
                size="small"
              >
                Review assessment
              </wa-button>
            </div>
          </div>
        </section>
      `;
    }

    if (session.status === "analysis_failed") {
      const pausedLabel =
        session.pendingStage === "upload"
          ? "Upload paused"
          : "AI analysis paused";
      return html`
        <section
          class="assessment-tile assessment-tile--error"
          aria-live="polite"
        >
          <div class="assessment-tile__card">
            <div class="assessment-tile__top">
              <p class="assessment-tile__eyebrow">${escapeHtml(pausedLabel)}</p>
              <wa-button
                id="cancel-assessment-open"
                class="assessment-tile__dismiss"
                type="button"
                appearance="plain"
                size="small"
                aria-label="Cancel existing submission"
              >
                <wa-icon name="xmark" aria-hidden="true"></wa-icon>
              </wa-button>
            </div>
            <p class="assessment-tile__headline">
              ${escapeHtml(
                session.analysisError ||
                  "Couldn’t finish analyzing this submission.",
              )}
            </p>
          </div>
        </section>
      `;
    }

    const label =
      session.submissionKind === "problem_report" ? "problem report" : "check";
    const time = session.submittedAt ? timeOf(session.submittedAt) : "";
    const isUploading = session.status === "uploading";
    const eyebrow = isUploading
      ? time
        ? `Uploading your ${time} ${label}`
        : `Uploading your latest ${label}`
      : time
        ? `AI is analyzing the ${time} ${label}`
        : `AI is analyzing the latest ${label}`;
    const headline = isUploading
      ? "Uploading your report..."
      : session.submissionKind === "problem_report"
        ? "Problem report received and being analyzed..."
        : "Report received and being analyzed for problems...";

    return html`
      <section class="assessment-tile" aria-live="polite">
        <div class="assessment-tile__card">
          <div class="assessment-tile__top">
            <p class="assessment-tile__eyebrow">
              <span class="assessment-tile__spark" aria-hidden="true">✦</span>
              ${escapeHtml(eyebrow)}
            </p>
            <wa-button
              id="cancel-assessment-open"
              class="assessment-tile__dismiss"
              type="button"
              appearance="plain"
              size="small"
              aria-label="Cancel existing submission"
            >
              <wa-icon name="xmark" aria-hidden="true"></wa-icon>
            </wa-button>
          </div>
          <p class="assessment-tile__headline">${escapeHtml(headline)}</p>
          <div
            class="assessment-tile__progress"
            role="img"
            aria-label="${isUploading
              ? "Upload in progress"
              : "Analysis in progress"}"
          >
            <span class="assessment-tile__bar"></span>
          </div>
        </div>
      </section>
    `;
  }

  _cancelAssessmentDialog() {
    return html`
      <dialog
        class="sheet"
        id="cancel-assessment-dialog"
        aria-label="Cancel existing submission?"
      >
        <div class="sheet__panel">
          <div class="sheet__actions">
            <wa-button
              class="sheet__cancel"
              type="button"
              id="cancel-assessment-keep"
              appearance="outlined"
            >
              Keep it
            </wa-button>
          </div>
          <ul class="sheet__opts">
            <li>
              <wa-button
                class="sheet__opt sheet__opt--danger"
                id="cancel-assessment-confirm"
                type="button"
                appearance="filled"
                variant="danger"
              >
                Cancel analysis
              </wa-button>
            </li>
          </ul>
        </div>
      </dialog>
    `;
  }
  _firstRunBlock() {
    return html`
      <div class="screen__sec home-lead home-lead--first-run">
        <div class="home-first-run">
          <h1 class="home-first-run__title">Start your first check</h1>
          ${this._homeActions({
            checkLabel: this._checkActionLabel(),
            reportLabel: "Flag a single issue",
            stacked: true,
          })}
        </div>
      </div>
    `;
  }

  _activityBlock({ last, issueCount }) {
    const identity = this._siteIdentity();
    return html`
      <div class="screen__sec home-lead">
        <div class="home-identity">
          ${identity.org
            ? html`<p class="home-identity__org">
                ${escapeHtml(identity.org)}
              </p>`
            : ""}
          <h1 class="home-identity__site">${escapeHtml(identity.site)}</h1>
        </div>
        ${this._summaryBlock(last, issueCount)}
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
      (this._site && (this._site.orgName || this._site.organizationName)) || "";
    const name = (this._site && this._site.name) || "Your site";
    if (org) return { org, site: name };
    return splitSiteIdentity(name) || { org: "", site: name };
  }

  // Section 1: timestamp for the last submitted check, with issue count when
  // there are task cards for the site. Overall condition text is no longer used.
  _summaryBlock(last, issueCount = 0) {
    if (!last || !last.submittedAt) return "";
    const log = this._lastLog(last);
    const issues = issueCountLabel(issueCount);
    const label = [log.eyebrow, issues].filter(Boolean).join(" · ");
    return html`
      <div class="lastlog">
        ${label
          ? html`<p class="lastlog__eyebrow">${escapeHtml(label)}</p>`
          : ""}
      </div>
    `;
  }

  // The last submitted check as a one-line log:
  //   eyebrow  = "LAST LOG · <relative day> · <time>"
  _lastLog(last) {
    if (!last || !last.submittedAt) {
      return { eyebrow: "" };
    }
    const eyebrow = `LAST LOG · ${relativeDay(last.submittedAt)} · ${timeOf(
      last.submittedAt,
    )}`;
    return { eyebrow };
  }

  _sessionItems(session) {
    if (!session?.places || !Array.isArray(session.placeOrder)) return [];
    return session.placeOrder.flatMap(
      (placeId) => session.places[placeId]?.items || [],
    );
  }

  _homeTasks(tasks) {
    const now = new Date();
    return tasks.map((task) => ({
      task,
      createdAt: taskCreatedAt(task),
      homeStatus: homeTaskStatus(task, this._taskOverrides?.[task.taskId], now),
      isNew: isNewHomeTask(task, this._taskOverrides?.[task.taskId], now),
    }));
  }

  _statusCounts(entries) {
    return HOME_FILTERS.reduce((counts, filter) => {
      counts[filter.id] = entries.filter(
        (entry) => entry.homeStatus === filter.id,
      ).length;
      return counts;
    }, {});
  }

  _taskFilter(counts) {
    const label = activeHomeFilterLabel(this._homeFilter, counts);
    return html`
      <div class="task-filter">
        <button
          class="task-filter__button"
          id="task-filter-button"
          type="button"
          aria-expanded="${this._filterOpen ? "true" : "false"}"
        >
          ${escapeHtml(label)}
          <span
            class="task-filter__caret ${this._filterOpen
              ? "task-filter__caret--up"
              : ""}"
            aria-hidden="true"
          ></span>
        </button>
        ${this._filterOpen
          ? html`
              <div class="task-filter__menu" role="menu">
                ${HOME_FILTERS.map(
                  (filter) => html`
                    <button
                      class="task-filter__item ${filter.id === this._homeFilter
                        ? "task-filter__item--active"
                        : ""}"
                      type="button"
                      role="menuitem"
                      data-home-filter="${escapeAttr(filter.id)}"
                    >
                      ${escapeHtml(activeHomeFilterLabel(filter.id, counts))}
                    </button>
                  `,
                ).join("")}
              </div>
            `
          : ""}
      </div>
    `;
  }

  _toggleTaskFilter() {
    this._filterOpen = !this._filterOpen;
    this._focusAfterRender = this._filterOpen
      ? "task-filter-active-item"
      : "task-filter-button";
    if (this._homeModel) this._renderHome(this._homeModel);
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
    if (target === "task-filter-active-item")
      return ".task-filter__item--active";
    if (target === "task-filter-button") return "#task-filter-button";
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
    const title = task.label || task.category || "Finding";
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
    this.querySelectorAll("[data-task-id]").forEach((card) => {
      const taskId = card.getAttribute("data-task-id");
      const task = this._tasksById.get(taskId);
      if (!task) return;
      this._wireCardButtons(card, task);
    });
    this.querySelectorAll(".analysis-card").forEach((card) => {
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
    }
  }

  _problemFromCard(card, task = null) {
    return {
      placeId: card.getAttribute("data-place-id") || "",
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
    this._activeProblem = problem;
    this._setDialogError("analysis-delete-error", "");
    const title = this.querySelector("#analysis-delete-title");
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
    if (!problem) return;
    if (!problem.checkId || !problem.artifactId || !problem.conditionId) {
      this._setDialogError(
        "analysis-delete-error",
        "This result is missing its original evidence coordinates, so it cannot be deleted. Take a new photo and try again.",
      );
      return;
    }

    const button = this.querySelector("#analysis-delete-confirm");
    this._setBusy(button, true);
    this._setDialogError("analysis-delete-error", "");
    try {
      const result = await rejectAnalysisCondition(
        problem.checkId,
        problem.artifactId,
        problem.conditionId,
        {
          reason: { key: "not_a_problem" },
          caller: { request_id: this._requestId("delete", problem) },
        },
      );
      if (problem.placeId && problem.itemId) {
        await refreshEvidenceAnalysis(problem.placeId, problem.itemId, result, {
          rejectedConditionId: problem.conditionId,
        });
      }
      this._analysisDeleteDialog?.close();
      this._activeProblem = null;
      await this.connectedCallback();
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        this._deleteProblemLocally(problem);
        this._analysisDeleteDialog?.close();
        this._activeProblem = null;
        await this.connectedCallback();
        return;
      }
      console.error("delete analysis condition failed", err);
      this._setDialogError(
        "analysis-delete-error",
        "Could not delete this problem. Please try again.",
      );
    } finally {
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
      if (!problem.placeId || !problem.itemId) {
        this._setDialogError(
          "analysis-edit-error",
          "This result is missing its original evidence coordinates, so it cannot be edited. Take a new photo and try again.",
        );
        return;
      }
      const button = this.querySelector("#analysis-edit-save");
      this._setBusy(button, true);
      this._setDialogError("analysis-edit-error", "");
      try {
        await analyzeNoIssueDescriptionEdit(
          problem.placeId,
          problem.itemId,
          description,
        );
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

    const button = this.querySelector("#analysis-edit-save");
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
      if (problem.placeId && problem.itemId) {
        await refreshEvidenceAnalysis(problem.placeId, problem.itemId, result);
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
    if (!problem.placeId || !problem.itemId) return;
    const item = this._sessionItem(problem);
    updateItemAnalysis(problem.placeId, problem.itemId, {
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
        this._setInlineProblemError(
          problem,
          appActionFailureMessage(result?.task, {
            includeUnsubmitted311: true,
          }) || "Could not file the 311 ticket. Please try again.",
        );
        return;
      }
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
    if (
      !problem.placeId ||
      !problem.itemId ||
      !problem.conditionId ||
      !answerKey
    ) {
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
        problem.placeId,
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
    if (problem.placeId && problem.itemId) {
      const item = this._sessionItem(problem);
      updateItemAnalysis(problem.placeId, problem.itemId, {
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
    return getCurrentCheck()?.places?.[problem.placeId]?.items?.find(
      (item) => item.id === problem.itemId,
    );
  }

  _setInlineProblemError(problem, message) {
    const card = [...this.querySelectorAll(".analysis-card")].find(
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
    const error = this.querySelector(`#${id}`);
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
  // re-enable and show an inline, non-destructive error on the card. A 200 that
  // still carries a failed app action (task held open) surfaces its specific
  // reason instead of silently doing nothing.
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
        if (err) {
          err.hidden = false;
          err.textContent = failure;
        }
        return;
      }
      return true;
    } catch (e) {
      console.error("task action failed", e);
      buttons.forEach((b) => (b.disabled = false));
      if (err) {
        err.hidden = false;
        err.textContent = "Couldn’t save that — please try again.";
      }
      return false;
    }
  }

  // Backend unreachable on load. Online-only: surface it with a retry rather than
  // silently degrading (offline is post-MVP; no local read fallback).
  _renderError() {
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
