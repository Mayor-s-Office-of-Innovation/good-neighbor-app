// Program actions, mixed into the Program page element so tests can mount it alone.
import { DIRECTORY_REQUEST_CONCURRENCY } from "../../manager-directory.js";
import { actionFeedback } from "../../action-feedback.js";
import { adminApi } from "../../services/admin-api.js";
import { adminErrorMessage } from "../../admin-error-messages.js";
import { navigate } from "../../router.js";
import {
  formValue,
  showFormSaveError,
  syncDirtyForm,
} from "../../form-state.js";
import { loadProgramStaff } from "./program-staff.js";
import { t } from "../../../../frontend/src/i18n/i18n.js";

export const programActions = {
  async refreshProgramStaff(programId) {
    const visit = this.visit;
    const result = await adminApi.getProgram(programId);
    if (visit !== this.visit || this.state.program?.programId !== programId)
      return;
    const previous = this.state.program.users || [];
    this.state.program = {
      ...result.program,
      sites: result.sites,
      users: (result.users || []).map((user) => ({
        ...previous.find((p) => p.userId === user.userId),
        ...user,
      })),
    };
    this.render();
  },
  /**
   * Read the Program and its staff; false when open() or leave() ran again first.
   * @param {string} programId
   * @returns {Promise<boolean>}
   */
  async loadProgram(programId) {
    const visit = this.visit;
    const data = await adminApi.getProgram(programId);
    const program = {
      ...data.program,
      sites: data.sites,
      users: await loadProgramStaff(
        { ...data.program, sites: data.sites, users: data.users },
        adminApi,
        DIRECTORY_REQUEST_CONCURRENCY,
      ),
    };
    if (visit !== this.visit) return false;
    this.state.program = program;
    return true;
  },
  /** ?addStaff=1 comes from links that send the user here to add staff. */
  focusProgram() {
    queueMicrotask(() => {
      if (
        new URLSearchParams(location.search).get("addStaff") === "1" &&
        this.session.capabilities.createEntities === true
      ) {
        this.querySelector("#add-program-staff-dialog")?.showModal();
        const params = new URLSearchParams(location.search);
        params.delete("addStaff");
        history.replaceState(
          {},
          "",
          `${location.pathname}${params.size ? `?${params}` : ""}`,
        );
      } else this.querySelector("h1")?.focus();
    });
  },
  async saveProgramStaff(form) {
    const feedback = actionFeedback("admin.toast.staffSaved");
    try {
      if (form.dataset.saving) return;
      const userId = form.dataset.programStaffEditForm;
      const user = this.state.program.users.find(
        (item) => item.userId === userId,
      );
      if (!user) return;
      form.dataset.saving = "true";
      const button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      const data = new FormData(form);
      try {
        await adminApi.updateProgramUser(this.state.program.programId, userId, {
          firstName: formValue(data, "staff-first-name"),
          lastName: formValue(data, "staff-last-name"),
          phone: formValue(data, "staff-phone"),
          phoneExtension: formValue(data, "staff-extension"),
          email:
            this.session.capabilities.createEntities === true
              ? formValue(data, "staff-email")
              : user.email,
          siteManager: user.siteManager === true,
          ...(this.session.capabilities.createEntities === true
            ? { isPrimaryContact: data.has("staff-primary-contact") }
            : {}),
        });
      } catch (error) {
        feedback.failure(error);
        showFormSaveError(form, t("admin.programs.staffEditError"));
        delete form.dataset.saving;
        button.disabled = false;
        return;
      }
      feedback.success();
      form.closest("dialog")?.close();
      this.catalog.invalidate("managers");
      try {
        await this.refreshProgramStaff(this.state.program.programId);
        this.querySelector(
          `[data-edit-program-staff="${CSS.escape(userId)}"]`,
        )?.focus();
      } catch (error) {
        feedback.failure(error);
        this.reportError(error);
      }
    } catch (error) {
      feedback.failure(error);
      throw error;
    }
  },
  async addProgramStaff(form) {
    const feedback = actionFeedback("admin.toast.staffAdded");
    try {
      if (form.dataset.saving) return;
      form.dataset.saving = "true";
      const submit = form.querySelector('button[type="submit"]');
      if (submit) submit.disabled = true;
      const data = new FormData(form);
      const programId = this.state.program.programId;
      try {
        await adminApi.createProgramUser(programId, {
          firstName: formValue(data, "staff-first-name"),
          lastName: formValue(data, "staff-last-name"),
          phone: formValue(data, "staff-phone"),
          phoneExtension: formValue(data, "staff-extension"),
          email: formValue(data, "staff-email"),
          siteManager: false,
        });
        feedback.success();
        this.catalog.invalidate("managers");
      } catch (error) {
        feedback.failure(error);
        showFormSaveError(
          form,
          adminErrorMessage(error, t, t("admin.programs.staffSaveError")),
        );
        delete form.dataset.saving;
        if (submit) submit.disabled = false;
        return;
      }
      this.querySelector("#add-program-staff-dialog")?.close();
      await this.refreshProgramStaff(programId);
      this.querySelector("#add-program-staff")?.focus();
    } catch (error) {
      feedback.failure(error);
      throw error;
    }
  },

  async updateProgramDetails(form) {
    const program = this.state.program;
    if (!program || !this.session.capabilities.createEntities) return false;
    const feedback = actionFeedback("admin.programs.saved");
    try {
      const result = await adminApi.updateProgram(program.programId, {
        name: formValue(new FormData(form), "program-name"),
        expectedUpdatedAt: program.updatedAt || "",
      });
      this.catalog.addProgram(result.program);
      this.catalog.invalidate("managers");
      if (this.state.program?.programId === program.programId) {
        this.state.program = { ...program, ...result.program };
        syncDirtyForm(form, true);
        this.render();
      }
      feedback.success();
      return true;
    } catch (error) {
      feedback.failure(error);
      throw error;
    }
  },

  async createProgram(form) {
    const feedback = actionFeedback("admin.toast.programCreated");
    try {
      const visit = this.visit;
      const data = new FormData(form);
      const result = await adminApi.createProgram({
        name: String(data.get("program-name") || ""),
        providerId: String(data.get("program-provider") || ""),
      });
      feedback.success();
      this.catalog.addProgram(result.program);
      this.catalog.invalidate("managers");
      if (visit !== this.visit) return;
      const returnTo = new URLSearchParams(window.location.search).get(
        "returnTo",
      );
      if (returnTo === "site-new") {
        navigate(
          `/sites/new?providerId=${encodeURIComponent(result.program.providerId)}&programId=${encodeURIComponent(result.program.programId)}`,
        );
        return;
      }
      if (returnTo === "provider") {
        navigate(`/providers/${encodeURIComponent(result.program.providerId)}`);
        return;
      }
      navigate(`/programs/${encodeURIComponent(result.program.programId)}`);
    } catch (error) {
      feedback.failure(error);
      throw error;
    }
  },
};
