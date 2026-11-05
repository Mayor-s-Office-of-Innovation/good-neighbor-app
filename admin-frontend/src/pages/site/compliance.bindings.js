// Site compliance handlers, keyed by the control that starts each one.
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
 * @typedef {import("./site-page.js").SitePageElement} SitePageElement
 * @typedef {import("./record.bindings.js").SiteAction} SiteAction
 */

/** A click on the dialog itself, outside its card, is a click on the backdrop. @param {any} dialog @param {any} event */
function outsideReasonsDialog(dialog, event) {
  if (event.target !== dialog) return false;
  const bounds = dialog.getBoundingClientRect();
  return (
    event.clientX < bounds.left ||
    event.clientX > bounds.right ||
    event.clientY < bounds.top ||
    event.clientY > bounds.bottom
  );
}

/** @param {SitePageElement} page */
function syncPeriodFields(page) {
  const form = page.querySelector("#site-compliance-form");
  const selected = [
    ...page.querySelectorAll("wa-checkbox[name='terms-reason']"),
  ]
    .filter((checkbox) => checkbox.checked)
    .map((checkbox) => checkbox.value);
  const expiry = page.querySelector("[data-expiry-field]");
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
}

/** @param {SitePageElement} page @param {any} form @param {Event} event */
async function saveTerms(page, form, event) {
  event.preventDefault();
  const currentForm = asForm(form);
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
    await page.createSiteTerms(currentForm);
  } catch (err) {
    const errorMessage = showFormSaveError(
      currentForm,
      compliancePeriodErrorMessage(err),
    );
    if (err instanceof Error && err.message === "generator_contact_required") {
      const [before, after] = t("admin.compliance.generatorContactRequired", {
        profile: "{profile}",
      }).split("{profile}");
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
        page.session.complianceDraft = captureComplianceDraft(
          currentForm,
          page.state.site.siteId,
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
}

/** @type {Record<string, Record<string, SiteAction>>} */
export const siteComplianceEvents = {
  click: {
    "[data-compliance-reason]": (page) =>
      page.querySelector("#compliance-reasons-dialog")?.showModal(),
    "#compliance-reasons-dialog": (page, dialog, event) => {
      if (page.reasonsBackdropPressed && outsideReasonsDialog(dialog, event))
        dialog.close();
      page.reasonsBackdropPressed = false;
    },
    "[data-require-checks]": (page) => {
      const dialog = page.querySelector("#new-checks-period-dialog");
      dialog?.showModal();
      dialog?.querySelector("wa-checkbox")?.focus();
    },
    "[data-end-checks]": (page) => {
      const dialog = page.querySelector("#end-checks-period-dialog");
      dialog.returnValue = "";
      dialog.showModal();
      dialog.querySelector('[value="cancel"]')?.focus();
    },
    "[data-cancel-checks-period]": (page) =>
      page.querySelector("#new-checks-period-dialog")?.close(),
    "[data-resend-letter]": async (page, button) => {
      button.disabled = true;
      const siteId = page.state.site.siteId;
      page.letterResendPending = siteId;
      const requestId = button.dataset.requestId || crypto.randomUUID();
      button.dataset.requestId = requestId;
      const feedback = actionFeedback("admin.toast.letterResendQueued");
      try {
        const queued = await adminApi.resendSiteLetter(siteId, requestId);
        feedback.success("admin.toast.letterResendQueued", "info");
        page.state.siteSaveMessage = t("admin.letters.resendQueued");
        page.letterResendPending = null;
        page.renderLetterStatus();
        void page.refreshLetterEmails(siteId, queued.jobId);
      } catch (error) {
        page.letterResendPending = null;
        feedback.failure(error);
        button.disabled = false;
        showFormSaveError(
          button.closest("section"),
          t("admin.letters.resendError"),
        );
      }
    },
    "#more-letter-history": (page) =>
      page.loadSiteLetters(page.state.site.siteId, true),
  },
  pointerdown: {
    "#compliance-reasons-dialog": (page, dialog, event) => {
      page.reasonsBackdropPressed = outsideReasonsDialog(dialog, event);
    },
  },
  toggle: {
    "[data-site-terms]": (page, details) => {
      if (!details.isConnected) return;
      page.state.expandedTermsSiteId = details.open
        ? page.state.site.siteId
        : null;
    },
    "[data-site-letters]": (page, details) => {
      if (!details.isConnected) return;
      const wasOpen =
        page.state.expandedLettersSiteId === page.state.site.siteId;
      page.state.expandedLettersSiteId = details.open
        ? page.state.site.siteId
        : null;
      if (details.open && !wasOpen)
        void page.loadSiteLetters(page.state.site.siteId);
    },
  },
  submit: {
    "#site-terms-form": saveTerms,
    "#site-compliance-form": saveTerms,
  },
  change: {
    "wa-checkbox[name='terms-reason']": syncPeriodFields,
    "#site-compliance-form": syncPeriodFields,
  },
  input: { "#site-compliance-form": syncPeriodFields },
  close: {
    "#end-checks-period-dialog": (page, dialog) => {
      if (dialog.returnValue === "confirm") {
        page.endSiteTerms().catch((error) => page.reportError(error));
      }
    },
  },
};

/**
 * Fill defaults, then reopen a period form the user left to edit their profile.
 * @param {SitePageElement} page
 */
export function prepareSiteCompliance(page) {
  const newPeriodDialog = page.querySelector("#new-checks-period-dialog");
  const requiredChecks = /** @type {{ value?: string } | null} */ (
    page.querySelector("wa-number-input[name='terms-checks-per-day']")
  );
  if (requiredChecks && !requiredChecks.value) requiredChecks.value = "3";
  syncPeriodFields(page);
  const session = page.session;
  const draft = session.complianceDraft;
  if (
    draft?.phase === "returning" &&
    page.state.site?.siteId === draft.siteId &&
    new URLSearchParams(window.location.search).get("section") === "compliance"
  ) {
    const form = page.querySelector("#site-compliance-form");
    if (form instanceof HTMLFormElement && newPeriodDialog) {
      restoreComplianceDraft(form, draft);
      // Web Awesome controls finish their internal render asynchronously.
      requestAnimationFrame(() => {
        if (!newPeriodDialog.isConnected || session.complianceDraft !== draft)
          return;
        try {
          newPeriodDialog.showModal();
          newPeriodDialog.querySelector("wa-checkbox")?.focus();
          session.complianceDraft = null;
        } catch {
          draft.phase = "recovery";
          page.reportDraftRecovery();
        }
      });
    } else {
      draft.phase = "recovery";
      queueMicrotask(() => page.reportDraftRecovery());
    }
  }
}
