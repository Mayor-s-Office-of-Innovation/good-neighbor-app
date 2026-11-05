// Admin user and My profile actions, mixed into <admin-users-page> so tests can mount it alone.
import { actionFeedback } from "../../action-feedback.js";
import { adminApi } from "../../services/admin-api.js";
import { profilePhoneUpdate } from "../../admin-save-state.js";
import { asForm, dataAttr } from "../../dom.js";
import {
  formValue,
  showFormSaveError,
  syncDirtyForm,
} from "../../form-state.js";
import { currentRoute, navigate } from "../../router.js";
import { t } from "../../../../frontend/src/i18n/i18n.js";
import { upsertRecord } from "../../save-feedback.js";

export const adminUserActions = {
  async inviteAdministrator(form) {
    const feedback = actionFeedback("admin.toast.invitationSent");
    const visit = this.visit;
    try {
      const data = new FormData(form);
      const values = Object.fromEntries(
        [
          "firstName",
          "lastName",
          "email",
          "phone",
          "phoneExtension",
          "departmentId",
          "role",
        ].map((name) => [name, String(data.get(name) || "").trim()]),
      );
      const result = await adminApi.inviteAdminUser(values);
      this.catalog.invalidate("programManagers");
      this.state.adminUsers = upsertRecord(
        this.state.adminUsers,
        result.user,
        "username",
      );
      this.state.adminUserMessage = "";
      this.state.adminUserStatusFilter = "all";
      syncDirtyForm(form, true);
      delete form.dataset.saving;
      feedback.success(
        result.invitationStatus === "active"
          ? "admin.toast.accountActive"
          : "admin.toast.invitationSent",
      );
      if (visit !== this.visit) return;
      navigate("/administrators");
    } catch (error) {
      feedback.failure(error);
      throw error;
    }
  },
  /** Reread the list after a change, as a fresh visit would. */
  async reloadAdminUsers() {
    // <admin-app> reloads whatever route is now on screen, even if the user moved on.
    if (this.reopenRoute) return this.reopenRoute();
    if (!(await this.open(currentRoute()))) return;
    this.render();
    this.focusOnOpen();
  },
  /** @param {HTMLButtonElement} button */
  runAdminUserAction(button) {
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
    const visit = this.visit;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.textContent = "Working…";
    request
      .then(() => {
        this.catalog.invalidate("programManagers");
        feedback.success();
        this.state.adminUserMessage = "";
        // A reread after the user left would redraw the page they moved to.
        if (visit === this.visit) return this.reloadAdminUsers();
      })
      .catch((error) => {
        feedback.failure(error);
        this.reportError(error);
        // <admin-app> skips a redraw for a repeated error, so reset the button here.
        if (visit === this.visit) this.render();
      });
  },
  /** @param {HTMLElement & { value: string }} select */
  changeAdminRole(select) {
    const feedback = actionFeedback("admin.toast.roleUpdated");
    const visit = this.visit;
    adminApi
      .updateAdminUserRole(
        dataAttr(select, "data-username"),
        String(select.value),
      )
      .then(() => {
        feedback.success();
        if (visit === this.visit) return this.reloadAdminUsers();
      })
      .catch((error) => {
        feedback.failure(error);
        this.reportError(error);
        // Redrawn, so the select shows the saved role again, not the failed one.
        if (visit === this.visit) this.render();
      });
  },
  /** @param {HTMLFormElement} profileForm */
  async saveMyProfile(profileForm) {
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
          this.session.profile.phone,
        ),
      });
      feedback.success();
      this.session.setProfile(result.profile);
      const managerId = result.profile.directoryUserId;
      if (managerId) {
        const name = `${result.profile.firstName} ${result.profile.lastName}`;
        this.catalog.updateProgramManager(managerId, {
          firstName: result.profile.firstName,
          lastName: result.profile.lastName,
          phone: result.profile.phone,
          phoneExtension: result.profile.phoneExtension,
          name,
        });
        this.catalog.updateSites((site) =>
          site.oversight?.cityProgramManagerId === managerId
            ? {
                ...site,
                oversight: { ...site.oversight, cityProgramManager: name },
              }
            : site,
        );
      }
      this.state.profileMessage = "";
      if (profileForm.isConnected) {
        const draft = this.complianceDraft();
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
          this.render();
          this.querySelector("h1")?.focus();
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
      if (profileForm.isConnected) syncDirtyForm(profileForm);
    }
  },
};
