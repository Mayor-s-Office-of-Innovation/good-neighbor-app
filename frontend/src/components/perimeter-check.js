// @ts-nocheck -- lenient migration baseline (checkJs).
/*
  perimeter-check — timeline capture flow.

  The perimeter check is now a place-by-place capture container. Each photo or
  typed description is analyzed independently as soon as it is submitted.
*/
import { getSite } from "../db.js";
import { navigate } from "../router.js";
import {
  analyzeNoIssueDescriptionEdit,
  analyzeEvidenceItem,
  refreshEvidenceAnalysis,
} from "../services/photo-analysis.js";
import {
  ApiError,
  completeTask,
  editAnalysisCondition,
  rejectAnalysisCondition,
} from "../services/api.js";
import {
  ensureCheck,
  startCheck,
  loadDraft,
  clearCheck,
  getPlaceOrder,
  getPlace,
  getCurrentCheck,
  getFlowType,
  getActivePlaceIndex,
  setActivePlaceIndex,
  addItem,
  skipPlace,
  isCurrentSession,
  setPlaceInputMode,
  addPlaceToCheck,
  getAnalyzingOpen,
  setAnalyzingOpen,
  getOpenPhotoMenuItemId,
  setOpenPhotoMenuItemId,
  setPlaceDraftText,
  updateItem,
  updateItemAnalysis,
  onCheckSessionChange,
} from "../state/check-session.js";
import {
  shell,
  placeRow,
  addPlaceButton,
  footer,
  analyzingSection,
} from "./perimeter-check.templates.js";

class PerimeterCheck extends HTMLElement {
  async connectedCallback() {
    this._photoMenuAnchor = null;
    this._site = await getSite();
    this._siteId =
      this._site.siteId || this._site.providerSiteId || this._site.id;
    const check = getCurrentCheck() || (await loadDraft("perimeter")) || null;
    if (!check) {
      ensureCheck(this._siteId, this._site.places || []);
    } else if (getFlowType() !== "perimeter") {
      startCheck(this._siteId, this._site.places || []);
    }

    this._checkId = getCurrentCheck()?.id || "";
    this._placeIndex = getActivePlaceIndex() ?? 0;
    this._unsubscribe = onCheckSessionChange(() => {
      if (this.isConnected) this._render();
    });
    this.innerHTML = shell();
    this._fileInput = this.querySelector("#file-input");
    this._cancelDialog = this.querySelector("#cancel-check-dialog");
    this._addPlaceDialog = this.querySelector("#add-place-dialog");
    this._addPlaceInput = this.querySelector("#add-place-name");
    this._doneIncompleteDialog = this.querySelector("#done-incomplete-dialog");
    this._analysisDeleteDialog = this.querySelector("#analysis-delete-dialog");
    this._analysisSuccessDialog = this.querySelector("#analysis-success-dialog");
    this._analysisProgressDialog = this.querySelector(
      "#analysis-progress-dialog",
    );
    this._analysisEditDialog = this.querySelector("#analysis-edit-dialog");
    this._analysisEditDescription = this.querySelector(
      "#analysis-edit-description",
    );

    this.querySelector("#cancel").addEventListener("click", () =>
      this._cancel(),
    );
    this.querySelector("#cancel-check-save")?.addEventListener("click", () => {
      this._cancelDialog?.close();
      navigate("/today");
    });
    this.querySelector("#cancel-check-discard")?.addEventListener(
      "click",
      () => {
        clearCheck();
        this._cancelDialog?.close();
        navigate("/today");
      },
    );
    this._cancelDialog?.addEventListener("click", (e) => {
      if (e.target === this._cancelDialog) this._cancelDialog.close();
    });
    this._doneIncompleteDialog?.addEventListener("click", (e) => {
      if (e.target === this._doneIncompleteDialog) {
        this._doneIncompleteDialog.close();
      }
    });
    this.querySelector("#done-incomplete-finish")?.addEventListener(
      "click",
      () => this._finishCheck(),
    );

    this.querySelector("#place-timeline").addEventListener("click", (e) =>
      this._onTimelineClick(e),
    );
    this.querySelector("#place-timeline").addEventListener("input", (e) =>
      this._onTimelineInput(e),
    );
    this.querySelector("#check-footer").addEventListener("click", (e) =>
      this._onFooterClick(e),
    );
    this.addEventListener("click", (e) => this._onAnalysisClick(e));
    this._fileInput.addEventListener("change", () => this._onFilePicked());
    this._addPlaceInput.addEventListener("input", () =>
      this._syncAddPlaceDialog(),
    );
    this.querySelector("#add-place-submit").addEventListener("click", () =>
      this._addPlace(),
    );
    this._addPlaceDialog?.addEventListener("close", () => {
      this._addPlaceInput.value = "";
      this._syncAddPlaceDialog();
    });
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

    document.addEventListener(
      "click",
      (this._documentClick = (event) => {
        const path = event.composedPath?.() || [];
        const withinPhotoMenu = path.some(
          (node) =>
            node instanceof Element &&
            (node.matches(".photo-menu") || node.matches("[data-photo-menu]")),
        );
        if (getOpenPhotoMenuItemId() && !withinPhotoMenu) {
          this._photoMenuAnchor = null;
          setOpenPhotoMenuItemId(null);
        }
      }),
    );

    this._render();
    this._resumePendingEvidence();
  }

  get _places() {
    return getPlaceOrder();
  }

  get _placeId() {
    return this._places[this._placeIndex];
  }

  _cancel() {
    if (!this._hasCheckContent()) {
      clearCheck();
      navigate("/today");
      return;
    }
    this._cancelDialog?.showModal();
  }

  _hasCheckContent() {
    const check = getCurrentCheck();
    if (!check) return false;
    return (check.placeOrder || []).some((placeId) => {
      const place = check.places[placeId];
      if (!place) return false;
      return Boolean(
        place.items?.length ||
          place.description?.text?.trim() ||
          place.draftText?.trim(),
      );
    });
  }

  _resumePendingEvidence() {
    const check = getCurrentCheck();
    if (!check) return;
    for (const placeId of check.placeOrder || []) {
      for (const item of check.places[placeId]?.items || []) {
        if (["queued", "analyzing"].includes(item.analysis?.status)) {
          analyzeEvidenceItem(placeId, item.id);
        }
      }
    }
  }

  _onTimelineClick(e) {
    const target = e.target;
    if (!(target instanceof Element)) return;

    const toggle = target.closest("[data-toggle-place]");
    if (toggle) {
      this._activatePlace(toggle.getAttribute("data-toggle-place"));
      return;
    }

    const addPhoto = target.closest("[data-add-photo]");
    if (addPhoto) {
      this._pendingPhotoPlaceId = addPhoto.getAttribute("data-add-photo");
      this._openCamera();
      return;
    }

    const next = target.closest("[data-next-place]");
    if (next) {
      this._advanceOrSkip(next.getAttribute("data-next-place"));
      return;
    }

    const type = target.closest("[data-type-place]");
    if (type) {
      setPlaceInputMode(type.getAttribute("data-type-place"), "text");
      this._photoMenuAnchor = null;
      setOpenPhotoMenuItemId(null);
      this._render();
      return;
    }

    const photo = target.closest("[data-photo-place]");
    if (photo) {
      setPlaceInputMode(photo.getAttribute("data-photo-place"), "photo");
      this._render();
      return;
    }

    const menu = target.closest("[data-photo-menu]");
    if (menu) {
      const itemId = menu.getAttribute("data-photo-menu");
      if (getOpenPhotoMenuItemId() === itemId) {
        this._photoMenuAnchor = null;
        setOpenPhotoMenuItemId(null);
      } else {
        this._photoMenuAnchor = this._anchorForPhotoMenu(menu);
        setOpenPhotoMenuItemId(itemId);
      }
      this._render();
      return;
    }

    if (target.closest("[data-photo-action]")) {
      this._photoMenuAnchor = null;
      setOpenPhotoMenuItemId(null);
      this._render();
      return;
    }

    const reviewText = target.closest("[data-review-text]");
    if (reviewText) {
      this._submitText(reviewText.getAttribute("data-review-text"));
    }
  }

  _onTimelineInput(e) {
    const target = e.target;
    if (!(target instanceof HTMLTextAreaElement)) return;
    const placeId = target.getAttribute("data-text-input");
    if (placeId) setPlaceDraftText(placeId, target.value);
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
    const card = button.closest(".analysis-card");
    if (!card) return;

    const action = button.getAttribute("data-analysis-action");
    const problem = this._problemFromCard(card);
    if (action === "delete") {
      this._openDeleteProblem(problem);
    } else if (action === "edit") {
      this._openEditProblem(problem);
    } else if (action === "resolve") {
      this._resolveProblem(problem);
    }
  }

  _problemFromCard(card) {
    return {
      placeId: card.getAttribute("data-place-id") || "",
      itemId: card.getAttribute("data-item-id") || "",
      taskId: card.getAttribute("data-task-id") || "",
      analysisId: card.getAttribute("data-analysis-id") || "",
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
    if (!problem.analysisId || !problem.conditionId) {
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
        problem.analysisId,
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
        this._showToast("Problem deleted.");
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
    if (!problem.analysisId) {
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
        problem.analysisId,
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
        await completeTask(problem.taskId, { completionMethod: "311_filed" });
        this._analysisProgressDialog?.close();
        this._markProblemResolved(problem);
        this._showToast("Success! 311 ticket filed.");
      } catch (err) {
        console.error("escalation failed", err);
        this._analysisProgressDialog?.close();
        this._showToast("Could not file the 311 ticket. Please try again.");
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
    return `This result is missing the original analysis ID, so it cannot be ${action}. Take a new photo and try again.`;
  }

  _requestId(action, problem) {
    const suffix =
      globalThis.crypto?.randomUUID?.() ||
      `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return `${this._checkId}:${problem.itemId}:${problem.conditionId}:${action}:${suffix}`;
  }

  _done() {
    const incompleteCount = this._incompletePlaceCount();
    if (incompleteCount > 0) {
      this._showDoneIncomplete(incompleteCount);
      return;
    }
    this._finishCheck();
  }

  _finishCheck() {
    clearCheck();
    this._doneIncompleteDialog?.close();
    navigate("/today");
  }

  _incompletePlaceCount() {
    const check = getCurrentCheck();
    if (!check) return 0;
    return (check.placeOrder || []).filter((placeId) => {
      const place = check.places[placeId];
      if (!place) return false;
      return !this._placeHasPhotoOrDescription(place);
    }).length;
  }

  _placeHasPhotoOrDescription(place) {
    return Boolean(
      place.items?.some(
        (item) => item.kind === "photo" || item.kind === "text",
      ) ||
        place.description?.validated ||
        place.draftText?.trim(),
    );
  }

  _showDoneIncomplete(incompleteCount) {
    const copy = this.querySelector("#done-incomplete-copy");
    const noun = incompleteCount === 1 ? "place does" : "places do";
    copy.textContent = `${incompleteCount} ${noun} not have a photo or description.`;
    this._doneIncompleteDialog?.showModal();
  }

  _activatePlace(placeId) {
    const index = this._places.indexOf(placeId);
    if (index === -1) return;
    if (this._placeIndex === index) {
      this._placeIndex = null;
      setActivePlaceIndex(null);
      this._photoMenuAnchor = null;
      setOpenPhotoMenuItemId(null);
      this._render();
      return;
    }
    this._placeIndex = index;
    setActivePlaceIndex(index);
    this._photoMenuAnchor = null;
    setOpenPhotoMenuItemId(null);
    this._render();
  }

  _advanceOrSkip(placeId) {
    const place = getPlace(placeId);
    if (!place) return;
    if (!place.items.length) skipPlace(placeId);
    const index = this._places.indexOf(placeId);
    this._placeIndex = Math.min(index + 1, this._places.length - 1);
    setActivePlaceIndex(this._placeIndex);
    this._photoMenuAnchor = null;
    setOpenPhotoMenuItemId(null);
    this._render();
  }

  _openCamera() {
    this._fileInput.value = "";
    this._fileInput.click();
  }

  _onFilePicked() {
    const file = this._fileInput.files && this._fileInput.files[0];
    if (!file) return;
    if (this._fileReader?.readyState === FileReader.LOADING) {
      this._fileReader.abort();
    }
    const originCheckId = this._checkId;
    const originPlaceId = this._pendingPhotoPlaceId || this._placeId;
    const reader = new FileReader();
    this._fileReader = reader;
    reader.onload = () => {
      if (!this.isConnected || !isCurrentSession(originCheckId, "perimeter")) {
        this._fileReader = null;
        return;
      }
      this._fileReader = null;
      if (typeof reader.result === "string") {
        this._addPhoto(originPlaceId, reader.result);
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

  _addPhoto(placeId, dataUrl) {
    const record = addItem(placeId, { kind: "photo", dataUrl });
    if (record) {
      setAnalyzingOpen(true);
      analyzeEvidenceItem(record.placeId, record.id);
    }
    this._render();
  }

  _submitText(placeId) {
    const input = [...this.querySelectorAll("[data-text-input]")].find(
      (candidate) => candidate.getAttribute("data-text-input") === placeId,
    );
    const text = input?.value?.trim();
    if (!text) return;
    const record = addItem(placeId, { kind: "text", text });
    setPlaceDraftText(placeId, "");
    updateItem(placeId, record.id, { upload: { status: "uploaded" } });
    setAnalyzingOpen(true);
    analyzeEvidenceItem(record.placeId, record.id);
    this._advanceOrSkip(placeId);
  }

  _syncAddPlaceDialog() {
    const input = this._addPlaceInput;
    const button = this.querySelector("#add-place-submit");
    const error = this.querySelector("#add-place-error");
    const value = input.value.trim();
    const duplicate = this._places.some((placeId) => {
      const place = getPlace(placeId);
      return place?.name.trim().toLowerCase() === value.toLowerCase();
    });
    input.classList.toggle("is-invalid", Boolean(value && duplicate));
    button.disabled = !value;
    error.textContent =
      value && duplicate ? "This place is already in the check." : "";
  }

  _anchorForPhotoMenu(button) {
    const expanded = button.closest(".place-row__expanded");
    if (!expanded) return null;
    const buttonRect = button.getBoundingClientRect();
    const expandedRect = expanded.getBoundingClientRect();
    return {
      top: Math.max(0, buttonRect.bottom - expandedRect.top + 12),
      right: Math.max(0, expandedRect.right - buttonRect.right),
    };
  }

  _addPlace() {
    const value = this._addPlaceInput.value.trim();
    const result = addPlaceToCheck(value);
    if (!result || result.duplicate) {
      this._syncAddPlaceDialog();
      return;
    }
    this._placeIndex = getActivePlaceIndex();
    this._addPlaceDialog.close();
    this._showToast(`${result.name} was added to this check.`);
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
    const check = getCurrentCheck();
    if (!check) return;
    const timeline = this.querySelector("#place-timeline");
    const openMenuItemId = getOpenPhotoMenuItemId();
    timeline.innerHTML =
      this._places
        .map((placeId, index) =>
          placeRow({
            place: check.places[placeId],
            index,
            expanded: index === this._placeIndex,
            isLast: index === this._places.length - 1,
            openMenuItemId,
            photoMenuAnchor: this._photoMenuAnchor,
          }),
        )
        .join("") + addPlaceButton();

    const evidence = this._allEvidence();
    this.querySelector("#check-footer").innerHTML = footer({
      items: evidence,
      analyzingOpen: getAnalyzingOpen(),
    });
    const existingTray = this.querySelector("#analysis-tray");
    existingTray?.remove();
    if (getAnalyzingOpen() && evidence.length) {
      this.querySelector("#check-footer").insertAdjacentHTML(
        "afterend",
        analyzingSection(evidence),
      );
    }
    this.querySelector("#add-place-open")?.addEventListener("click", () =>
      this._addPlaceDialog.showModal(),
    );
  }

  _allEvidence() {
    const check = getCurrentCheck();
    if (!check) return [];
    return (check.placeOrder || []).flatMap(
      (placeId) => check.places[placeId]?.items || [],
    );
  }

  disconnectedCallback() {
    if (this._fileReader?.readyState === FileReader.LOADING) {
      this._fileReader.abort();
    }
    document.removeEventListener("click", this._documentClick);
    this._unsubscribe?.();
    clearTimeout(this._toastTimer);
  }
}

customElements.define("perimeter-check", PerimeterCheck);
