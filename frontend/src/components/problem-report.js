/*
  problem-report — a single-problem capture flow. Each captured photo analyzes
  immediately and renders through the same live result cards as perimeter check.
*/
import "./problem-report.css";
import { show311SuccessToast, show311ErrorToast } from "../state/toasts.js";
import { requestId, setBusy, setDialogError } from "../lib/dialog-controls.js";
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
import { isFiled311Completion } from "../domain/task-actions.js";
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
  isCurrentSession,
  rejectConditionLocally,
  resolveConditionLocally,
  markCaptureComplete,
  onCheckSessionChange,
  pauseCheck,
} from "../state/check-session.js";
import { shell, analysisSection } from "./problem-report.templates.js";
import { shotTile, addTile } from "./perimeter-check.templates.js";
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
    this._toastTimer = 0;
    this._initGeneration = 0;
    this._answeringConditionIds = new Set();
  }

  /** @returns {Promise<void>} */
  async connectedCallback() {
    const initGeneration = ++this._initGeneration;
    this._cleanupSubscription();
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
    this.querySelector("#submit-report").addEventListener("click", () =>
      this._done(),
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
    this._fileInput.value = "";
    this._fileInput.click();
  }

  /** @returns {void} */
  _onFilePicked() {
    if (!this._fileInput) return;
    const file = this._fileInput.files && this._fileInput.files[0];
    if (!file) return;
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
    if (record) analyzeEvidenceItem(record.id);
    this._render();
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
    container.innerHTML = items.length
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
    if (isDeletingAnalysisCard(this)) return;
    this._renderTitle();
    this._renderShots();
    this._renderAnalysis();
    this._syncControls();
  }

  /** @returns {string} */
  _titleText() {
    return getItems().length ? "Flag another issue" : "Flag a single issue";
  }

  /** @returns {void} */
  _syncControls() {
    const submit = this.querySelector("#submit-report");
    if (!(submit instanceof HTMLButtonElement)) return;
    submit.disabled = !hasLiveEvidence(getCurrentCheck());
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
          this._resolveProblem(problem);
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
              this._showToast(
                "Deletion saved. Could not refresh the cards; please reload.",
              );
            },
          }),
        () => this._render(),
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
        "Description must be at least 5 characters.",
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
        await analyzeNoIssueDescriptionEdit(problem.itemId, description);
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
            caller: { request_id: this._requestId("edit", problem) },
          },
        );
        try {
          await refreshEvidenceAnalysis(problem.itemId, result);
        } catch (error) {
          console.error("refresh after saved edit failed", error);
          this._setDialogError(
            "analysis-edit-error",
            "Edit saved. Could not refresh the cards; please reload.",
          );
          return;
        }
      }
      this._analysisEditDialog?.close();
      this._activeProblem = null;
      this._render();
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
        show311SuccessToast();
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
      this._showToast("Could not save that action. Please try again.");
    }
  }

  async _answerProblemQuestion(problem, button) {
    if (!(button instanceof HTMLButtonElement)) return;
    const answerKey = button.getAttribute("data-answer-key") || "";
    const answerValue = button.getAttribute("data-answer-value") === "true";
    if (!problem.itemId || !problem.conditionId || !answerKey) {
      this._showToast("Could not save that answer. Please try again.");
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
      this._showToast("Could not save that answer. Please try again.");
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

  _showToast(message) {
    let toast = this.querySelector(".check-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.className = "check-toast";
      toast.setAttribute("role", "status");
      this.appendChild(toast);
    }
    toast.innerHTML = `<wa-icon name="circle-check" aria-hidden="true"></wa-icon><span></span>`;
    toast.querySelector("span").textContent = message;
    window.clearTimeout(this._toastTimer);
    this._toastTimer = window.setTimeout(() => toast.remove(), 3500);
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
    this._initGeneration += 1;
    if (this._fileReader?.readyState === FileReader.LOADING) {
      this._fileReader.abort();
    }
    this._cleanupSubscription();
  }
}

customElements.define("problem-report", ProblemReport);
