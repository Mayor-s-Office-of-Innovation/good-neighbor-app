// Admin users and My profile actions, keyed by event type and control selector.
// <admin-users-page> listens once per event type, so a redraw can't drop or double a handler.
import { asForm } from "../../dom.js";
import { showFormSaveError, syncDirtyForm } from "../../form-state.js";
import { addExtension, removeExtension } from "../../phone-extension.js";
import { t } from "../../../../frontend/src/i18n/i18n.js";
import { withSaveFeedback } from "../../save-feedback.js";
import { adminInvitationError } from "./admin-user.templates.js";

/**
 * @typedef {import("./admin-users-page.js").AdminUsersPageElement} AdminUsersPageElement
 * @typedef {(page: AdminUsersPageElement, control: HTMLElement, event: Event) => void} AdminUserAction
 */

/** @type {Record<string, Record<string, AdminUserAction>>} */
export const adminUserEvents = {
  click: {
    "#show-admin-role-help": (page) =>
      page.querySelector("#admin-role-help-dialog")?.showModal(),
    "[data-admin-user-action]": (page, button) =>
      page.runAdminUserAction(/** @type {HTMLButtonElement} */ (button)),
    "[data-add-extension]": (page, button) => addExtension(button),
    "[data-remove-extension]": (page, button) => removeExtension(button),
  },
  submit: {
    "#admin-user-form": (page, control, event) => {
      event.preventDefault();
      const form = asForm(control);
      if (!form.querySelector('[name="email"]').reportValidity()) return;
      const ensureLookup = page.ensureInvitationLookup;
      void withSaveFeedback(
        form,
        async () => {
          await ensureLookup?.();
          if (!form.isConnected || !form.reportValidity()) return;
          return page.inviteAdministrator(form);
        },
        {
          savingLabel: t("admin.users.sending"),
          onError: (error) =>
            showFormSaveError(form, adminInvitationError(error)),
        },
      );
    },
    "#my-profile-form": (page, form, event) => {
      event.preventDefault();
      void page.saveMyProfile(asForm(form));
    },
  },
  input: { "[data-dirty-form]": (page, form) => syncDirtyForm(asForm(form)) },
  change: {
    "#admin-user-status-filter": (page, select) => {
      page.state.adminUserStatusFilter = String(
        /** @type {any} */ (select).value || "all",
      );
      page.render();
    },
    "[data-admin-role]": (page, select) =>
      page.changeAdminRole(/** @type {any} */ (select)),
    "[data-dirty-form]": (page, form) => syncDirtyForm(asForm(form)),
  },
};
