// Site manager handlers, keyed by the control that starts each one: the
// manager page's record form, and the manager forms on a Site's Access tab.
import { adminApi } from "../../services/admin-api.js";
import { asForm, dataAttr } from "../../dom.js";
import { controlValue, syncDirtyForm } from "../../form-state.js";
import { addExtension, removeExtension } from "../../phone-extension.js";
import { t } from "../../../../frontend/src/i18n/i18n.js";

/**
 * @typedef {import("./manager-page.js").ManagerPageElement} ManagerPageElement
 * @typedef {(page: ManagerPageElement, control: any, event: any) => void} ManagerAction
 * @typedef {import("./record.bindings.js").SiteAction} SiteAction
 */

/** Revoking every device needs the manager's own email typed. @param {ManagerPageElement} page @param {any} form */
function syncRevokeManager(page, form) {
  const input = form.querySelector("wa-input");
  const button = form.querySelector("button");
  button.disabled =
    input.value.trim().toLowerCase() !==
    page.state.siteManager.email.toLowerCase();
}

/** @type {Record<string, Record<string, ManagerAction>>} */
export const siteManagerEvents = {
  submit: {
    "#site-manager-record-form": (page, form, event) => {
      event.preventDefault();
      // A disabled Program select is left out of FormData, so read the select.
      const programId = controlValue(form, "manager-program-id");
      if (
        page.state.siteManager &&
        page.state.siteManager.programId !== programId
      ) {
        page.querySelector("#manager-program-change-dialog")?.showModal();
        return;
      }
      page.saveSiteManager(asForm(form));
    },
    "#revoke-manager-devices": async (page, form, event) => {
      event.preventDefault();
      const input = form.querySelector("wa-input");
      const button = form.querySelector("button");
      if (button.disabled) return;
      button.disabled = true;
      input.disabled = true;
      const manager = page.state.siteManager;
      const status = form.querySelector("[data-revocation-status]");
      try {
        const result = manager.personId
          ? await adminApi.revokePersonDevices(manager.personId, input.value)
          : await adminApi.revokeManagerDevices(
              manager.programId,
              manager.userId,
              input.value,
            );
        status.textContent = t("admin.devices.managerRevoked", {
          count: result.affectedCount,
        });
        page.catalog.invalidate("managers");
        input.value = "";
      } catch {
        status.textContent = t("admin.devices.managerRevokeFailed");
      } finally {
        input.disabled = false;
        syncRevokeManager(page, form);
      }
    },
  },
  click: {
    "[data-remove-site-manager]": (page) =>
      page.querySelector("#remove-site-manager-dialog")?.showModal(),
    "[data-close-dialog]": (page, button) => button.closest("dialog")?.close(),
    "[data-add-extension]": (page, button) => addExtension(button),
    "[data-remove-extension]": (page, button) => removeExtension(button),
  },
  close: {
    "#manager-program-change-dialog": (page, dialog) => {
      if (dialog.returnValue !== "confirm") return;
      const form = page.querySelector("#site-manager-record-form");
      if (form instanceof HTMLFormElement && form.reportValidity()) {
        page.saveSiteManager(form);
      }
    },
    "#remove-site-manager-dialog": (page, dialog) => {
      if (dialog.returnValue !== "confirm") return;
      page.removeSiteManager();
    },
  },
  input: {
    "#revoke-manager-devices wa-input": (page, input) =>
      syncRevokeManager(page, input.closest("#revoke-manager-devices")),
    "#site-manager-record-form": (page, form) => syncDirtyForm(form),
  },
  change: {
    "wa-select[name='manager-program-id']": (page) =>
      syncDirtyForm(page.querySelector("#site-manager-record-form")),
    "#site-manager-record-form": (page, form) => syncDirtyForm(form),
  },
  reset: {
    "#site-manager-record-form": (page, form) =>
      queueMicrotask(() => syncDirtyForm(form)),
  },
};

/** @type {Record<string, Record<string, SiteAction>>} */
export const siteManagerAccessEvents = {
  submit: {
    "#manager-membership-form": (page, form, event) => {
      event.preventDefault();
      page
        .addManagerMembership(asForm(form))
        .catch((err) => page.reportError(err));
    },
    "#new-site-manager-form": (page, form, event) => {
      event.preventDefault();
      void page.createSiteManagerFromAccess(asForm(form));
    },
  },
  click: {
    "#create-site-manager": (page) => {
      page.querySelector("#new-site-manager-dialog")?.showModal();
      page.querySelector('[name="new-manager-first-name"]')?.focus();
    },
    "[data-cancel-new-site-manager]": (page) =>
      page.querySelector("#new-site-manager-dialog")?.close(),
    "[data-remove-manager-membership]": (page, button) =>
      page.openManagerMembershipRemoval(
        dataAttr(button, "data-remove-manager-membership"),
      ),
    "[data-issue-manager-grant]": (page, button) =>
      page
        .issueManagerGrant(
          dataAttr(button, "data-issue-manager-grant"),
          button.dataset.deliveryMode || "link",
        )
        .catch(() => {
          // issueManagerGrant already reports the failure through its toast.
        }),
    "[data-cancel-manager-grant]": (page, button) =>
      page
        .cancelManagerGrant(dataAttr(button, "data-cancel-manager-grant"))
        .catch((err) => page.reportError(err)),
    "[data-copy-enrollment-url]": (page, button) => {
      if (button instanceof HTMLButtonElement) {
        void page.copyManagerGrant(button);
      }
    },
  },
  cancel: {
    "#new-site-manager-dialog": (page, dialog, event) => {
      if (dialog.querySelector("form")?.dataset.saving) event.preventDefault();
    },
  },
  close: {
    "#new-site-manager-dialog": (page, dialog) => {
      const form = dialog.querySelector("form");
      form?.reset();
      if (form) {
        delete form.dataset.createdUser;
        delete form.dataset.saving;
      }
      form?.querySelectorAll("wa-input").forEach((input) => {
        input.disabled = false;
      });
      form?.querySelector("[data-form-save-error]")?.remove();
      page.querySelector("#create-site-manager")?.focus();
    },
    "#remove-manager-membership-dialog": (page, dialog) => {
      const target = page.state.managerMembershipRemovalTarget;
      page.state.managerMembershipRemovalTarget = null;
      if (dialog.returnValue !== "confirm" || !target?.membershipId) {
        return;
      }
      page
        .deactivateManagerMembership(target.membershipId)
        .catch((err) => page.reportError(err));
    },
  },
};

/**
 * Mark the record form clean after each redraw, so a redraw alone never counts as an unsaved edit.
 * @param {ManagerPageElement} page
 */
export function prepareSiteManager(page) {
  const form = page.querySelector("#site-manager-record-form");
  if (form instanceof HTMLFormElement) syncDirtyForm(form, true);
}
