// Provider page actions, keyed by event type and control selector.
// <admin-provider-page> listens once per event type, so a redraw can't drop or double a handler.
import { actionFeedback } from "../../action-feedback.js";
import { adminApi } from "../../services/admin-api.js";
import { asForm, dataAttr } from "../../dom.js";
import {
  controlValue,
  syncDirtyForm,
  syncProviderDetailsForm,
} from "../../form-state.js";
import { addExtension, removeExtension } from "../../phone-extension.js";
import { navigate } from "../../router.js";
import { saveWithFeedback } from "../../save-feedback.js";
import {
  enrollmentCodeActions,
  siteManagerAccessActions,
} from "../site/manager.actions.js";
import {
  providerManagerPath,
  removeProviderManagerAccess,
  revokeProviderDevices,
} from "../../provider-manager-directory.js";
import { t } from "../../../../frontend/src/i18n/i18n.js";

/**
 * @typedef {import("./provider-page.js").ProviderPageElement} ProviderPageElement
 * @typedef {(page: ProviderPageElement, control: HTMLElement, event: Event) => void} ProviderAction
 */

/** @param {HTMLElement} form */
export function syncRevokeButton(form) {
  const button = form.querySelector("button[type='submit']");
  if (!(button instanceof HTMLButtonElement)) return;
  button.disabled =
    form.dataset.saving === "true" ||
    controlValue(form, "confirmation") !== form.dataset.confirmation;
}

/** @param {HTMLElement} form */
export function syncAddProgramButton(form) {
  const programSelect = /** @type {any} */ (
    form.querySelector("wa-select[name='program-id']")
  );
  const addProgramButton = form.querySelector("[data-add-program-button]");
  if (addProgramButton instanceof HTMLButtonElement) {
    addProgramButton.disabled = !String(programSelect?.value || "").trim();
  }
}

/** @param {HTMLElement} form */
const syncDetails = (form) => syncProviderDetailsForm(asForm(form));
/** @param {HTMLElement} form */
const syncDirty = (form) => syncDirtyForm(asForm(form));

/**
 * Shared by input and change, which both mean the user edited a field.
 * @type {Record<string, ProviderAction>}
 */
const edits = {
  "[data-provider-details-form]": (page, form) => syncDetails(form),
  "[data-dirty-form]": (page, form) => syncDirty(form),
  "[data-revoke-provider-devices]": (page, form) => syncRevokeButton(form),
  "[data-provider-program-form]": (page, form) => syncAddProgramButton(form),
};

/** @type {Record<string, Record<string, ProviderAction>>} */
export const providerEvents = {
  click: {
    "[data-add-provider-manager]": (page) =>
      page.querySelector("#add-provider-manager-dialog")?.showModal(),
    "[data-close-dialog]": (page, button) => button.closest("dialog")?.close(),
    "[data-provider-manager-status]": (page, button) =>
      page
        .setProviderManagerActive(
          dataAttr(button, "data-provider-manager-status"),
          dataAttr(button, "data-provider-manager-active") === "true",
        )
        .catch((error) => page.reportError(error)),
    "[data-issue-provider-manager-grant]": (page, button) =>
      page
        .issueProviderManagerGrant(
          dataAttr(button, "data-issue-provider-manager-grant"),
          button.dataset.deliveryMode || "link",
        )
        .catch((error) => page.reportError(error)),
    // The Site page shares this, since both scopes issue a code the same way.
    "[data-show-enrollment-code]": (page, button) =>
      void enrollmentCodeActions.showEnrollmentCode.call(
        page,
        button.dataset.enrollmentScope,
        button.getAttribute("data-show-enrollment-code"),
      ),
    "[data-copy-enrollment-url]": (page, button) => {
      if (button instanceof HTMLButtonElement)
        void siteManagerAccessActions.copyManagerGrant(button);
    },
    "[data-cancel-provider-manager-grant]": (page, button) =>
      page
        .cancelProviderManagerGrant(
          dataAttr(button, "data-cancel-provider-manager-grant"),
        )
        .catch((error) => page.reportError(error)),
    "[data-revoke-provider-enrollment]": (page, button) =>
      page
        .revokeProviderManagerEnrollment(
          dataAttr(button, "data-revoke-provider-enrollment"),
        )
        .catch((error) => page.reportError(error)),
    "[data-deactivate-provider]": (page) =>
      page.querySelector("#deactivate-provider-dialog")?.showModal(),
    "[data-add-extension]": (page, button) => addExtension(button),
    "[data-remove-extension]": (page, button) => removeExtension(button),
  },
  submit: {
    "[data-revoke-provider-devices]": (page, form, event) => {
      event.preventDefault();
      if (controlValue(form, "confirmation") !== form.dataset.confirmation)
        return;
      void saveWithFeedback(asForm(form), async () => {
        const feedback = actionFeedback("admin.toast.accessRemoved");
        try {
          if (form.dataset.membershipId)
            await removeProviderManagerAccess(
              adminApi,
              page.state.provider.providerId,
              form.dataset.membershipId,
            );
          else
            await revokeProviderDevices(
              adminApi,
              page.state.provider.providerId,
            );
          feedback.success();
          if (
            (await page.refreshProviderAccess(
              page.state.provider.providerId,
            )) === false
          )
            return;
        } catch (error) {
          feedback.failure(error);
          throw error;
        }
      }).then(() => syncRevokeButton(form));
    },
    "[data-new-provider-form]": (page, form, event) => {
      event.preventDefault();
      void saveWithFeedback(asForm(form), () =>
        page.createProvider(asForm(form)),
      );
    },
    "[data-provider-details-form]": (page, form, event) => {
      event.preventDefault();
      page
        .updateProvider(asForm(form))
        .catch((error) => page.reportError(error));
    },
    "[data-assign-existing-provider-person]": (page, form, event) => {
      event.preventDefault();
      void saveWithFeedback(asForm(form), async () => {
        const person = page.state.people.find(
          (p) => p.personId === controlValue(form, "person-id"),
        );
        if (!person) throw new Error(t("admin.relationships.choosePerson"));
        await adminApi.createProviderManager(
          page.state.provider.providerId,
          person,
        );
        if (
          (await page.refreshProviderAccess(page.state.provider.providerId)) ===
          false
        )
          return;
      });
    },
    "[data-transfer-provider-manager]": (page, form, event) => {
      event.preventDefault();
      void saveWithFeedback(asForm(form), async () => {
        const member = page.state.providerManagers.find(
          (m) => m.membershipId === form.dataset.transferProviderManager,
        );
        if (
          controlValue(form, "confirmation").trim().toLowerCase() !==
          member.email.toLowerCase()
        )
          throw new Error(t("admin.relationships.confirmationMismatch"));
        const { manager } = await adminApi.transferProviderManager(
          page.state.provider.providerId,
          member.membershipId,
          controlValue(form, "target-provider"),
        );
        form.dataset.isDirty = "false";
        navigate(providerManagerPath(manager.providerId, manager.membershipId));
      });
    },
    "[data-provider-manager-form]": (page, form, event) => {
      event.preventDefault();
      void saveWithFeedback(asForm(form), () =>
        page.saveProviderManager(asForm(form)),
      );
    },
    "[data-provider-program-form]": (page, form, event) => {
      event.preventDefault();
      page
        .addProgramToProvider(asForm(form))
        .catch((error) =>
          page.reportError(
            error.message === "program_has_sites"
              ? new Error(
                  "This Program has active Sites. Reassign those Sites before moving the Program to another provider.",
                )
              : error,
          ),
        );
    },
  },
  input: edits,
  change: edits,
  reset: {
    // After the reset lands, so the form reads its restored values.
    "[data-provider-details-form]": (page, form) =>
      queueMicrotask(() => syncDetails(form)),
    "[data-dirty-form]": (page, form) => queueMicrotask(() => syncDirty(form)),
  },
  // Escape fires cancel; it must not drop a save that is still running.
  cancel: {
    "[data-provider-manager-dialog]": (page, dialog, event) => {
      if (dialog.querySelector("form")?.dataset.saving === "true")
        event.preventDefault();
    },
  },
  close: {
    "[data-provider-manager-dialog]": (page, dialog) => {
      dialog.querySelector("form")?.reset();
      dialog.querySelector("[data-form-save-error]")?.remove();
    },
    "[data-deactivate-provider-dialog]": (page, dialog) => {
      if (/** @type {HTMLDialogElement} */ (dialog).returnValue !== "confirm")
        return;
      const button = page.querySelector("[data-deactivate-provider]");
      if (!button) return;
      page
        .deactivateProvider(dataAttr(button, "data-deactivate-provider"))
        .catch((error) =>
          page.reportError(
            error instanceof Error
              ? error
              : new Error("The provider could not be deactivated."),
          ),
        );
    },
  },
};
