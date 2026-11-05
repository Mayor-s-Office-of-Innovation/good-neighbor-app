// AdminApp.bind() adds these again after each render() replaces the HTML.
import { actionFeedback } from "../../action-feedback.js";
import { adminApi } from "../../services/admin-api.js";
import { bindAdminInvitationLookup } from "./admin-invitation-lookup.js";
import { adminInvitationError } from "./admin-user.templates.js";
import { asForm, dataAttr } from "../../dom.js";
import {
  formValue,
  showFormSaveError,
  syncDirtyForm,
} from "../../form-state.js";
import { navigate } from "../../router.js";
import { profilePhoneUpdate } from "../../admin-save-state.js";
import { t } from "../../../../frontend/src/i18n/i18n.js";
import { withSaveFeedback } from "../../save-feedback.js";

/**
 * @typedef {import("../../admin-types.js").AdminAppElement} AdminAppElement
 */

/** @param {AdminAppElement} app */
export function bindAdminUsers(app) {
  const invitationForm = app.querySelector("#admin-user-form");
  const ensureInvitationLookup = invitationForm
    ? bindAdminInvitationLookup(
        invitationForm,
        adminApi.lookupAdminInvitation,
        t,
      )
    : null;
  invitationForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = asForm(event.currentTarget);
    if (!form.querySelector('[name="email"]').reportValidity()) return;
    void withSaveFeedback(
      form,
      async () => {
        await ensureInvitationLookup();
        if (!form.isConnected || !form.reportValidity()) return;
        return app.inviteAdministrator(form);
      },
      {
        savingLabel: t("admin.users.sending"),
        onError: (error) =>
          showFormSaveError(form, adminInvitationError(error)),
      },
    );
  });
  app
    .querySelector("#admin-user-status-filter")
    ?.addEventListener("change", (event) => {
      app.state.adminUserStatusFilter = String(
        event.currentTarget.value || "all",
      );
      app.render();
    });
  app.querySelector("#show-admin-role-help")?.addEventListener("click", () => {
    app.querySelector("#admin-role-help-dialog")?.showModal();
  });
  app.querySelectorAll("[data-admin-user-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const username = dataAttr(button, "data-username");
      const action = dataAttr(button, "data-admin-user-action");
      const requests = {
        suspend: () => adminApi.suspendAdminUser(username),
        reinstate: () => adminApi.reinstateAdminUser(username),
        reinvite: () => adminApi.reinviteAdminUser(username),
        reset: () => adminApi.resetAdminUserPassword(username),
      };
      const feedback = actionFeedback(
        {
          suspend: "admin.toast.adminSuspended",
          reinstate: "admin.toast.adminReinstated",
          reinvite: "admin.toast.invitationSent",
          reset: "admin.toast.passwordReset",
        }[action],
      );
      const request = requests[action]?.();
      if (!request) return;
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
      button.textContent = "Working…";
      request
        .then(() => {
          app.programManagersStale = true;
          feedback.success();
          app.state.adminUserMessage = "";
          return app.openRoute();
        })
        .catch((error) => {
          feedback.failure(error);
          app.state.error = error.message;
          app.render();
        });
    });
  });
  app.querySelectorAll("[data-admin-role]").forEach((select) => {
    select.addEventListener("change", () => {
      const feedback = actionFeedback("admin.toast.roleUpdated");
      adminApi
        .updateAdminUserRole(
          dataAttr(select, "data-username"),
          String(select.value),
        )
        .then(() => {
          feedback.success();
          return app.openRoute();
        })
        .catch((error) => {
          feedback.failure(error);
          app.state.error = error.message;
          app.render();
        });
    });
  });
  const profileForm = app.querySelector("#my-profile-form");
  if (profileForm) {
    const sync = () => syncDirtyForm(profileForm);
    syncDirtyForm(profileForm, true);
    profileForm.addEventListener("input", sync);
    profileForm.addEventListener("change", sync);
    profileForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (profileForm.dataset.saving === "true") return;
      const feedback = actionFeedback("admin.profile.saved");
      profileForm.dataset.saving = "true";
      const save = profileForm.querySelector("[data-save-button]");
      save.disabled = true;
      try {
        const data = new FormData(asForm(profileForm));
        const result = await adminApi.updateMyProfile({
          firstName: formValue(data, "firstName"),
          lastName: formValue(data, "lastName"),
          phoneExtension: formValue(data, "phoneExtension"),
          ...profilePhoneUpdate(
            formValue(data, "phone"),
            app.state.profile.phone,
          ),
        });
        feedback.success();
        app.state.profile = result.profile;
        const managerId = result.profile.directoryUserId;
        if (managerId) {
          const name = `${result.profile.firstName} ${result.profile.lastName}`;
          app.state.programManagers = app.state.programManagers.map(
            (manager) =>
              manager.userId === managerId
                ? {
                    ...manager,
                    firstName: result.profile.firstName,
                    lastName: result.profile.lastName,
                    phone: result.profile.phone,
                    phoneExtension: result.profile.phoneExtension,
                    name,
                  }
                : manager,
          );
          app.state.sites = app.state.sites.map((site) =>
            site.oversight?.cityProgramManagerId === managerId
              ? {
                  ...site,
                  oversight: { ...site.oversight, cityProgramManager: name },
                }
              : site,
          );
        }
        app.state.profileMessage = "";
        if (profileForm.isConnected) {
          const draft = app.state.complianceProfileDraft;
          if (
            draft?.phase === "profile" &&
            result.profile.firstName?.trim() &&
            result.profile.lastName?.trim() &&
            result.profile.phone?.trim()
          ) {
            syncDirtyForm(profileForm, true);
            navigate(
              `/sites/${encodeURIComponent(draft.siteId)}?section=compliance`,
            );
          } else {
            app.render();
            app.querySelector("h1")?.focus();
          }
        }
      } catch (error) {
        feedback.failure(error);
        if (profileForm.isConnected)
          showFormSaveError(
            profileForm,
            t(
              error instanceof Error && error.message === "valid_phone_required"
                ? "admin.profile.invalidPhone"
                : "admin.profile.saveError",
            ),
          );
      } finally {
        delete profileForm.dataset.saving;
        if (profileForm.isConnected) sync();
      }
    });
  }
}
