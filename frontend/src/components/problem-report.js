/*
  problem-report — a single-problem capture flow. Each captured photo analyzes
  immediately and renders through the same live result cards as perimeter check.
*/
import { getSite } from "../db.js";
import { navigate } from "../router.js";
import {
  analyzeEvidenceItem,
  analyzeNoIssueDescriptionEdit,
  refreshEvidenceAnalysis,
} from "../services/photo-analysis.js";
import {
  ApiError,
  completeTask,
  editAnalysisCondition,
  rejectAnalysisCondition,
} from "../services/api.js";
import {
  expectedArtifactCountForCheck,
  finalizeCaptureScorecardInBackground,
} from "../services/submit-check.js";
import {
  ensureProblemReport,
  startProblemReport,
  loadDraft,
  clearCheck,
  getCurrentCheck,
  getPlaceOrder,
  setActivePlaceIndex,
  addItem,
  removeItem,
  isPlaceCovered,
  getFlowType,
  isCurrentSession,
  updateItemAnalysis,
  markCaptureComplete,
  onCheckSessionChange,
  pauseCheck,
} from "../state/check-session.js";
import { shell, analysisSection } from "./problem-report.templates.js";
import { shotTile, addTile } from "./perimeter-check.templates.js";

/**
 * @typedef {{ siteId?: string, providerSiteId?: string, id?: string, name?: string }} SiteRecord
 * @typedef {{ kind: "photo", dataUrl: string }} PhotoItemInput
 * @typedef {{ items: Array<{ id: string, dataUrl: string, placeId?: string, placeName?: string, analysis?: { status?: string } }> }} PlaceState
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
    /** @type {string} */
    this._placeId = "";
    /** @type {HTMLInputElement | null} */
    this._fileInput = null;
    /** @type {FileReader | null} */
    this._fileReader = null;
    this._finishing = false;
    this._unsubscribe = null;
    this._activeProblem = null;
    this._analysisDeleteDialog = null;
    this._analysisSuccessDialog = null;
    this._analysisEditDialog = null;
    this._analysisEditDescription = null;
  }

  /** @returns {Promise<void>} */
  async connectedCallback() {
    this._embedded = this.hasAttribute("embedded");
    /** @type {SiteRecord | null} */
    this._site = await getSite();
    this._siteId =
      this._site?.siteId || this._site?.providerSiteId || this._site?.id || "";

    const check =
      getCurrentCheck() || (await loadDraft("single-problem")) || null;
    if (!check) {
      ensureProblemReport(this._siteId);
    } else if (getFlowType() !== "single-problem") {
      startProblemReport(this._siteId);
    }
    this._checkId = getCurrentCheck()?.id || "";

    this._placeId = getPlaceOrder()[0];
    setActivePlaceIndex(0);

    this._unsubscribe = onCheckSessionChange(() => {
      if (this.isConnected && !this._finishing) this._render();
    });

    this.innerHTML = shell({
      embedded: this._embedded,
      title: this._titleText(),
    });
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
        this._cancelDialog?.close();
        await pauseCheck();
        this._exitCapture();
      },
    );
    this.querySelector("#cancel-report-discard")?.addEventListener(
      "click",
      () => {
        this._cancelDialog?.close();
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
  }

  /** @returns {PlaceState} */
  _placeState() {
    const check = getCurrentCheck();
    return /** @type {PlaceState} */ (
      check?.places?.[this._placeId] || { items: [] }
    );
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
      this._placeId,
      /** @type {PhotoItemInput} */ ({ kind: "photo", dataUrl }),
    );
    if (record) analyzeEvidenceItem(record.placeId, record.id);
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
      removeItem(this._placeId, del.getAttribute("data-del"));
      this._render();
    }
  }

  /** @returns {void} */
  _cancel() {
    if (!isPlaceCovered(this._placeId)) {
      this._exitCapture();
      window.setTimeout(() => clearCheck(), 0);
      return;
    }
    this._cancelDialog?.showModal();
  }

  /** @returns {void} */
  _describeInstead() {
    navigate("/problem/describe");
  }

  /** @returns {void} */
  _renderShots() {
    const items = this._placeState().items;
    const grid = this.querySelector("#shotgrid");
    if (!grid) return;
    grid.classList.toggle("shotgrid--empty", items.length === 0);
    const tile = addTile(items.length === 0);
    grid.innerHTML =
      items.map((item, index) => shotTile(item, index)).join("") + tile;
  }

  /** @returns {void} */
  _renderAnalysis() {
    const container = this.querySelector("#single-issue-analysis");
    if (!container) return;
    const items = this._placeState().items;
    container.innerHTML = items.length
      ? analysisSection(items, this._checkId)
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
    this._renderTitle();
    this._renderShots();
    this._renderAnalysis();
    this._syncControls();
  }

  /** @returns {string} */
  _titleText() {
    return this._placeState().items.length
      ? "Flag another issue"
      : "Flag a single issue";
  }

  /** @returns {void} */
  _syncControls() {
    const submit = this.querySelector("#submit-report");
    if (!(submit instanceof HTMLButtonElement)) return;
    submit.disabled = false;
  }

  /** @returns {Promise<void>} */
  async _done() {
    const check = getCurrentCheck();
    if (!isPlaceCovered(this._placeId)) {
      clearCheck();
      this._exitCapture();
      return;
    }
    const expectedArtifacts = expectedArtifactCountForCheck(check);
    this._finishing = true;
    this._unsubscribe?.();
    this._unsubscribe = null;
    if (this._embedded) {
      this.dispatchEvent(
        new CustomEvent("capturefinished", {
          bubbles: true,
          composed: true,
          detail: { flowType: "single-problem" },
        }),
      );
      window.setTimeout(() => {
        markCaptureComplete({
          checkId: check?.id,
          submissionKind: "problem_report",
          expectedArtifacts,
        });
        finalizeCaptureScorecardInBackground(check?.id, { expectedArtifacts });
      }, 0);
      return;
    }
    markCaptureComplete({
      checkId: check?.id,
      submissionKind: "problem_report",
      expectedArtifacts,
    });
    finalizeCaptureScorecardInBackground(check?.id, { expectedArtifacts });
    navigate("/today");
  }

  _exitCapture() {
    this._finishing = true;
    this._unsubscribe?.();
    this._unsubscribe = null;
    if (this._embedded) {
      this.dispatchEvent(
        new CustomEvent("capturefinished", {
          bubbles: true,
          composed: true,
          detail: { flowType: "single-problem" },
        }),
      );
      return;
    }
    navigate("/today");
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
        }
      });
    });
  }

  _problemFromCard(card) {
    return {
      placeId: card.getAttribute("data-place-id") || "",
      itemId: card.getAttribute("data-item-id") || "",
      checkId: card.getAttribute("data-check-id") || "",
      artifactId: card.getAttribute("data-artifact-id") || "",
      taskId: card.getAttribute("data-task-id") || "",
      conditionId: card.getAttribute("data-condition-id") || "",
      actionKind: card.getAttribute("data-action-kind") || "",
      title: card.getAttribute("data-card-title") || "problem",
      description: card.getAttribute("data-card-description") || "",
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
        this._missingConditionMessage(problem, "deleted"),
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
      await refreshEvidenceAnalysis(problem.placeId, problem.itemId, result, {
        rejectedConditionId: problem.conditionId,
      });
      this._analysisDeleteDialog?.close();
      this._activeProblem = null;
      this._render();
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        this._deleteProblemLocally(problem);
        this._analysisDeleteDialog?.close();
        this._activeProblem = null;
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

  _deleteProblemLocally(problem) {
    const check = getCurrentCheck();
    const item = check?.places?.[problem.placeId]?.items?.find(
      (candidate) => candidate.id === problem.itemId,
    );
    if (!item) return;
    updateItemAnalysis(problem.placeId, problem.itemId, {
      tasks: (item.analysis?.tasks || []).filter(
        (task) => task.taskId !== problem.taskId,
      ),
      rejectedConditionIds: [
        ...(item.analysis?.rejectedConditionIds || []),
        problem.conditionId,
      ].filter(Boolean),
    });
    this._render();
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
    this._setBusy(button, true);
    this._setDialogError("analysis-edit-error", "");
    try {
      if (!problem.conditionId) {
        await analyzeNoIssueDescriptionEdit(
          problem.placeId,
          problem.itemId,
          description,
        );
      } else {
        if (!problem.checkId || !problem.artifactId) {
          this._setDialogError(
            "analysis-edit-error",
            this._missingConditionMessage(problem, "edited"),
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
        await refreshEvidenceAnalysis(problem.placeId, problem.itemId, result);
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
      this._setBusy(button, false);
    }
  }

  async _resolveProblem(problem) {
    if (problem.taskId) {
      try {
        await completeTask(problem.taskId, {
          completionMethod:
            problem.actionKind === "escalation" ? "311_filed" : "manual",
        });
      } catch (err) {
        console.error("resolve task failed", err);
      }
    }
    this._markProblemResolved(problem);
    this._analysisSuccessDialog?.showModal();
  }

  _markProblemResolved(problem) {
    const check = getCurrentCheck();
    const item = check?.places?.[problem.placeId]?.items?.find(
      (candidate) => candidate.id === problem.itemId,
    );
    if (!item) return;
    updateItemAnalysis(problem.placeId, problem.itemId, {
      tasks: (item.analysis?.tasks || []).filter(
        (task) => task.taskId !== problem.taskId,
      ),
      resolvedConditionIds: [
        ...(item.analysis?.resolvedConditionIds || []),
        problem.conditionId,
      ].filter(Boolean),
    });
    this._render();
  }

  _setDialogError(id, message) {
    const error = /** @type {HTMLElement | null} */ (
      this.querySelector(`#${id}`)
    );
    if (!error) return;
    error.textContent = message;
    error.hidden = !message;
  }

  _setBusy(button, busy) {
    if (!(button instanceof HTMLButtonElement)) return;
    button.disabled = busy;
    button.setAttribute("aria-busy", busy ? "true" : "false");
  }

  _missingConditionMessage(problem, action) {
    if (!problem.conditionId) {
      return `This card does not have a problem condition that can be ${action}.`;
    }
    return `This result is missing its original evidence coordinates, so it cannot be ${action}. Take a new photo and try again.`;
  }

  _requestId(action, problem) {
    const suffix =
      globalThis.crypto?.randomUUID?.() ||
      `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return `${this._checkId}:${problem.itemId}:${problem.conditionId}:${action}:${suffix}`;
  }

  /** @returns {void} */
  disconnectedCallback() {
    if (this._fileReader?.readyState === FileReader.LOADING) {
      this._fileReader.abort();
    }
    this._unsubscribe?.();
  }
}

customElements.define("problem-report", ProblemReport);
