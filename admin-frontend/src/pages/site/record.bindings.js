// Site details, perimeter and deactivation handlers, keyed by their control,
// so a redraw of the Site page never drops or doubles one.
import { actionFeedback } from "../../action-feedback.js";
import { adminApi } from "../../services/admin-api.js";
import { asForm, dataAttr } from "../../dom.js";
import { bindSiteProgramCreation } from "./site-program.js";
import {
  controlValue,
  markSiteDetailsSectionEdited,
  reportNamedControlsValidity,
  showFormSaveError,
  syncDirtyForm,
  syncSiteDetailsForm,
} from "../../form-state.js";
import { addExtension, removeExtension } from "../../phone-extension.js";
import { saveWithFeedback } from "../../save-feedback.js";
import { siteManagerContactDetails } from "./manager.templates.js";
import { t } from "../../../../frontend/src/i18n/i18n.js";

/**
 * @typedef {import("./site-page.js").SitePageElement} SitePageElement
 * @typedef {(page: SitePageElement, control: any, event: any) => void} SiteAction
 */

// Forms the unsaved-changes check watches; the details form keeps its own dirty state.
const TRACKED_FORMS =
  "#site-oversight-form, #site-compliance-form, #site-perimeter-form, #site-deliberate-311-form";

/** @param {SitePageElement} page */
function detailsForm(page) {
  return page.querySelector("#site-details-form");
}

/** @param {SitePageElement} page @param {HTMLFormElement} form @param {Event} [event] */
function syncDetails(page, form, event) {
  markSiteDetailsSectionEdited(form, event);
  syncSiteDetailsForm(form);
}

/** @param {SitePageElement} page @param {Element | null} form */
function confirmedSiteName(page, form) {
  const confirmation = form?.querySelector("[name='confirmation']");
  return (
    Boolean(page.state.site?.name) &&
    String(confirmation?.value || "") === page.state.site.name
  );
}

/** @param {SitePageElement} page @param {Element | null} form */
function syncDeactivateSubmit(page, form) {
  const submit = form?.querySelector("button[type='submit']");
  if (submit)
    submit.disabled =
      form.dataset.saving === "true" || !confirmedSiteName(page, form);
}

/** @param {SitePageElement} page @param {Element} control */
function syncDeactivateFrom(page, control) {
  syncDeactivateSubmit(page, control.closest("#deactivate-site-form"));
}

/** @type {Record<string, Record<string, SiteAction>>} */
export const siteRecordEvents = {
  submit: {
    "#site-details-form": (page, control, event) => {
      event.preventDefault();
      const form = asForm(control);
      if (
        !reportNamedControlsValidity(form, [
          "site-name",
          "public-contact-email",
          "public-contact-phone",
          "public-contact-extension",
        ])
      )
        return;
      page
        .updateSite(form, "details")
        .catch((error) => page.reportError(error));
    },
    "#site-deliberate-311-form": (page, form, event) => {
      event.preventDefault();
      void page.updateSiteDeliberate311(asForm(form));
    },
    "#site-perimeter-form": (page, form, event) => {
      event.preventDefault();
      page.updatePerimeter(asForm(form));
    },
    "#deactivate-site-form": async (page, form, event) => {
      event.preventDefault();
      if (
        !page.state.capabilities.createEntities ||
        !confirmedSiteName(page, form) ||
        form.dataset.saving === "true"
      )
        return;
      form.dataset.saving = "true";
      syncDeactivateSubmit(page, form);
      try {
        await page.deactivateSite(page.state.site.siteId);
      } catch {
        if (form.isConnected)
          showFormSaveError(form, t("admin.site.deactivateError"));
      } finally {
        delete form.dataset.saving;
        if (form.isConnected) syncDeactivateSubmit(page, form);
      }
    },
  },
  click: {
    "[data-save-address]": (page) => {
      const form = detailsForm(page);
      if (
        !(form instanceof HTMLFormElement) ||
        !reportNamedControlsValidity(form, [
          "street-address",
          "city",
          "state",
          "zip",
        ])
      )
        return;
      page
        .updateSite(form, "address")
        .catch((error) => page.reportError(error));
    },
    "[data-save-lead-program]": async (page) => {
      const form = detailsForm(page);
      if (
        !reportNamedControlsValidity(form, [
          "lead-program-id",
          "lead-provider-id",
        ])
      )
        return;
      try {
        const { preview } = await adminApi.reassignSite(
          page.state.site.siteId,
          controlValue(form, "lead-provider-id"),
          controlValue(form, "lead-program-id"),
          { preview: true },
        );
        form.dataset.reassignmentVersion = preview.updatedAt || "";
        const dialog = page.querySelector("#lead-program-confirmation-dialog");
        const providerChanged =
          controlValue(form, "lead-provider-id") !== page.state.site.providerId;
        dialog.querySelector("#lead-program-confirmation-copy").hidden =
          !providerChanged;
        if (providerChanged)
          dialog.setAttribute(
            "aria-describedby",
            "lead-program-confirmation-copy",
          );
        else dialog.removeAttribute("aria-describedby");
        dialog.showModal();
      } catch (error) {
        showFormSaveError(form, error.message);
      }
    },
    "#reload-site-perimeter": (page) => {
      if (page.state.site) page.openSite(page.state.site.siteId, false);
    },
    "[data-site]": (page, button) =>
      page.openSite(dataAttr(button, "data-site")),
    "[data-show-enrollment-code]": (page, button) =>
      page.showEnrollmentCode(
        button.dataset.enrollmentScope,
        button.getAttribute("data-show-enrollment-code"),
      ),
    "[data-close-dialog]": (page, button) => button.closest("dialog")?.close(),
    "[data-add-extension]": (page, button) => addExtension(button),
    "[data-remove-extension]": (page, button) => removeExtension(button),
  },
  close: {
    "#lead-program-confirmation-dialog": (page, dialog) => {
      const form = detailsForm(page);
      if (
        dialog.returnValue !== "confirm" ||
        !(form instanceof HTMLFormElement) ||
        !reportNamedControlsValidity(form, ["lead-program-id"])
      )
        return;
      page
        .updateSite(form, "lead-program")
        .catch((error) => page.reportError(error));
    },
  },
  "save-feedback-end": {
    "#site-deliberate-311-form": (page, form) => syncDirtyForm(form),
  },
  pointerdown: { "#site-details-form": syncDetails },
  keydown: { "#site-details-form": syncDetails },
  input: {
    "#site-details-form": (page, form, event) => {
      syncDetails(page, form, event);
      page.state.siteSaveMessage = "";
      page.state.siteSaveError = "";
      page.querySelector("#site-save-status")?.remove();
      page.querySelector("#site-save-error")?.remove();
    },
    "#deactivate-site-form [name='confirmation']": syncDeactivateFrom,
    [TRACKED_FORMS]: (page, form) => syncDirtyForm(form),
  },
  change: {
    "wa-select[name='site-manager-user-id']": (page, select) => {
      const user = page.state.availableSiteUsers.find(
        (item) => item.userId === select.value,
      );
      const target = page.querySelector("#site-manager-contact-details");
      if (target) target.innerHTML = siteManagerContactDetails(user);
      const form = detailsForm(page);
      if (form instanceof HTMLFormElement) syncSiteDetailsForm(form);
    },
    "#site-details-form": syncDetails,
    "#deactivate-site-form [name='confirmation']": syncDeactivateFrom,
    [TRACKED_FORMS]: (page, form) => syncDirtyForm(form),
  },
  reset: {
    // Passes the reset event on; without one, markSiteDetailsSectionEdited throws.
    "#site-details-form": (page, form, event) =>
      queueMicrotask(() => syncDetails(page, form, event)),
    [TRACKED_FORMS]: (page, form) => queueMicrotask(() => syncDirtyForm(form)),
  },
};

/**
 * Runs after each redraw: the details form starts clean, and Deactivate waits for the Site name.
 * @param {SitePageElement} page
 */
export function prepareSiteRecord(page) {
  const form = detailsForm(page);
  if (form instanceof HTMLFormElement) syncSiteDetailsForm(form, true);
  bindSiteProgramCreation(
    page,
    page.state,
    adminApi,
    saveWithFeedback,
    () => {
      if (form instanceof HTMLFormElement) syncSiteDetailsForm(form);
    },
    actionFeedback,
  );
  syncDeactivateSubmit(page, page.querySelector("#deactivate-site-form"));
}

/**
 * Mark these forms clean after each redraw, so a redraw alone never counts as an unsaved edit.
 * @param {SitePageElement} page
 */
export function prepareTrackedForms(page) {
  page
    .querySelectorAll(TRACKED_FORMS)
    .forEach((form) =>
      syncDirtyForm(/** @type {HTMLFormElement} */ (form), true),
    );
}
