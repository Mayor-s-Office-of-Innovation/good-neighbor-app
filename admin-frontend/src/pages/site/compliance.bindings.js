// AdminApp.bind() adds these again after each render() replaces the HTML.
import { actionFeedback } from "../../action-feedback.js";
import { adminApi } from "../../services/admin-api.js";
import { asForm } from "../../dom.js";
import {
  captureComplianceDraft,
  restoreComplianceDraft,
} from "../../compliance-profile-draft.js";
import { compliancePeriodErrorMessage } from "./save-error-messages.js";
import {
  compliancePeriodValidationError,
  showFormSaveError,
} from "../../form-state.js";
import { navigate } from "../../router.js";
import { t } from "../../../../frontend/src/i18n/i18n.js";

/**
 * @typedef {import("../../admin-types.js").AdminAppElement} AdminAppElement
 */

/** @param {AdminAppElement} app */
export function bindSiteCompliance(app) {
  app.querySelectorAll("[data-compliance-reason]").forEach((button) => {
    button.addEventListener("click", () => {
      const dialog = app.querySelector("#compliance-reasons-dialog");
      dialog?.showModal();
    });
  });
  const reasonsDialog = app.querySelector("#compliance-reasons-dialog");
  const outsideReasonsDialog = (event) => {
    if (!reasonsDialog || event.target !== reasonsDialog) return false;
    const bounds = reasonsDialog.getBoundingClientRect();
    return (
      event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom
    );
  };
  let reasonsBackdropPressed = false;
  reasonsDialog?.addEventListener("pointerdown", (event) => {
    reasonsBackdropPressed = outsideReasonsDialog(event);
  });
  reasonsDialog?.addEventListener("click", (event) => {
    if (reasonsBackdropPressed && outsideReasonsDialog(event))
      reasonsDialog.close();
    reasonsBackdropPressed = false;
  });
  app
    .querySelector("[data-site-terms]")
    ?.addEventListener("toggle", (event) => {
      if (!event.currentTarget.isConnected) return;
      app.state.expandedTermsSiteId = event.currentTarget.open
        ? app.state.site.siteId
        : null;
    });
  bindLetterActions(app);
  app
    .querySelectorAll("#site-terms-form, #site-compliance-form")
    .forEach((form) =>
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const currentForm = asForm(e.currentTarget);
        const validationError = compliancePeriodValidationError(currentForm);
        if (validationError) {
          return;
        }
        const saveButton = /** @type {HTMLButtonElement | null} */ (
          currentForm.querySelector("[data-save-button]")
        );
        if (saveButton) {
          saveButton.disabled = true;
          saveButton.textContent = "Saving…";
        }
        try {
          await app.createSiteTerms(currentForm);
        } catch (err) {
          const errorMessage = showFormSaveError(
            currentForm,
            compliancePeriodErrorMessage(err),
          );
          if (
            err instanceof Error &&
            err.message === "generator_contact_required"
          ) {
            const [before, after] = t(
              "admin.compliance.generatorContactRequired",
              { profile: "{profile}" },
            ).split("{profile}");
            const profileLink = document.createElement("a");
            profileLink.href = "/profile";
            profileLink.textContent = t("admin.profile.title");
            profileLink.addEventListener("click", (event) => {
              if (
                event.button !== 0 ||
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey
              )
                return;
              event.preventDefault();
              app.state.complianceProfileDraft = captureComplianceDraft(
                currentForm,
                app.state.site.siteId,
              );
              navigate("/profile");
            });
            errorMessage.replaceChildren(before, profileLink, after || "");
          }
          if (saveButton) {
            saveButton.disabled = false;
            saveButton.textContent = t("admin.letters.saveSend");
          }
        }
      }),
    );
  const newPeriodDialog = app.querySelector("#new-checks-period-dialog");
  const endPeriodDialog = app.querySelector("#end-checks-period-dialog");
  const requiredChecks = /** @type {{ value?: string } | null} */ (
    app.querySelector("wa-number-input[name='terms-checks-per-day']")
  );
  if (requiredChecks && !requiredChecks.value) requiredChecks.value = "3";
  app.querySelector("[data-require-checks]")?.addEventListener("click", () => {
    newPeriodDialog?.showModal();
    newPeriodDialog?.querySelector("wa-checkbox")?.focus();
  });
  app.querySelector("[data-end-checks]")?.addEventListener("click", () => {
    endPeriodDialog.returnValue = "";
    endPeriodDialog.showModal();
    endPeriodDialog.querySelector('[value="cancel"]')?.focus();
  });
  const syncPeriodFields = () => {
    const form = app.querySelector("#site-compliance-form");
    const selected = [
      ...app.querySelectorAll("wa-checkbox[name='terms-reason']"),
    ]
      .filter((checkbox) => checkbox.checked)
      .map((checkbox) => checkbox.value);
    const expiry = app.querySelector("[data-expiry-field]");
    const needsExpiry = selected.some((reason) => ["1", "6"].includes(reason));
    expiry?.toggleAttribute("hidden", !needsExpiry);
    expiry?.toggleAttribute("required", needsExpiry);
    if (form instanceof HTMLFormElement) {
      const saveButton = /** @type {HTMLButtonElement | null} */ (
        form.querySelector("[data-save-button]")
      );
      if (saveButton) {
        saveButton.disabled = Boolean(compliancePeriodValidationError(form));
      }
      const error = /** @type {HTMLElement | null} */ (
        form.querySelector("[data-form-save-error]")
      );
      if (error) {
        error.textContent = "";
        error.hidden = true;
      }
    }
  };
  app
    .querySelectorAll("wa-checkbox[name='terms-reason']")
    .forEach((checkbox) =>
      checkbox.addEventListener("change", syncPeriodFields),
    );
  app
    .querySelector("#site-compliance-form")
    ?.addEventListener("input", syncPeriodFields);
  app
    .querySelector("#site-compliance-form")
    ?.addEventListener("change", syncPeriodFields);
  app
    .querySelector("#retry-compliance-draft")
    ?.addEventListener("click", () => {
      const draft = app.state.complianceProfileDraft;
      if (!draft) return;
      draft.phase = "returning";
      app.state.error = "";
      navigate(`/sites/${encodeURIComponent(draft.siteId)}?section=compliance`);
    });
  syncPeriodFields();
  const draft = app.state.complianceProfileDraft;
  if (
    draft?.phase === "returning" &&
    app.state.site?.siteId === draft.siteId &&
    new URLSearchParams(window.location.search).get("section") === "compliance"
  ) {
    const form = app.querySelector("#site-compliance-form");
    if (form instanceof HTMLFormElement && newPeriodDialog) {
      restoreComplianceDraft(form, draft);
      // Web Awesome controls finish their internal render asynchronously.
      requestAnimationFrame(() => {
        if (
          !newPeriodDialog.isConnected ||
          app.state.complianceProfileDraft !== draft
        )
          return;
        try {
          newPeriodDialog.showModal();
          newPeriodDialog.querySelector("wa-checkbox")?.focus();
          app.state.complianceProfileDraft = null;
        } catch {
          draft.phase = "recovery";
          app.render();
        }
      });
    } else {
      draft.phase = "recovery";
      queueMicrotask(() => app.render());
    }
  }
  app
    .querySelector("[data-cancel-checks-period]")
    ?.addEventListener("click", () => {
      newPeriodDialog?.close();
    });
  endPeriodDialog?.addEventListener("close", () => {
    if (endPeriodDialog.returnValue === "confirm") {
      app.endSiteTerms().catch((error) => {
        app.state.error = error.message;
        app.render();
      });
    }
  });
}

/** @param {AdminAppElement} app */
export function bindLetterActions(app) {
  app
    .querySelector("[data-resend-letter]")
    ?.addEventListener("click", async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      const siteId = app.state.site.siteId;
      app.letterResendPending = siteId;
      const requestId = button.dataset.requestId || crypto.randomUUID();
      button.dataset.requestId = requestId;
      const feedback = actionFeedback("admin.toast.letterResendQueued");
      try {
        const queued = await adminApi.resendSiteLetter(siteId, requestId);
        feedback.success("admin.toast.letterResendQueued", "info");
        app.state.siteSaveMessage = t("admin.letters.resendQueued");
        app.letterResendPending = null;
        app.renderLetterStatus();
        void app.refreshLetterEmails(siteId, queued.jobId);
      } catch (error) {
        app.letterResendPending = null;
        feedback.failure(error);
        button.disabled = false;
        showFormSaveError(
          button.closest("section"),
          t("admin.letters.resendError"),
        );
      }
    });
  app
    .querySelector("[data-site-letters]")
    ?.addEventListener("toggle", (event) => {
      if (!event.currentTarget.isConnected) return;
      const wasOpen = app.state.expandedLettersSiteId === app.state.site.siteId;
      app.state.expandedLettersSiteId = event.currentTarget.open
        ? app.state.site.siteId
        : null;
      if (event.currentTarget.open && !wasOpen)
        void app.loadSiteLetters(app.state.site.siteId);
    });
  app
    .querySelector("#more-letter-history")
    ?.addEventListener("click", () =>
      app.loadSiteLetters(app.state.site.siteId, true),
    );
}
