// @ts-nocheck -- lenient migration baseline (checkJs).
/*
  perimeter-check — flat photo roll capture flow (docs/plan-remove-places.md).

  One grid of photos for the whole perimeter plus an optional single text
  description as the alternative to photos. Each photo or description is
  analyzed independently as soon as it is captured; Finish unlocks once the
  completion rule in domain/check-completion.js is met (five photos, or one
  description). Captures land under the session's one synthetic place so the
  per-item pipeline and result cards keep keying on placeId + itemId.
*/
import { show311SuccessToast, show311ErrorToast } from "../state/toasts.js";
import { onDeletionsChange } from "../state/pending-deletions.js";
import {
  deleteAnalysisCard,
  isDeletingAnalysisCard,
} from "./analysis-card-deletion.js";
import { getSite } from "../db.js";
import { navigate } from "../router.js";
import { mark } from "../services/instrument.js";
import {
  answerAnalysisQuestion,
  analyzeNoIssueDescriptionEdit,
  analyzeEvidenceItem,
  retryEvidenceItem,
  refreshEvidenceAnalysis,
  removeEvidenceItem,
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
import { isFiled311Completion } from "../domain/task-actions.js";
import {
  completionStatus,
  hasEvidence,
  isPerimeterCheckComplete,
  photoItems,
  textItems,
} from "../domain/check-completion.js";
import {
  ensureCheck,
  startCheck,
  loadDraft,
  clearCheck,
  getCapturePlaceId,
  getItems,
  getCurrentCheck,
  getFlowType,
  addItem,
  removeItem,
  isCurrentSession,
  getAnalyzingOpen,
  setAnalyzingOpen,
  updateItemAnalysis,
  markCaptureComplete,
  onCheckSessionChange,
  pauseCheck,
} from "../state/check-session.js";
import {
  shell,
  progressLine,
  descriptionCard,
  photoGrid,
  footer,
  analyzingSection,
} from "./perimeter-check.templates.js";
import { setQuestionAnswerBusy } from "./analysis-answer-controls.js";

class PerimeterCheck extends HTMLElement {
  constructor() {
    super();
    this._answeringConditionIds = new Set();
  }

  async connectedCallback() {
    this._finishing = false;
    this._embedded = this.hasAttribute("embedded");
    this._site = await getSite();
    this._siteId =
      this._site.siteId || this._site.providerSiteId || this._site.id;
    const currentCheck = getCurrentCheck();
    const check =
      currentCheck?.status === "in-progress"
        ? currentCheck
        : (await loadDraft("perimeter")) || null;
    if (!check) {
      ensureCheck(this._siteId, this._site.name);
    } else if (getFlowType() !== "perimeter") {
      startCheck(this._siteId, this._site.name);
    }

    this._checkId = getCurrentCheck()?.id || "";
    this._deletionUnsub?.();
    this._deletionUnsub = onDeletionsChange(() => {
      if (this.isConnected && !this._finishing) this._render();
    });
    this._unsubscribe = onCheckSessionChange(() => {
      if (this.isConnected && !this._finishing) this._render();
    });
    this.innerHTML = shell({ embedded: this._embedded });
    this._fileInput = this.querySelector("#file-input");
    this._cancelDialog = this.querySelector("#cancel-check-dialog");
    this._analysisDeleteDialog = this.querySelector("#analysis-delete-dialog");
    this._analysisSuccessDialog = this.querySelector(
      "#analysis-success-dialog",
    );
    this._analysisProgressDialog = this.querySelector(
      "#analysis-progress-dialog",
    );
    this._analysisEditDialog = this.querySelector("#analysis-edit-dialog");
    this._analysisEditDescription = this.querySelector(
      "#analysis-edit-description",
    );

    this.querySelector("#cancel")?.addEventListener("click", () =>
      this._cancel(),
    );
    this.querySelector("#cancel-check-save")?.addEventListener(
      "click",
      async () => {
        this._cancelDialog?.close();
        await pauseCheck();
        this._exitCapture();
      },
    );
    this.querySelector("#cancel-check-discard")?.addEventListener(
      "click",
      () => {
        this._cancelDialog?.close();
        this._exitCapture({ discarded: true });
        window.setTimeout(() => clearCheck(), 0);
      },
    );
    this._cancelDialog?.addEventListener("click", (e) => {
      if (e.target === this._cancelDialog) this._cancelDialog.close();
    });

    this.querySelector("#shotgrid").addEventListener("click", (e) =>
      this._onGridClick(e),
    );
    this.querySelector("#check-description").addEventListener("click", (e) =>
      this._onDescriptionClick(e),
    );
    this.querySelector("#describe-instead").addEventListener("click", () =>
      this._describeInstead(),
    );
    this.querySelector("#check-footer").addEventListener("click", (e) =>
      this._onFooterClick(e),
    );
    this.addEventListener("click", (e) => this._onAnalysisClick(e));
    this._fileInput.addEventListener("change", () => this._onFilePicked());
    [
      this._analysisDeleteDialog,
      this._analysisSuccessDialog,
      this._analysisEditDialog,
    ].forEach((dialog) => {
      dialog?.addEventListener("click", (e) => {
        if (e.target === dialog) dialog.close();
      });
    });
    this.querySelector("#analysis-delete-confirm")?.addEventListener(
      "click",
      () => this._confirmDeleteProblem(),
    );
    this.querySelector("#analysis-edit-save")?.addEventListener("click", () =>
      this._saveProblemEdit(),
    );
    this.querySelector("#analysis-success-undo")?.addEventListener(
      "click",
      () => this._analysisSuccessDialog?.close(),
    );
    this.querySelector("#analysis-progress-cancel")?.addEventListener(
      "click",
      () => this._analysisProgressDialog?.close(),
    );

    this._render();
    this._resumePendingEvidence();
  }

  /** The place new captures go to (the session's one synthetic place). */
  get _placeId() {
    return getCapturePlaceId();
  }

  _cancel() {
    if (!hasEvidence(getCurrentCheck())) {
      this._exitCapture({ discarded: true });
      window.setTimeout(() => clearCheck(), 0);
      return;
    }
    this._cancelDialog?.showModal();
  }

  _resumePendingEvidence() {
    for (const item of getItems()) {
      if (shouldResumeEvidenceItem(item)) {
        analyzeEvidenceItem(item.placeId || this._placeId, item.id);
      }
    }
  }

  _onGridClick(e) {
    const target = e.target;
    if (!(target instanceof Element)) return;
    if (target.closest("#add-photo")) {
      this._openCamera();
      return;
    }
    const del = target.closest("[data-del]");
    if (del) {
      const itemId = del.getAttribute("data-del");
      const item = getItems().find((candidate) => candidate.id === itemId);
      if (item) removeItem(item.placeId || this._placeId, itemId);
      this._render();
    }
  }

  _onDescriptionClick(e) {
    const target = e.target;
    if (!(target instanceof Element)) return;
    if (target.closest("[data-edit-description]")) {
      this._describeInstead();
      return;
    }
    const remove = target.closest("[data-remove-description]");
    if (remove) {
      const itemId = remove.getAttribute("data-remove-description");
      const item = getItems().find((candidate) => candidate.id === itemId);
      if (item) {
        // The description may already be a registered artifact — delete it
        // server-side too, or completeCheck folds the stale text into the
        // scorecard even though the card is gone locally.
        void removeEvidenceItem(item.placeId || this._placeId, itemId).catch(
          (err) => {
            console.error("Removing the description failed", err);
          },
        );
      }
      this._render();
    }
  }

  /**
   * Text is the alternative to photos: the describe screen saves one
   * description for the whole check (editing replaces it) and runs it through
   * the same analysis pipeline as a photo.
   */
  _describeInstead() {
    navigate("/check/describe");
  }

  _onFooterClick(e) {
    const target = e.target;
    if (!(target instanceof Element)) return;
    if (target.closest("#done-check")) {
      this._done();
      return;
    }
    if (target.closest("#toggle-analyzing")) {
      setAnalyzingOpen(!getAnalyzingOpen());
      this._render();
    }
  }

  _onAnalysisClick(e) {
    const target = e.target;
    if (!(target instanceof Element)) return;
    const button = target.closest("[data-analysis-action]");
    if (!button) return;
    const action = button.getAttribute("data-analysis-action");

    if (action === "retry") {
      const card = button.closest(".analysis-card");
      const placeId = card?.getAttribute("data-place-id") || "";
      const itemId = card?.getAttribute("data-item-id") || "";
      if (placeId && itemId) retryEvidenceItem(placeId, itemId);
      return;
    }
    if (action === "remove-item") {
      const card = button.closest(".analysis-card");
      const placeId = card?.getAttribute("data-place-id") || "";
      const itemId = card?.getAttribute("data-item-id") || "";
      if (placeId && itemId) this._removeFailedItem(placeId, itemId);
      return;
    }

    const card = button.closest(".analysis-card");
    if (!card) return;
    const problem = this._problemFromCard(card);
    if (action === "delete") {
      this._openDeleteProblem(problem);
    } else if (action === "edit") {
      this._openEditProblem(problem);
    } else if (action === "resolve") {
      this._resolveProblem(problem);
    } else if (action === "answer") {
      this._answerProblemQuestion(problem, button);
    }
  }

  _problemFromCard(card) {
    return {
      placeId: card.getAttribute("data-place-id") || "",
      itemId: card.getAttribute("data-item-id") || "",
      checkId: card.getAttribute("data-check-id") || "",
      artifactId: card.getAttribute("data-artifact-id") || "",
      taskId: card.getAttribute("data-task-id") || "",
      analysisId: card.getAttribute("data-analysis-id") || "",
      conditionId: card.getAttribute("data-condition-id") || "",
      actionKind: card.getAttribute("data-action-kind") || "",
      title: card.getAttribute("data-card-title") || "problem",
      description: card.getAttribute("data-card-description") || "",
    };
  }

  _openDeleteProblem(problem) {
    if (this._deletingProblem) return;
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
    if (!problem || this._deletingProblem) return;
    if (!problem.checkId || !problem.artifactId || !problem.conditionId) {
      this._setDialogError(
        "analysis-delete-error",
        this._missingConditionMessage(problem, "deleted"),
      );
      return;
    }

    this._deletingProblem = true;
    const button = this.querySelector("#analysis-delete-confirm");
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
          if (
            getCurrentCheck()?.id === problem.checkId &&
            problem.placeId &&
            problem.itemId
          ) {
            await refreshEvidenceAnalysis(
              problem.placeId,
              problem.itemId,
              result,
              {
                rejectedConditionId: problem.conditionId,
              },
            ).catch((error) => {
              console.error("refresh after saved deletion failed", error);
              if (getCurrentCheck()?.id === problem.checkId)
                this._deleteProblemLocally(problem);
            });
          }
        },
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
    if (this.isConnected) this._render();
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
        this._render();
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
    if (!problem.checkId || !problem.artifactId) {
      this._setDialogError(
        "analysis-edit-error",
        this._missingConditionMessage(problem, "edited"),
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
      await refreshEvidenceAnalysis(problem.placeId, problem.itemId, result);
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
    if (!problem.taskId) {
      this._analysisSuccessDialog?.showModal();
      return;
    }

    if (problem.actionKind === "escalation") {
      this._analysisProgressDialog?.showModal();
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
      this._analysisSuccessDialog?.showModal();
    } catch (err) {
      console.error("resolve task failed", err);
      this._showToast("Could not save that action. Please try again.");
    }
  }

  async _answerProblemQuestion(problem, button) {
    if (!(button instanceof HTMLButtonElement)) return;
    const answerKey = button.getAttribute("data-answer-key") || "";
    const answerValue = button.getAttribute("data-answer-value") === "true";
    if (
      !problem.placeId ||
      !problem.itemId ||
      !problem.conditionId ||
      !answerKey
    ) {
      this._showToast("Could not save that answer. Please try again.");
      return;
    }
    if (this._answeringConditionIds.has(problem.conditionId)) return;

    this._answeringConditionIds.add(problem.conditionId);
    setQuestionAnswerBusy(this, problem.conditionId, true);
    try {
      await answerAnalysisQuestion(
        problem.placeId,
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

  /** Drop a failed, never-uploaded photo from the session entirely. */
  _removeFailedItem(placeId, itemId) {
    const check = getCurrentCheck();
    const item = check?.places?.[placeId]?.items?.find(
      (candidate) => candidate.id === itemId,
    );
    if (!item) return;
    if (item.upload?.status === "uploaded") return;
    removeItem(placeId, itemId);
  }

  /**
   * Keep the pending card's elapsed timer live between renders. The card
   * carries `data-elapsed-since` (the stage timestamp); this ticker rewrites
   * the text in place every second — no re-render, no state churn.
   */
  _startElapsedTicker() {
    this._stopElapsedTicker();
    const tick = () => {
      for (const el of this.querySelectorAll("[data-elapsed-since]")) {
        const since = el.getAttribute("data-elapsed-since");
        const start = since ? Date.parse(since) : NaN;
        if (Number.isFinite(start)) {
          const seconds = Math.max(0, Math.round((Date.now() - start) / 1000));
          const minutes = Math.floor(seconds / 60);
          const rest = seconds % 60;
          el.textContent =
            minutes > 0 ? ` ${minutes}m ${rest}s` : ` ${seconds}s`;
        }
      }
    };
    tick();
    this._elapsedTicker = window.setInterval(tick, 1000);
  }

  _stopElapsedTicker() {
    if (this._elapsedTicker) {
      window.clearInterval(this._elapsedTicker);
      this._elapsedTicker = null;
    }
  }

  _setDialogError(id, message) {
    const error = this.querySelector(`#${id}`);
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

  /** Finish is disabled until the completion rule is met; this is the backstop. */
  _done() {
    if (!isPerimeterCheckComplete(getCurrentCheck())) return;
    this._finishCheck();
  }

  async _finishCheck() {
    const check = getCurrentCheck();
    const expectedArtifacts = expectedArtifactCountForCheck(check);
    this._finishing = true;
    this._deletionUnsub?.();
    this._unsubscribe?.();
    this._unsubscribe = null;
    if (this._embedded) {
      this.dispatchEvent(
        new CustomEvent("capturefinished", { bubbles: true, composed: true }),
      );
      window.setTimeout(() => {
        markCaptureComplete({
          checkId: check?.id,
          submissionKind: "check",
          expectedArtifacts,
        });
        finalizeCaptureScorecardInBackground(check?.id, { expectedArtifacts });
      }, 0);
      return;
    }
    markCaptureComplete({
      checkId: check?.id,
      submissionKind: "check",
      expectedArtifacts,
    });
    finalizeCaptureScorecardInBackground(check?.id, { expectedArtifacts });
    navigate("/today");
  }

  _exitCapture({ discarded = false } = {}) {
    this._finishing = true;
    this._deletionUnsub?.();
    this._unsubscribe?.();
    this._unsubscribe = null;
    if (this._embedded) {
      this.dispatchEvent(
        new CustomEvent("capturefinished", {
          bubbles: true,
          composed: true,
          detail: { flowType: "perimeter", discarded },
        }),
      );
      return;
    }
    navigate("/today");
  }

  _openCamera() {
    // Trace the tap → file-picker handoff: if the picker never opens (in-app
    // webview, OS restriction), the logs show the tap with no "picked" line
    // after it — the field demo "photo button did nothing" signature.
    mark("camera:open", { placeId: this._placeId });
    this._fileInput.value = "";
    this._fileInput.click();
  }

  _onFilePicked() {
    const file = this._fileInput.files && this._fileInput.files[0];
    if (!file) return;
    mark("camera:picked", { bytes: file.size, type: file.type });
    if (this._fileReader?.readyState === FileReader.LOADING) {
      this._fileReader.abort();
    }
    const originCheckId = this._checkId;
    const reader = new FileReader();
    this._fileReader = reader;
    reader.onload = () => {
      if (!this.isConnected || !isCurrentSession(originCheckId, "perimeter")) {
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

  _addPhoto(dataUrl) {
    const record = addItem(this._placeId, { kind: "photo", dataUrl });
    if (record) {
      setAnalyzingOpen(true);
      analyzeEvidenceItem(record.placeId, record.id);
    }
    this._render();
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
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => toast.remove(), 3500);
  }

  _render() {
    if (isDeletingAnalysisCard(this)) return;
    const check = getCurrentCheck();
    if (!check) return;
    const status = completionStatus(check);
    const photos = photoItems(check);
    const description = textItems(check)[0] || null;

    this.querySelector("#check-progress").innerHTML = progressLine(status);
    this.querySelector("#check-description").innerHTML =
      descriptionCard(description);
    const grid = this.querySelector("#shotgrid");
    grid.classList.toggle("shotgrid--empty", photos.length === 0);
    grid.innerHTML = photoGrid(photos);
    // One description per check: once saved, the card's Edit replaces it.
    this.querySelector("#describe-instead").hidden = Boolean(description);

    const evidence = getItems();
    this.querySelector("#check-footer").innerHTML = footer({
      items: evidence,
      analyzingOpen: getAnalyzingOpen(),
      complete: status.complete,
    });
    const existingTray = this.querySelector("#analysis-tray");
    existingTray?.remove();
    if (getAnalyzingOpen() && evidence.length) {
      this.querySelector("#check-footer").insertAdjacentHTML(
        "afterend",
        analyzingSection(evidence, check.id),
      );
    }
    this._startElapsedTicker();
  }

  disconnectedCallback() {
    if (this._fileReader?.readyState === FileReader.LOADING) {
      this._fileReader.abort();
    }
    this._stopElapsedTicker();
    this._deletionUnsub?.();
    this._unsubscribe?.();
    clearTimeout(this._toastTimer);
  }
}

customElements.define("perimeter-check", PerimeterCheck);

export function shouldResumeEvidenceItem(item) {
  const analysisStatus = item?.analysis?.status;
  const hasArtifact = Boolean(
    item?.analysis?.artifactId || item?.upload?.artifactId,
  );
  const hasUploadedArtifact = Boolean(
    item?.upload?.status === "uploaded" && hasArtifact,
  );
  const isRetryableTextRegistration = Boolean(
    item?.kind === "text" && analysisStatus === "failed" && !hasArtifact,
  );
  return Boolean(
    ["queued", "analyzing"].includes(analysisStatus) ||
      (analysisStatus === "failed" &&
        (hasUploadedArtifact || isRetryableTextRegistration)),
  );
}
