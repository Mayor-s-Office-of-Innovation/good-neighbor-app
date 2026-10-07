import {
  toggleCardCompletion,
  isCompletingAnalysisCard,
} from "./analysis-card-completion.js";
/*
  problem-report — a single-problem capture flow. Each captured photo analyzes
  immediately and renders through the same live result cards as perimeter check.
*/
import "./problem-report.css";
import {
  show311SuccessToast,
  show311ErrorToast,
  showActionSaveErrorToast,
  showAnswerSaveErrorToast,
  showDeletionRefreshToast,
  showDeleteErrorToast,
  showEditErrorToast,
  showEditRefreshErrorToast,
  showEditSavedToast,
  showReanalysisErrorToast,
} from "../state/toasts.js";
import { requestId, setBusy, setDialogError } from "../lib/dialog-controls.js";
import { getLocale, t } from "../i18n/i18n.js";
import {
  missingConditionMessage,
  problemFromCard,
  rejectProblemCondition,
} from "./analysis-problem-actions.js";
import { onDeletionsChange } from "../state/pending-deletions.js";
import {
  deleteAnalysisCard,
  isDeletingAnalysisCard,
} from "./analysis-card-deletion.js";
import { getSite } from "../db.js";
import { navigate, replaceRoute } from "../router.js";
import { markCameraOpen, clearCameraOpen } from "../state/capture-resume.js";
import { trackEvent } from "../services/analytics.js";
import { openOverlayDialog, awaitOverlayUnwind } from "../dialog-history.js";
import { announceScreenHeading } from "../screen-focus.js";
import {
  answerAnalysisQuestion,
  analyzeEvidenceItem,
  analyzeNoIssueDescriptionEdit,
  refreshEvidenceAnalysis,
  retryEvidenceItem,
} from "../services/photo-analysis.js";
import { completeTask, editAnalysisCondition } from "../services/api.js";
import {
  expectedArtifactCountForCheck,
  finalizeCaptureScorecardInBackground,
} from "../services/submit-check.js";
import {
  isFiled311Completion,
  submitted311ServiceRequestNumber,
} from "../domain/task-actions.js";
import { hasEvidence, hasLiveEvidence } from "../domain/check-completion.js";
import {
  ensureProblemReport,
  startProblemReport,
  loadDraft,
  clearCheck,
  getCurrentCheck,
  getItems,
  findItem,
  addItem,
  removeItem,
  getFlowType,
  getAnalyzingOpen,
  isCurrentSession,
  rejectConditionLocally,
  resolveConditionLocally,
  markCaptureComplete,
  onCheckSessionChange,
  pauseCheck,
  setAnalyzingOpen,
} from "../state/check-session.js";
import { shell, analysisSection } from "./problem-report.templates.js";
import { shotTile, addTile, footer } from "./perimeter-check.templates.js";
import { setQuestionAnswerBusy } from "./analysis-answer-controls.js";

/**
 * @typedef {{ siteId?: string, providerSiteId?: string, id?: string, name?: string, address?: string }} SiteRecord
 * @typedef {{ kind: "photo", dataUrl: string }} PhotoItemInput
 * @typedef {{ kind?: "photo" | "text", id: string, dataUrl?: string, text?: string, analysis?: { status?: string } }} EvidenceItem
 */

class ProblemReport extends HTMLElement {
  constructor() {
    super();
    /** @type {SiteRecord | null} */
    this._site = null;
    /** @type {string} */
    this._siteId = "";
    /** @type {string} */
    this._checkId = "";
    /** @type {HTMLInputElement | null} */
    this._fileInput = null;
    /** @type {FileReader | null} */
    this._fileReader = null;
    this._finishing = false;
    this._unsubscribe = null;
    this._activeProblem = null;
    this._analysisDeleteDialog = null;
    this._analysisSuccessDialog = null;
    this._analysisProgressDialog = null;
    this._analysisEditDialog = null;
    this._analysisEditDescription = null;
    this._initGeneration = 0;
    this._answeringConditionIds = new Set();
  }

  /** @returns {Promise<void>} */
  async connectedCallback() {
    const initGeneration = ++this._initGeneration;
    this._cleanupSubscription();
    // A boot that lands here directly has no interrupted hand-off to resume.
    clearCameraOpen();
    /** @type {SiteRecord | null} */
    this._site = await getSite();
    if (!this._isCurrentInit(initGeneration)) return;
    this._siteId =
      this._site?.siteId || this._site?.providerSiteId || this._site?.id || "";

    let check = getCurrentCheck();
    if (!check) {
      check = (await loadDraft("single-problem")) || null;
      if (!this._isCurrentInit(initGeneration)) return;
    }
    if (!check) {
      ensureProblemReport(this._siteId);
    } else if (getFlowType() !== "single-problem") {
      startProblemReport(this._siteId);
    }
    this._checkId = getCurrentCheck()?.id || "";

    const unsubscribe = onCheckSessionChange(() => {
      if (this.isConnected && !this._finishing) this._render();
    });
    if (!this._isCurrentInit(initGeneration)) {
      unsubscribe();
      return;
    }
    this._cleanupSubscription();
    this._unsubscribe = unsubscribe;
    this._deletionUnsub = onDeletionsChange(() => {
      if (this.isConnected && !this._finishing) this._render();
    });

    this.innerHTML = shell({ title: this._titleText() });
    this._fileInput = /** @type {HTMLInputElement | null} */ (
      this.querySelector("#file-input")
    );
    if (!this._fileInput) return;

    this.querySelector("#cancel")?.addEventListener("click", () =>
      this._cancel(),
    );
    this.querySelector("#describe-instead").addEventListener("click", () =>
      this._describeInstead(),
    );
    this._cancelDialog = /** @type {HTMLDialogElement | null} */ (
      this.querySelector("#cancel-report-dialog")
    );
    this.querySelector("#cancel-report-save")?.addEventListener(
      "click",
      async () => {
        // Close → await the history unwind → then replace the entry (see
        // perimeter-check's cancel handlers for the race this avoids).
        await awaitOverlayUnwind("cancel-confirm");
        await pauseCheck();
        this._exitCapture();
      },
    );
    this.querySelector("#cancel-report-discard")?.addEventListener(
      "click",
      async () => {
        await awaitOverlayUnwind("cancel-confirm");
        this._exitCapture();
        window.setTimeout(() => clearCheck(), 0);
      },
    );
    this._cancelDialog?.addEventListener("click", (e) => {
      if (e.target === this._cancelDialog) this._cancelDialog.close();
    });
    this.querySelector("#problem-footer").addEventListener("click", (event) =>
      this._onFooterClick(event),
    );
    this._analysisDeleteDialog = /** @type {HTMLDialogElement | null} */ (
      this.querySelector("#analysis-delete-dialog")
    );
    this._analysisSuccessDialog = /** @type {HTMLDialogElement | null} */ (
      this.querySelector("#analysis-success-dialog")
    );
    this._analysisProgressDialog = /** @type {HTMLDialogElement | null} */ (
      this.querySelector("#analysis-progress-dialog")
    );
    this._analysisEditDialog = /** @type {HTMLDialogElement | null} */ (
      this.querySelector("#analysis-edit-dialog")
    );
    this._analysisEditDescription = /** @type {HTMLTextAreaElement | null} */ (
      this.querySelector("#analysis-edit-description")
    );
    this.querySelector("#analysis-delete-confirm")?.addEventListener(
      "click",
      () => this._confirmDeleteProblem(),
    );
    this.querySelector("#analysis-edit-save")?.addEventListener("click", () =>
      this._saveProblemEdit(),
    );
    this.querySelector("#analysis-progress-cancel")?.addEventListener(
      "click",
      () => this._analysisProgressDialog?.close(),
    );
    this.querySelectorAll(".analysis-dialog").forEach((dialog) => {
      dialog.addEventListener("click", (e) => {
        if (e.target === dialog) {
          /** @type {HTMLDialogElement} */ (dialog).close();
        }
      });
    });
    this.querySelector("#shotgrid").addEventListener("click", (e) =>
      this._onGridClick(e),
    );
    this._fileInput.addEventListener("change", () => this._onFilePicked());

    this._render();
    // Async-init announcement: the heading may not exist at route-mount time.
    announceScreenHeading(this, ".single-issue__title");
  }

  _isCurrentInit(initGeneration) {
    return this.isConnected && initGeneration === this._initGeneration;
  }

  _cleanupSubscription() {
    this._deletionUnsub?.();
    this._deletionUnsub = null;
    this._unsubscribe?.();
    this._unsubscribe = null;
  }

  /** @returns {void} */
  _openCamera() {
    if (!this._fileInput) return;
    // Survives a process kill while the camera is up: app-root reads it at
    // boot and re-enters /problem instead of home (state/capture-resume.js).
    markCameraOpen("/problem");
    void trackEvent("camera_opened", { flow: "single-problem" });
    this._fileInput.value = "";
    this._fileInput.click();
  }

  /** @returns {void} */
  _onFilePicked() {
    clearCameraOpen();
    if (!this._fileInput) return;
    const file = this._fileInput.files && this._fileInput.files[0];
    if (!file) return;
    void trackEvent("photo_picked", {
      flow: "single-problem",
      photo_bytes: file.size,
      photo_type: file.type,
    });
    if (this._fileReader?.readyState === FileReader.LOADING) {
      this._fileReader.abort();
    }
    const originCheckId = this._checkId;
    const reader = new FileReader();
    this._fileReader = reader;
    reader.onload = () => {
      if (
        !this.isConnected ||
        !isCurrentSession(originCheckId, "single-problem")
      ) {
        this._fileReader = null;
        return;
      }
      this._fileReader = null;
      if (typeof reader.result === "string") {
        this._addPhoto(reader.result);
      }
    };
    reader.onerror = () => {
      this._fileReader = null;
    };
    reader.onabort = () => {
      this._fileReader = null;
    };
    reader.readAsDataURL(file);
  }

  /** @param {string} dataUrl */
  _addPhoto(dataUrl) {
    const record = addItem(
      /** @type {PhotoItemInput} */ ({ kind: "photo", dataUrl }),
    );
    if (record) {
      setAnalyzingOpen(true);
      analyzeEvidenceItem(record.id);
    }
    this._render();
  }

  /** @param {Event} event */
  _onFooterClick(event) {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest("#submit-report")) {
      this._done();
      return;
    }
    const toggle = target.closest("#toggle-analyzing");
    if (toggle) {
      setAnalyzingOpen(!getAnalyzingOpen());
      const replacement = this.querySelector("#toggle-analyzing");
      if (replacement instanceof HTMLElement) {
        replacement.focus({ preventScroll: true });
      }
    }
  }

  /** @param {Event} e */
  _onGridClick(e) {
    const target = e.target;
    if (!(target instanceof Element)) return;
    if (target.closest("#add-photo")) {
      this._openCamera();
      return;
    }
    const del = target.closest("[data-del]");
    if (del) {
      removeItem(del.getAttribute("data-del"));
      this._render();
    }
  }

  /** @returns {void} */
  _cancel() {
    if (!hasEvidence(getCurrentCheck())) {
      this._exitCapture();
      window.setTimeout(() => clearCheck(), 0);
      return;
    }
    openOverlayDialog(
      /** @type {HTMLDialogElement} */ (this._cancelDialog),
      "cancel-confirm",
    );
  }

  /** @returns {void} */
  _describeInstead() {
    navigate("/problem/describe");
  }

  /** @returns {void} */
  _renderShots() {
    // The shot grid is photo-only: typed descriptions are items too, but they
    // render as analysis cards below (shotTile assumes item.dataUrl is an img src).
    const items = this._photoItems();
    const grid = this.querySelector("#shotgrid");
    if (!grid) return;
    grid.classList.toggle("shotgrid--empty", items.length === 0);
    const tile = addTile(items.length === 0);
    grid.innerHTML =
      items.map((item, index) => shotTile(item, index)).join("") + tile;
  }

  /** @returns {EvidenceItem[]} */
  _photoItems() {
    return getItems().filter((item) => item.kind !== "text");
  }

  /** @returns {void} */
  _renderAnalysis() {
    const container = this.querySelector("#single-issue-analysis");
    if (!container) return;
    const items = getItems();
    container.innerHTML =
      getAnalyzingOpen() && items.length
        ? analysisSection(
            items,
            this._checkId,
            this._site?.name || "",
            this._site?.address || "",
          )
        : "";
    this._wireAnalysisCards();
  }

  /** @returns {void} */
  _renderTitle() {
    const title = this.querySelector(".single-issue__title");
    if (title) title.textContent = this._titleText();
  }

  /** @returns {void} */
  _render() {
    if (isDeletingAnalysisCard(this) || isCompletingAnalysisCard(this)) return;
    this._renderTitle();
    this._renderShots();
    this._renderAnalysis();
    this._syncControls();
  }

  /** @returns {string} */
  _titleText() {
    return getItems().length
      ? t("problem.title.another")
      : t("problem.title.single");
  }

  /** @returns {void} */
  _syncControls() {
    const container = this.querySelector("#problem-footer");
    if (!container) return;
    const items = getItems();
    container.innerHTML = footer({
      items,
      analyzingOpen: getAnalyzingOpen(),
      complete: hasLiveEvidence(getCurrentCheck()),
      doneId: "submit-report",
      doneLabel: t("common.done"),
    });
  }

  /** @returns {Promise<void>} */
  async _done() {
    const check = getCurrentCheck();
    if (!hasLiveEvidence(check)) {
      this._syncControls();
      return;
    }
    const expectedArtifacts = expectedArtifactCountForCheck(check);
    this._finishing = true;
    this._cleanupSubscription();
    markCaptureComplete({
      checkId: check?.id,
      submissionKind: "problem_report",
      expectedArtifacts,
    });
    finalizeCaptureScorecardInBackground(check?.id, { expectedArtifacts });
    // Replace-at-completion: back can never revisit the finished flow.
    replaceRoute("/today");
  }

  _exitCapture() {
    this._finishing = true;
    this._cleanupSubscription();
    replaceRoute("/today");
  }

  _wireAnalysisCards() {
    this.querySelectorAll("[data-analysis-action]").forEach((button) => {
      button.addEventListener("click", (e) => {
        const target = e.currentTarget;
        if (!(target instanceof Element)) return;
        const card = target.closest(".analysis-card");
        if (!card) return;
        const action = target.getAttribute("data-analysis-action");
        const problem = this._problemFromCard(card);
        if (action === "delete") {
          this._openDeleteProblem(problem);
        } else if (action === "edit") {
          this._openEditProblem(problem);
        } else if (action === "resolve") {
          if (target.getAttribute("role") === "checkbox") {
            toggleCardCompletion(this, card, target, {
              onSaved: () => this._markProblemResolved(problem),
              render: () => this._render(),
            });
          } else this._resolveProblem(problem);
        } else if (action === "answer") {
          this._answerProblemQuestion(problem, target);
        } else if (action === "retry") {
          if (problem.itemId) retryEvidenceItem(problem.itemId);
        } else if (action === "remove-item") {
          const item = findItem(problem.itemId);
          if (item && item.upload?.status !== "uploaded")
            removeItem(problem.itemId);
        }
      });
    });
  }

  _problemFromCard(card) {
    return problemFromCard(card);
  }

  _openDeleteProblem(problem) {
    if (this._deletingProblem) return;
    this._activeProblem = problem;
    this._setDialogError("analysis-delete-error", "");
    const title = this.querySelector("#analysis-delete-title");
    if (title)
      title.textContent = t("analysis.deleteDialog.titleFor", {
        title: problem.title,
      });
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
    const button = this.querySelector("#analysis-delete-confirm");
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
              showDeletionRefreshToast();
            },
          }),
        () => this._render(),
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

  _deleteProblemLocally(problem) {
    if (rejectConditionLocally(problem) && this.isConnected) this._render();
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

    const button = this.querySelector("#analysis-edit-save");
    setBusy(button, true);
    this._setDialogError("analysis-edit-error", "");
    try {
      if (!problem.conditionId) {
        try {
          await analyzeNoIssueDescriptionEdit(problem.itemId, description);
        } catch (error) {
          console.error("text-only no-issue reanalysis failed", error);
          showReanalysisErrorToast();
          return;
        }
      } else {
        if (!problem.checkId || !problem.artifactId) {
          this._setDialogError(
            "analysis-edit-error",
            missingConditionMessage(problem, "edited"),
          );
          return;
        }
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
        try {
          await refreshEvidenceAnalysis(problem.itemId, result);
        } catch (error) {
          console.error("refresh after saved edit failed", error);
          this._analysisEditDialog?.close();
          this._activeProblem = null;
          showEditRefreshErrorToast();
          return;
        }
      }
      this._analysisEditDialog?.close();
      this._activeProblem = null;
      this._render();
      showEditSavedToast();
    } catch (err) {
      console.error("edit analysis condition failed", err);
      showEditErrorToast();
    } finally {
      setBusy(button, false);
    }
  }

  async _resolveProblem(problem) {
    if (!problem.taskId) {
      this._markProblemResolved(problem);
      openOverlayDialog(
        /** @type {HTMLDialogElement} */ (this._analysisSuccessDialog),
        "analysis-success",
      );
      return;
    }

    if (problem.actionKind === "escalation") {
      openOverlayDialog(
        /** @type {HTMLDialogElement} */ (this._analysisProgressDialog),
        "analysis-progress",
      );
      try {
        const result = await completeTask(problem.taskId, {
          completionMethod: "311_filed",
        });
        this._analysisProgressDialog?.close();
        if (!isFiled311Completion(result?.task)) {
          show311ErrorToast();
          return;
        }
        this._markProblemResolved(problem);
        show311SuccessToast(submitted311ServiceRequestNumber(result.task));
      } catch (err) {
        console.error("escalation failed", err);
        this._analysisProgressDialog?.close();
        show311ErrorToast();
      }
      return;
    }

    try {
      await completeTask(problem.taskId, { completionMethod: "manual" });
      this._markProblemResolved(problem);
      openOverlayDialog(
        /** @type {HTMLDialogElement} */ (this._analysisSuccessDialog),
        "analysis-success",
      );
    } catch (err) {
      console.error("resolve task failed", err);
      showActionSaveErrorToast();
    }
  }

  async _answerProblemQuestion(problem, button) {
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
    try {
      await answerAnalysisQuestion(
        problem.itemId,
        problem.conditionId,
        answerKey,
        answerValue,
      );
      this._render();
    } catch (err) {
      console.error("answer condition failed", err);
      showAnswerSaveErrorToast();
    } finally {
      this._answeringConditionIds.delete(problem.conditionId);
      setQuestionAnswerBusy(this, problem.conditionId, false);
    }
  }

  _markProblemResolved(problem) {
    if (resolveConditionLocally(problem)) this._render();
  }

  _setDialogError(id, message) {
    setDialogError(this, `#${id}`, message);
  }

  _requestId(action, problem) {
    return requestId(
      this._checkId,
      problem.itemId,
      problem.conditionId,
      action,
    );
  }

  /** @returns {void} */
  disconnectedCallback() {
    // Only an abnormal document death leaves the marker behind.
    clearCameraOpen();
    this._initGeneration += 1;
    if (this._fileReader?.readyState === FileReader.LOADING) {
      this._fileReader.abort();
    }
    this._cleanupSubscription();
  }
}

customElements.define("problem-report", ProblemReport);
