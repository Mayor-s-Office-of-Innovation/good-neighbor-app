// main.js adds these to AdminApp, so they can use this.state and render().
import { actionFeedback } from "../../action-feedback.js";
import { adminApi } from "../../services/admin-api.js";
import {
  complianceManagerAssignmentRow,
  programManagerAccountLabel,
} from "./oversight.templates.js";
import {
  controlValue,
  formValue,
  setSelectValue,
  showFormSaveError,
  syncDirtyForm,
} from "../../form-state.js";
import { bindComplianceManagerAssignmentControls } from "./oversight.bindings.js";
import { siteSaveErrorMessage } from "./save-error-messages.js";

export const siteOversightActions = {
  /** @param {HTMLFormElement} form */

  async createCityProgramManager(form) {
    const feedback = actionFeedback("admin.toast.invitationSent");
    try {
      const data = new FormData(form);
      const email = formValue(data, "manager-email").toLowerCase();
      const departmentId = controlValue(form, "manager-department");
      const department = this.state.oversightOptions.departments.find(
        (item) => (item.departmentId || item.name) === departmentId,
      );
      const invitation = await adminApi.inviteAdminUser({
        firstName: formValue(data, "manager-first-name"),
        lastName: formValue(data, "manager-last-name"),
        email,
        phone: formValue(data, "manager-phone"),
        phoneExtension: formValue(data, "manager-extension"),
        departmentId,
        departmentName: department?.name || "",
        role: "compliance-manager",
      });
      feedback.success(
        invitation.invitationStatus === "active"
          ? "admin.toast.accountActive"
          : "admin.toast.invitationSent",
      );
      const result = await adminApi.listCityProgramManagers();
      this.state.programManagers = result.programManagers || [];
      const manager = this.state.programManagers.find(
        (item) => String(item.email || "").toLowerCase() === email,
      );
      if (!manager) throw new Error("program_manager_directory_sync_failed");
      this.addComplianceManagerAssignment(manager);
      this.state.siteSaveMessage =
        invitation.invitationStatus === "active"
          ? "Existing account selected. Save changes to assign this manager."
          : invitation.invitationStatus === "resent"
            ? "Invitation re-sent. Save changes to assign this manager."
            : "Invitation sent. Save changes to assign this manager.";
      form.closest("dialog")?.close();
      form.reset();
    } catch (error) {
      feedback.failure(error);
      throw error;
    }
  },
  /** @param {any} manager */
  addComplianceManagerAssignment(manager) {
    const list = this.querySelector("[data-compliance-manager-list]");
    if (!list) return;
    const managerId = String(manager.userId || manager.managerId || "");
    if (
      !managerId ||
      list.querySelector(`[data-manager-id="${CSS.escape(managerId)}"]`)
    )
      return;
    if (list.querySelectorAll("li[data-manager-id]").length >= 2) {
      throw new Error("A site can have no more than two Program managers.");
    }
    list.insertAdjacentHTML(
      "beforeend",
      complianceManagerAssignmentRow(
        manager,
        this.state.capabilities.createEntities === true,
      ),
    );
    bindComplianceManagerAssignmentControls(this);
    const form = list.closest("form");
    if (form instanceof HTMLFormElement) syncDirtyForm(form);
    this.updateComplianceManagerCount();
  },
  /** @param {HTMLButtonElement} button */
  async inviteExistingComplianceManager(button) {
    const feedback = actionFeedback("admin.toast.invitationSent");
    try {
      const manager = this.state.programManagers.find(
        (item) => item.userId === button.dataset.managerId,
      );
      if (!manager) return;
      const originalLabel = button.textContent;
      button.disabled = true;
      button.textContent = "Sending…";
      const row = button.closest("[data-manager-id]");
      row?.querySelector("[data-invite-status]")?.remove();
      try {
        const invitation = await adminApi.inviteAdminUser({
          firstName: manager.firstName,
          lastName: manager.lastName,
          email: manager.email,
          phone: manager.phone,
          phoneExtension: manager.phoneExtension,
          departmentId: manager.departmentId,
          departmentName: manager.departmentName,
          role: "compliance-manager",
        });
        feedback.success(
          invitation.invitationStatus === "active"
            ? "admin.toast.accountActive"
            : "admin.toast.invitationSent",
        );
        manager.accountStatus = invitation.user.lifecycleStatus;
        row?.querySelector(".compliance-manager-assignment__warning")?.remove();
        const status = document.createElement("span");
        status.className = "muted";
        status.dataset.inviteStatus = "";
        status.setAttribute("role", "status");
        status.textContent = programManagerAccountLabel(manager.accountStatus);
        button.replaceWith(status);
      } catch (error) {
        feedback.failure(error);
        button.disabled = false;
        button.textContent = originalLabel;
        const status = document.createElement("span");
        status.className = "error";
        status.dataset.inviteStatus = "";
        status.setAttribute("role", "alert");
        status.textContent = siteSaveErrorMessage(error);
        button.after(status);
      }
    } catch (error) {
      feedback.failure(error);
      throw error;
    }
  },
  updateComplianceManagerCount() {
    const count = this.querySelectorAll(
      "[data-compliance-manager-list] > li[data-manager-id]",
    ).length;
    const addButton = this.querySelector("#add-compliance-manager");
    if (addButton) addButton.disabled = count >= 2;
    const limit = this.querySelector("[data-compliance-manager-limit]");
    if (limit) limit.hidden = count < 2;
    const empty = this.querySelector("[data-no-compliance-managers]");
    if (empty) empty.hidden = count > 0;
  },
  async createOversightOption(form) {
    const feedback = actionFeedback("admin.toast.optionCreated");
    try {
      const data = new FormData(form);
      const type = formValue(data, "option-type");
      const result = await adminApi.createOversightOption({
        type,
        name: formValue(data, "option-name"),
      });
      feedback.success();
      const key = type === "department" ? "departments" : "systemsOfCare";
      this.state.oversightOptions[key] = [
        ...this.state.oversightOptions[key],
        result.option,
      ].sort((a, b) => a.name.localeCompare(b.name));
      const target =
        form.dataset.targetSelect ||
        (type === "department"
          ? "managing-city-department"
          : "managing-system-of-care");
      await this.finishOversightOptionFlow(
        target,
        target === "manager-department"
          ? result.option.departmentId || result.option.name
          : result.option.name,
        form,
        result.option.name,
      );
    } catch (error) {
      feedback.failure(error);
      throw error;
    }
  },
  async finishOversightOptionFlow(selectName, value, form, label = value) {
    const select = this.querySelector(`wa-select[name='${selectName}']`);
    if (select) {
      const option = document.createElement("wa-option");
      option.value = value;
      option.textContent = label;
      select.querySelector(`[value='${CSS.escape(value)}']`)?.remove();
      const addOption = select.querySelector("[data-add-option]");
      if (addOption) addOption.before(option);
      else select.append(option);
      // wa-select caches its options until slotchange has been processed.
      // Yield a task so the new option is recognized before assigning value.
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (!select.isConnected) return;
      setSelectValue(select, value);
      await select.updateComplete;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
    form.closest("dialog")?.close();
    form.reset();
  },
  async updateOversight(form) {
    const feedback = actionFeedback("admin.toast.oversightSaved");
    try {
      if (!this.state.site) return false;
      const managerIds = [
        ...form.querySelectorAll("input[name='compliance-manager-id']"),
      ].map((input) => input.value);
      const oversight = {
        managingCityDepartment: controlValue(form, "managing-city-department"),
        managingSystemOfCare: controlValue(form, "managing-system-of-care"),
      };
      const currentManagerIds = this.state.assignedComplianceManagers
        .map((manager) => String(manager.managerId || manager.userId || ""))
        .filter(Boolean)
        .sort();
      const nextManagerIds = [...managerIds].sort();
      const assignmentsChanged =
        currentManagerIds.length !== nextManagerIds.length ||
        currentManagerIds.some(
          (managerId, index) => managerId !== nextManagerIds[index],
        );
      this.state.siteSaving = true;
      this.state.siteSaveMessage = "";
      this.state.siteSaveError = "";
      this.state.error = "";
      if (managerIds.length > 2) {
        this.state.siteSaveError =
          "A site can have no more than two Program managers.";
        showFormSaveError(form, this.state.siteSaveError);
        return false;
      }
      try {
        const result = await adminApi.updateSite(this.state.site.siteId, {
          name: this.state.site.name,
          oversight,
        });
        feedback.changed();
        if (
          this.state.capabilities.createEntities === true &&
          assignmentsChanged
        ) {
          const assignmentResult = await adminApi.replaceSiteComplianceManagers(
            this.state.site.siteId,
            managerIds,
          );
          this.state.assignedComplianceManagers =
            assignmentResult.assignments || [];
        }
        this.state.site = { ...this.state.site, ...result.site };
        this.state.sites = this.state.sites.map((site) =>
          site.siteId === this.state.site?.siteId
            ? { ...site, ...this.state.site }
            : site,
        );
        feedback.success();
        this.state.siteSaveMessage = "";
        return true;
      } catch (error) {
        feedback.failure(error);
        this.state.siteSaveError = siteSaveErrorMessage(error);
        return false;
      } finally {
        this.state.siteSaving = false;
        if (this.state.siteSaveError) {
          showFormSaveError(form, this.state.siteSaveError);
        } else {
          this.render();
        }
      }
    } catch (error) {
      feedback.failure(error);
      throw error;
    }
  },
};
