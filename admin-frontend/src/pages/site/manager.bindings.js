// AdminApp.bind() adds these again after each render() replaces the HTML.
import { asForm, dataAttr } from "../../dom.js";
import { bindManagerAssignmentSearch } from "./manager-assignment-search.js";
import { formValue, syncDirtyForm } from "../../form-state.js";

/**
 * @typedef {import("../../admin-types.js").AdminAppElement} AdminAppElement
 */

/** @param {AdminAppElement} app */
export function bindSiteManager(app) {
  app
    .querySelector("#site-manager-record-form")
    ?.addEventListener("submit", (event) => {
      event.preventDefault();
      const form = asForm(event.currentTarget);
      const programId = formValue(new FormData(form), "manager-program-id");
      if (
        app.state.siteManager &&
        app.state.siteManager.programId !== programId
      ) {
        app.querySelector("#manager-program-change-dialog")?.showModal();
        return;
      }
      app.saveSiteManager(form);
    });
  const managerProgramChangeDialog = app.querySelector(
    "#manager-program-change-dialog",
  );
  managerProgramChangeDialog?.addEventListener("close", () => {
    if (managerProgramChangeDialog.returnValue !== "confirm") return;
    const form = app.querySelector("#site-manager-record-form");
    if (form instanceof HTMLFormElement && form.reportValidity()) {
      app.saveSiteManager(form);
    }
  });
  app
    .querySelector("[data-remove-site-manager]")
    ?.addEventListener("click", () => {
      app.querySelector("#remove-site-manager-dialog")?.showModal();
    });
  const removeSiteManagerDialog = app.querySelector(
    "#remove-site-manager-dialog",
  );
  removeSiteManagerDialog?.addEventListener("close", () => {
    if (removeSiteManagerDialog.returnValue !== "confirm") return;
    app.removeSiteManager();
  });
  app
    .querySelector("wa-select[name='manager-program-id']")
    ?.addEventListener("change", () => {
      syncDirtyForm(app.querySelector("#site-manager-record-form"));
    });
  app
    .querySelector("#manager-membership-form")
    ?.addEventListener("submit", (e) => {
      e.preventDefault();
      app.addManagerMembership(asForm(e.currentTarget)).catch((err) => {
        app.state.error = err.message;
        app.render();
      });
    });
  app.managerSearchCleanup?.();
  app.managerSearchCleanup = bindManagerAssignmentSearch(
    app.querySelector("#manager-membership-form"),
  );
  app.querySelector("#create-site-manager")?.addEventListener("click", () => {
    app.querySelector("#new-site-manager-dialog")?.showModal();
    app.querySelector('[name="new-manager-first-name"]')?.focus();
  });
  app
    .querySelector("#new-site-manager-form")
    ?.addEventListener("submit", (event) => {
      event.preventDefault();
      void app.createSiteManagerFromAccess(asForm(event.currentTarget));
    });
  const newManagerDialog = app.querySelector("#new-site-manager-dialog");
  app
    .querySelector("[data-cancel-new-site-manager]")
    ?.addEventListener("click", () => newManagerDialog?.close());
  newManagerDialog?.addEventListener("cancel", (event) => {
    if (newManagerDialog.querySelector("form")?.dataset.saving)
      event.preventDefault();
  });
  newManagerDialog?.addEventListener("close", () => {
    const form = newManagerDialog.querySelector("form");
    form?.reset();
    if (form) {
      delete form.dataset.createdUser;
      delete form.dataset.saving;
    }
    form?.querySelectorAll("wa-input").forEach((input) => {
      input.disabled = false;
    });
    form?.querySelector("[data-form-save-error]")?.remove();
    app.querySelector("#create-site-manager")?.focus();
  });
  app.querySelectorAll("[data-remove-manager-membership]").forEach((button) => {
    button.addEventListener("click", () => {
      app.openManagerMembershipRemoval(
        dataAttr(button, "data-remove-manager-membership"),
      );
    });
  });
  const removeManagerMembershipDialog = app.querySelector(
    "#remove-manager-membership-dialog",
  );
  removeManagerMembershipDialog?.addEventListener("close", () => {
    const target = app.state.managerMembershipRemovalTarget;
    app.state.managerMembershipRemovalTarget = null;
    if (
      removeManagerMembershipDialog.returnValue !== "confirm" ||
      !target?.membershipId
    ) {
      return;
    }
    app.deactivateManagerMembership(target.membershipId).catch((err) => {
      app.state.error = err.message;
      app.render();
    });
  });
  app.querySelectorAll("[data-issue-manager-grant]").forEach((button) => {
    button.addEventListener("click", () =>
      app
        .issueManagerGrant(
          dataAttr(button, "data-issue-manager-grant"),
          button.dataset.deliveryMode || "link",
        )
        .catch(() => {
          // issueManagerGrant already reports the failure through its toast.
        }),
    );
  });
  app.querySelectorAll("[data-cancel-manager-grant]").forEach((button) => {
    button.addEventListener("click", () =>
      app
        .cancelManagerGrant(dataAttr(button, "data-cancel-manager-grant"))
        .catch((err) => {
          app.state.error = err.message;
          app.render();
        }),
    );
  });
  app.querySelectorAll("[data-copy-enrollment-url]").forEach((button) => {
    button.addEventListener("click", () => {
      if (button instanceof HTMLButtonElement) {
        void app.copyManagerGrant(button);
      }
    });
  });
}
