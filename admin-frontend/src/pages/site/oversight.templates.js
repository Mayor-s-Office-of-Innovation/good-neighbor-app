// HTML for the Site oversight tab. siteSectionView in record.templates.js draws
// it when the Oversight tab is open.
import { t } from "../../../../frontend/src/i18n/i18n.js";
import { escapeHtml } from "../../dom.js";
import { canEditSite } from "../../site-permissions.js";
import { uniqueNamedOptions } from "../shared.templates.js";
import { phoneInput, formInput } from "../../form-fields.js";

function oversightCreationDialogs(state) {
  const departments = uniqueNamedOptions(state.oversightOptions.departments);
  const assignedManagerIds = new Set(
    state.assignedComplianceManagers.map((manager) => manager.managerId),
  );
  const candidates = state.programManagers.filter(
    (manager) => !assignedManagerIds.has(manager.userId),
  );
  return `<dialog id="choose-compliance-manager-dialog" class="places-modal" aria-labelledby="choose-compliance-manager-title">
    <div class="places-modal__card compliance-manager-picker">
      <header class="compliance-manager-picker__header">
        <h2 id="choose-compliance-manager-title">${escapeHtml(t("admin.oversight.addCityProgramManager"))}</h2>
        <button class="btn-icon" type="button" data-close-dialog aria-label="Close add program manager dialog"><wa-icon name="xmark" aria-hidden="true"></wa-icon></button>
      </header>
      <wa-input id="compliance-manager-search" type="search" label="${escapeHtml(t("admin.oversight.searchExistingManagers"))}" placeholder="Search by name, email, or department" autocomplete="off" with-clear></wa-input>
      <p class="visually-hidden" aria-live="polite" data-manager-search-status>Search by name, email, or department to find a program manager.</p>
      <h3 class="compliance-manager-candidates__title" data-manager-results-heading hidden>Search results</h3>
      <ul class="compliance-manager-candidates">
        ${candidates.map((manager) => `<li hidden><button class="compliance-manager-candidate" type="button" data-select-compliance-manager data-manager-id="${escapeHtml(manager.userId)}" data-search-text="${escapeHtml([manager.name, manager.email, manager.departmentName].filter(Boolean).join(" ").toLocaleLowerCase("en-US"))}"><span><strong>${escapeHtml(manager.name)}</strong><span>${escapeHtml(manager.email || "No email")}</span></span><span class="compliance-manager-candidate__meta">${manager.departmentName ? `<span>${escapeHtml(manager.departmentName)}</span>` : ""}<span>${escapeHtml(programManagerAccountLabel(manager.accountStatus))}</span></span></button></li>`).join("")}
      </ul>
      <div class="places-modal__actions compliance-manager-picker__actions">
        <p>${escapeHtml(t("admin.oversight.inviteNewManagerAlternative"))}</p>
        <button class="btn-primary" id="invite-new-compliance-manager" type="button">Invite new program manager</button>
      </div>
    </div>
  </dialog>
  <dialog id="new-city-program-manager-dialog" class="places-modal" aria-labelledby="new-city-program-manager-title">
    <form id="new-city-program-manager-form" class="places-modal__card site-details-form">
      <h2 id="new-city-program-manager-title">Invite new program manager</h2>
      <p class="muted">This creates the manager's directory profile, sends them an invite to join the app, and selects them for this site.</p>
      <div class="form-grid form-grid--two">
        ${formInput("manager-first-name", "First name", "", { required: true, autocomplete: "given-name" })}
        ${formInput("manager-last-name", "Last name", "", { required: true, autocomplete: "family-name" })}
      </div>
      ${formInput("manager-email", "CCSF email", "", { required: true, type: "email", autocomplete: "email" })}
      ${phoneInput("manager-phone", "Phone", "", { required: true, type: "tel", autocomplete: "tel", pattern: "(?:\\+?1[ .-]?)?\\(?[0-9]{3}\\)?[ .-]?[0-9]{3}[ .-]?[0-9]{4}" })}
      <wa-select name="manager-department" label="Department" required placeholder="Choose department">
        ${departments.map((item) => `<wa-option value="${escapeHtml(item.departmentId || item.name)}">${escapeHtml(item.name)}</wa-option>`).join("")}
        <wa-option value="__add_department__" data-add-option>${escapeHtml(t("admin.oversight.addDepartment"))}</wa-option>
      </wa-select>
      <div class="places-modal__actions">
        <button class="btn-primary" type="submit" data-save-button>Send invitation</button>
        <button class="btn-outline" type="button" data-close-dialog>${escapeHtml(t("common.cancel"))}</button>
      </div>
    </form>
  </dialog>
  <dialog id="new-oversight-option-dialog" class="places-modal" aria-labelledby="new-oversight-option-title">
    <form id="new-oversight-option-form" class="places-modal__card site-details-form">
      <h2 id="new-oversight-option-title" data-option-title>Add a new oversight option</h2>
      <input type="hidden" name="option-type" />
      <wa-input name="option-name" label="Name" required autocomplete="organization" data-option-input></wa-input>
      <div class="places-modal__actions">
        <button class="btn-primary" type="submit" data-save-button>Add</button>
        <button class="btn-outline" type="button" data-close-dialog>${escapeHtml(t("common.cancel"))}</button>
      </div>
    </form>
  </dialog>`;
}

export function programManagerAccountLabel(status) {
  const key = {
    invited: "admin.users.statusInvited",
    active: "admin.users.statusActive",
    suspended: "admin.users.statusSuspended",
  }[status];
  return key ? t(key) : "";
}

export function complianceManagerAssignmentRow(manager, canManageAssignments) {
  const managerId = String(manager.userId || manager.managerId || "");
  const profile = manager.manager || manager;
  const name = profile.name || manager.name || "Program manager";
  const email = profile.email || manager.email || "";
  const department = profile.departmentName || manager.departmentName || "";
  const accountStatus = profile.accountStatus || manager.accountStatus || "";
  const statusLabel = programManagerAccountLabel(accountStatus);
  return `<li class="compliance-manager-assignment" data-manager-id="${escapeHtml(managerId)}">
    <input type="hidden" name="compliance-manager-id" value="${escapeHtml(managerId)}" />
    <span class="compliance-manager-assignment__identity"><strong>${escapeHtml(name)}</strong>${email ? `<span>${escapeHtml(email)}</span>` : ""}${department ? `<span>${escapeHtml(department)}</span>` : ""}${accountStatus === "not-invited" ? `<span class="compliance-manager-assignment__warning">${escapeHtml(t("admin.oversight.invitationNeeded", { name }))}</span>${canManageAssignments ? `<button class="btn-text" type="button" data-invite-compliance-manager data-manager-id="${escapeHtml(managerId)}">Send invite</button>` : ""}` : statusLabel ? `<span class="muted">${escapeHtml(statusLabel)}</span>` : ""}</span>
    ${canManageAssignments ? `<button class="btn-danger" type="button" data-remove-compliance-manager aria-label="${escapeHtml(t("admin.oversight.removeNamed", { name }))}">${escapeHtml(t("admin.oversight.remove"))}</button>` : ""}
  </li>`;
}

export function siteOversightView(state) {
  const oversight = state.site?.oversight || {};
  const department = oversight.managingCityDepartment || "";
  const managers = state.programManagers || [];
  const assignedManagerIds = new Set(
    state.assignedComplianceManagers.map((manager) => manager.managerId),
  );
  const canManageAssignments = state.capabilities.createEntities === true;
  const departments = uniqueNamedOptions([
    ...state.oversightOptions.departments,
    ...(department ? [{ name: department }] : []),
  ]);
  const systemsOfCare = uniqueNamedOptions([
    ...state.oversightOptions.systemsOfCare,
    { name: "BHS-PBH" },
    ...(oversight.managingSystemOfCare
      ? [{ name: oversight.managingSystemOfCare }]
      : []),
  ]);
  return `<form id="site-oversight-form" class="site-details-form" data-read-only="${!canEditSite(state)}" data-dirty-form>
    <fieldset aria-labelledby="city-program-managers-title"><div class="form-grid form-grid--one">
      <fieldset class="compliance-manager-assignments"><legend><h2 id="city-program-managers-title">${escapeHtml(t("admin.oversight.cityProgramManagers"))}</h2></legend>
        <ul class="compliance-manager-assignment-list" data-compliance-manager-list>
          ${managers
            .filter((manager) => assignedManagerIds.has(manager.userId))
            .map((manager) =>
              complianceManagerAssignmentRow(manager, canManageAssignments),
            )
            .join("")}
        </ul>
        ${assignedManagerIds.size ? "" : '<p class="empty-state" data-no-compliance-managers>No program managers assigned.</p>'}
        ${canManageAssignments ? `<button class="btn-secondary" id="add-compliance-manager" type="button" aria-describedby="compliance-manager-limit">${escapeHtml(t("admin.oversight.assignCityProgramManager"))}</button><p id="compliance-manager-limit" class="muted" data-compliance-manager-limit hidden>${escapeHtml(t("admin.oversight.managerLimit"))}</p>` : ""}
      </fieldset>
      <wa-select name="managing-city-department" label="Managing City department" placeholder="Choose department">
        ${departments.map((item) => `<wa-option value="${escapeHtml(item.name)}" ${department === item.name ? "selected" : ""}>${escapeHtml(item.name)}</wa-option>`).join("")}
        <wa-option value="__add_department__" data-add-option>Add a new City department…</wa-option>
      </wa-select>
      <wa-select name="managing-system-of-care" label="Managing system of care" placeholder="Choose system of care">
        ${systemsOfCare.map((item) => `<wa-option value="${escapeHtml(item.name)}" ${oversight.managingSystemOfCare === item.name ? "selected" : ""}>${escapeHtml(item.name)}</wa-option>`).join("")}
        <wa-option value="__add_system__" data-add-option>Add a new system of care…</wa-option>
      </wa-select>
    </div></fieldset>
    ${state.siteSaveError ? `<p class="error" role="alert">${escapeHtml(state.siteSaveError)}</p>` : ""}
    <button class="btn-primary" type="submit" data-save-button disabled>Save changes</button>
  </form>
  ${oversightCreationDialogs(state)}`;
}
