// main.js adds these to AdminApp, so they can use this.state and render().
import { adminCatalog } from "../../admin-catalog.js";
import { actionFeedback } from "../../action-feedback.js";
import { adminApi } from "../../services/admin-api.js";
import { navigate } from "../../router.js";
import { syncDirtyForm } from "../../form-state.js";
import { upsertRecord } from "../../save-feedback.js";

export const adminUserActions = {
  async inviteAdministrator(form) {
    const feedback = actionFeedback("admin.toast.invitationSent");
    const origin = location.pathname + location.search;
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
      adminCatalog.invalidate("programManagers");
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
      if (location.pathname + location.search !== origin) return;
      navigate("/administrators");
    } catch (error) {
      feedback.failure(error);
      throw error;
    }
  },
};
