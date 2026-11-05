// AdminApp.bind() adds these again after each render() replaces the HTML.
import { actionFeedback } from "../../action-feedback.js";
import { adminApi } from "../../services/admin-api.js";
import { asForm, dataAttr } from "../../dom.js";
import { controlValue, syncProviderDetailsForm } from "../../form-state.js";
import { navigate } from "../../router.js";
import {
  providerManagerPath,
  removeProviderManagerAccess,
  revokeProviderDevices,
} from "../../provider-manager-directory.js";
import { t } from "../../../../frontend/src/i18n/i18n.js";

/**
 * @typedef {import("../../admin-types.js").AdminAppElement} AdminAppElement
 */

/** @param {AdminAppElement} app */
export function bindProvider(app) {
  app.querySelectorAll("[data-revoke-provider-devices]").forEach((form) => {
    const button = form.querySelector("button[type='submit']");
    const sync = () => {
      button.disabled =
        form.dataset.saving === "true" ||
        controlValue(form, "confirmation") !== form.dataset.confirmation;
    };
    form.addEventListener("input", sync);
    form.addEventListener("change", sync);
    sync();
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (controlValue(form, "confirmation") !== form.dataset.confirmation)
        return;
      await app.saveWithFeedback(form, async () => {
        const feedback = actionFeedback("admin.toast.accessRemoved");
        try {
          if (form.dataset.membershipId)
            await removeProviderManagerAccess(
              adminApi,
              app.state.provider.providerId,
              form.dataset.membershipId,
            );
          else
            await revokeProviderDevices(
              adminApi,
              app.state.provider.providerId,
            );
          feedback.success();
          if (
            (await app.refreshProviderAccess(app.state.provider.providerId)) ===
            false
          )
            return;
        } catch (error) {
          feedback.failure(error);
          throw error;
        }
      });
      sync();
    });
  });
  app.querySelector("#provider-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const form = asForm(e.currentTarget);
    void app.saveWithFeedback(form, () => app.createProvider(form));
  });
  app
    .querySelector("#provider-details-form")
    ?.addEventListener("submit", (event) => {
      event.preventDefault();
      app.updateProvider(asForm(event.currentTarget)).catch((error) => {
        app.state.error = error.message;
        app.render();
      });
    });
  app
    .querySelector("[data-assign-existing-provider-person]")
    ?.addEventListener("submit", (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      void app.saveWithFeedback(form, async () => {
        const person = app.state.people.find(
          (p) => p.personId === controlValue(form, "person-id"),
        );
        if (!person) throw new Error(t("admin.relationships.choosePerson"));
        await adminApi.createProviderManager(
          app.state.provider.providerId,
          person,
        );
        if (
          (await app.refreshProviderAccess(app.state.provider.providerId)) ===
          false
        )
          return;
      });
    });
  app.querySelector("#add-provider-manager")?.addEventListener("click", () => {
    app.querySelector("#add-provider-manager-dialog")?.showModal();
  });
  app.querySelectorAll("[data-edit-provider-manager]").forEach((button) => {
    button.addEventListener("click", () => {
      const dialog = button
        .closest("[data-provider-manager-row]")
        ?.querySelector("dialog");
      dialog?.showModal();
      dialog?.querySelector("wa-input")?.focus();
    });
  });
  app.querySelectorAll("[data-provider-manager-dialog]").forEach((dialog) => {
    dialog.addEventListener("cancel", (event) => {
      if (dialog.querySelector("form")?.dataset.saving === "true") {
        event.preventDefault();
      }
    });
    dialog.addEventListener("close", () => {
      dialog.querySelector("form")?.reset();
      dialog.querySelector("[data-form-save-error]")?.remove();
    });
  });
  app.querySelectorAll("[data-transfer-provider-manager]").forEach((form) =>
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void app.saveWithFeedback(form, async () => {
        const member = app.state.providerManagers.find(
          (m) => m.membershipId === form.dataset.transferProviderManager,
        );
        if (
          controlValue(form, "confirmation").trim().toLowerCase() !==
          member.email.toLowerCase()
        )
          throw new Error(t("admin.relationships.confirmationMismatch"));
        const { manager } = await adminApi.transferProviderManager(
          app.state.provider.providerId,
          member.membershipId,
          controlValue(form, "target-provider"),
        );
        form.dataset.isDirty = "false";
        navigate(providerManagerPath(manager.providerId, manager.membershipId));
      });
    }),
  );
  app.querySelectorAll("[data-provider-manager-form]").forEach((form) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const submittedForm = asForm(event.currentTarget);
      await app.saveWithFeedback(submittedForm, () =>
        app.saveProviderManager(submittedForm),
      );
    });
  });
  app.querySelectorAll("[data-provider-manager-status]").forEach((button) => {
    button.addEventListener("click", () => {
      app
        .setProviderManagerActive(
          dataAttr(button, "data-provider-manager-status"),
          dataAttr(button, "data-provider-manager-active") === "true",
        )
        .catch((error) => {
          app.state.error = error.message;
          app.render();
        });
    });
  });
  app
    .querySelectorAll("[data-issue-provider-manager-grant]")
    .forEach((button) => {
      button.addEventListener("click", () => {
        app
          .issueProviderManagerGrant(
            dataAttr(button, "data-issue-provider-manager-grant"),
            button.dataset.deliveryMode || "link",
          )
          .catch((error) => {
            app.state.error = error.message;
            app.render();
          });
      });
    });
  app
    .querySelectorAll("[data-cancel-provider-manager-grant]")
    .forEach((button) => {
      button.addEventListener("click", () => {
        app
          .cancelProviderManagerGrant(
            dataAttr(button, "data-cancel-provider-manager-grant"),
          )
          .catch((error) => {
            app.state.error = error.message;
            app.render();
          });
      });
    });
  app
    .querySelectorAll("[data-revoke-provider-enrollment]")
    .forEach((button) => {
      button.addEventListener("click", () => {
        app
          .revokeProviderManagerEnrollment(
            dataAttr(button, "data-revoke-provider-enrollment"),
          )
          .catch((error) => {
            app.state.error = error.message;
            app.render();
          });
      });
    });
  app
    .querySelector("#provider-program-form")
    ?.addEventListener("submit", (event) => {
      event.preventDefault();
      app.addProgramToProvider(asForm(event.currentTarget)).catch((error) => {
        app.state.error =
          error.message === "program_has_sites"
            ? "This Program has active Sites. Reassign those Sites before moving the Program to another provider."
            : error.message;
        app.render();
      });
    });
  const providerProgramForm = app.querySelector("#provider-program-form");
  if (providerProgramForm instanceof HTMLFormElement) {
    const programSelect = providerProgramForm.querySelector(
      "wa-select[name='program-id']",
    );
    const addProgramButton = providerProgramForm.querySelector(
      "[data-add-program-button]",
    );
    const syncAddProgramButton = () => {
      if (addProgramButton instanceof HTMLButtonElement) {
        addProgramButton.disabled = !String(programSelect?.value || "").trim();
      }
    };
    syncAddProgramButton();
    programSelect?.addEventListener("change", syncAddProgramButton);
    programSelect?.addEventListener("input", syncAddProgramButton);
  }
  const providerDetailsForm = app.querySelector("#provider-details-form");
  if (providerDetailsForm instanceof HTMLFormElement) {
    const sync = () => syncProviderDetailsForm(providerDetailsForm);
    sync();
    providerDetailsForm.addEventListener("input", sync);
    providerDetailsForm.addEventListener("change", sync);
    providerDetailsForm.addEventListener("reset", () => queueMicrotask(sync));
  }
  app.querySelectorAll("[data-provider]").forEach((button) => {
    button.addEventListener("click", () =>
      app.openProvider(dataAttr(button, "data-provider")),
    );
  });
  app.querySelectorAll("[data-deactivate-provider]").forEach((button) => {
    button.addEventListener("click", () => {
      app.querySelector("#deactivate-provider-dialog")?.showModal();
    });
  });
  const deactivateProviderDialog = app.querySelector(
    "#deactivate-provider-dialog",
  );
  deactivateProviderDialog?.addEventListener("close", () => {
    if (deactivateProviderDialog.returnValue !== "confirm") return;
    const button = app.querySelector("[data-deactivate-provider]");
    if (!button) return;
    app
      .deactivateProvider(dataAttr(button, "data-deactivate-provider"))
      .catch((error) => {
        app.state.error =
          error instanceof Error
            ? error.message
            : "The provider could not be deactivated.";
        app.render();
      });
  });
}
