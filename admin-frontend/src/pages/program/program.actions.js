// main.js adds these to AdminApp, so they can use this.state and render().
import { DIRECTORY_REQUEST_CONCURRENCY } from "../../manager-directory.js";
import { actionFeedback } from "../../action-feedback.js";
import { adminApi } from "../../services/admin-api.js";
import { adminErrorMessage } from "../../admin-error-messages.js";
import { currentRoute, navigate } from "../../router.js";
import {
  formValue,
  showFormSaveError,
  syncDirtyForm,
} from "../../form-state.js";
import { loadProgramStaff } from "./program-staff.js";
import { t } from "../../../../frontend/src/i18n/i18n.js";
import { upsertRecord } from "../../save-feedback.js";

export const programActions = {
  async refreshProgramStaff(programId) {
    const result = await adminApi.getProgram(programId);
    if (
      this.state.program?.programId !== programId ||
      currentRoute().name !== "program"
    )
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
  async openProgram(programId, updateUrl = true) {
    if (updateUrl)
      return navigate(`/programs/${encodeURIComponent(programId)}`);
    const path = location.pathname + location.search;
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
    if (location.pathname + location.search !== path) return;
    this.state.program = program;
    this.state.provider = null;
    this.state.site = null;
    this.state.siteManager = null;
    this.render();
    queueMicrotask(() => {
      if (
        new URLSearchParams(location.search).get("addStaff") === "1" &&
        this.state.capabilities.createEntities === true
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
            this.state.capabilities.createEntities === true
              ? formValue(data, "staff-email")
              : user.email,
          siteManager: user.siteManager === true,
          ...(this.state.capabilities.createEntities === true
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
      this.state.managerDirectoryLoaded = false;
      this.managerDirectoryVersion = (this.managerDirectoryVersion || 0) + 1;
      try {
        await this.refreshProgramStaff(this.state.program.programId);
        this.querySelector(
          `[data-edit-program-staff="${CSS.escape(userId)}"]`,
        )?.focus();
      } catch (error) {
        feedback.failure(error);
        this.state.error = error.message;
        this.render();
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
        this.state.managerDirectoryLoaded = false;
        this.managerDirectoryVersion = (this.managerDirectoryVersion || 0) + 1;
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
    if (!program || !this.state.capabilities.createEntities) return false;
    const feedback = actionFeedback("admin.programs.saved");
    try {
      const result = await adminApi.updateProgram(program.programId, {
        name: formValue(new FormData(form), "program-name"),
        expectedUpdatedAt: program.updatedAt || "",
      });
      this.state.programs = upsertRecord(
        this.state.programs,
        result.program,
        "programId",
      );
      this.state.managerDirectoryLoaded = false;
      this.managerDirectoryVersion = (this.managerDirectoryVersion || 0) + 1;
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
      const origin = location.pathname + location.search;
      const data = new FormData(form);
      const result = await adminApi.createProgram({
        name: String(data.get("program-name") || ""),
        providerId: String(data.get("program-provider") || ""),
      });
      feedback.success();
      this.state.programs = upsertRecord(
        this.state.programs,
        result.program,
        "programId",
      );
      this.state.managerDirectoryLoaded = false;
      this.managerDirectoryVersion = (this.managerDirectoryVersion || 0) + 1;
      if (location.pathname + location.search !== origin) return;
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
