import { t } from "../../../../frontend/src/i18n/i18n.js";
import { escapeHtml } from "../../dom.js";
import {
  discardChangesDialog,
  uniqueNamedOptions,
} from "../shared.templates.js";
import { phoneInput, formInput } from "../../form-fields.js";

/**
 * @typedef {import("../../admin-types.js").AdminState} AdminState
 */

/** @param {AdminState} state */
export function myProfileView(state) {
  const profile = state.profile;
  if (!profile) return "";
  const sites = state.sites.filter(
    (site) =>
      site.status !== "inactive" &&
      (site.complianceManagerIds || []).includes(profile.directoryUserId),
  );
  return `<section class="site-page" aria-labelledby="profile-title">
    <a class="site-back-link" href="/sites" data-route><wa-icon name="chevron-left" aria-hidden="true"></wa-icon> ${escapeHtml(t("admin.profile.back"))}</a>
    <h1 id="profile-title" tabindex="-1">${escapeHtml(t("admin.profile.title"))}</h1>
    <p>${escapeHtml(t(profile.role === "compliance-supervisor" ? "admin.profile.supervisor" : "admin.profile.manager"))}</p>
    <form id="my-profile-form" class="site-details-form" data-dirty-form>
      ${formInput("firstName", t("siteAdmin.field.firstName"), profile.firstName, { required: true, maxlength: 100, autocomplete: "given-name" })}
      ${formInput("lastName", t("siteAdmin.field.lastName"), profile.lastName, { required: true, maxlength: 100, autocomplete: "family-name" })}
      ${phoneInput("phone", t("siteAdmin.field.phone"), profile.phone, { extension: profile.phoneExtension, required: Boolean(profile.phone) || Boolean(state.complianceProfileDraft), type: "tel", autocomplete: "tel" })}
      <dl class="profile-email">
        <dt>${escapeHtml(t("siteAdmin.field.email"))}</dt>
        <dd>${escapeHtml(profile.email)}</dd>
      </dl>
      <button class="btn-primary" type="submit" data-save-button disabled>${escapeHtml(t("common.save"))}</button>
    </form>
    ${state.profileMessage ? `<p id="profile-message" class="success" role="status" tabindex="-1">${escapeHtml(state.profileMessage)}</p>` : ""}
    ${profile.role === "compliance-manager" ? `<section class="subsection"><h2>${escapeHtml(t("admin.profile.sites"))}</h2>${sites.length ? `<ul class="site-directory-list">${sites.map((site) => `<li><a class="site-directory-row" href="/sites/${encodeURIComponent(site.siteId)}" data-route>${escapeHtml(site.name || site.siteName || site.siteId)}</a></li>`).join("")}</ul>` : `<p class="empty-state">${escapeHtml(t("admin.profile.noSites"))}</p>`}</section>` : ""}
    ${discardChangesDialog()}
  </section>`;
}

export function adminSettingsMenu(canManageUsers, canImportSites) {
  return `<div class="admin-settings-wrap">
    <button class="admin-settings" type="button" popovertarget="admin-settings-menu" aria-label="Settings" aria-haspopup="menu">
      <wa-icon name="gear" aria-hidden="true"></wa-icon>
    </button>
    <div class="admin-settings-menu" id="admin-settings-menu" popover role="menu" aria-label="Settings">
      <a href="/profile" data-route role="menuitem"><wa-icon name="user" aria-hidden="true"></wa-icon><span>${escapeHtml(t("admin.profile.title"))}</span></a>
      ${canManageUsers ? '<a href="/administrators" data-route role="menuitem"><wa-icon name="people-group" aria-hidden="true"></wa-icon><span>User management</span></a>' : ""}
      ${canImportSites ? '<a href="/sites/import" data-route role="menuitem"><wa-icon name="file-import" aria-hidden="true"></wa-icon><span>Import</span></a>' : ""}
      ${canManageUsers ? `<a href="/system-status" data-route role="menuitem"><wa-icon name="heart-pulse" aria-hidden="true"></wa-icon><span>${escapeHtml(t("admin.status.menu"))}</span></a>` : ""}
      <button id="clear-token" type="button" role="menuitem"><wa-icon name="arrow-right-from-bracket" aria-hidden="true"></wa-icon><span>Sign out</span></button>
    </div>
  </div>`;
}

export function administratorView(users, state) {
  const statusFilter = state.adminUserStatusFilter || "all";
  const message = state.adminUserMessage || "";
  const directoryMode = state.adminUserDirectoryMode || "cognito";
  const filteredUsers = users.filter(
    (user) =>
      statusFilter === "all" || adminUserLifecycleStatus(user) === statusFilter,
  );
  return `<section class="panel" aria-labelledby="administrators-title">
    <a class="site-back-link" href="/sites" data-route><wa-icon name="chevron-left" aria-hidden="true"></wa-icon> ${escapeHtml(t("admin.breadcrumb.admin"))}</a>
    <div class="panel__head"><div><h1 id="administrators-title" tabindex="-1">Manage users</h1><p class="muted">Invite, suspend, reinstate, or manage user access.</p></div><button class="btn-primary" type="button" data-navigate="/administrators/new">${escapeHtml(t("admin.users.add"))}</button></div>
    ${directoryMode === "local" ? '<p class="admin-local-directory" role="note"><strong>Local test directory.</strong> Changes reset when the backend restarts, and no emails are sent.</p>' : ""}
    ${message ? `<p class="success admin-user-toast" role="status">${escapeHtml(message)}</p>` : ""}
    <div class="admin-user-filter">
      <wa-select id="admin-user-status-filter" label="Filter by status" value="${escapeHtml(statusFilter)}">
        <wa-option value="all">All statuses</wa-option>
        <wa-option value="active">Active</wa-option>
        <wa-option value="invited">Invited</wa-option>
        <wa-option value="suspended">Suspended</wa-option>
      </wa-select>
    </div>
    <div class="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Action</th></tr></thead><tbody>
      ${filteredUsers.map(adminUserRow).join("")}
    </tbody></table></div>
    ${filteredUsers.length ? "" : '<p class="empty-state">No administrators match this status.</p>'}
    ${adminRoleHelpDialog()}
  </section>`;
}

export function newAdministratorView(state) {
  const departments = uniqueNamedOptions(state.oversightOptions.departments);
  return `<section class="creation-page" aria-labelledby="new-admin-user-title">
    <a class="site-back-link btn-icon" href="/administrators" data-route aria-label="${escapeHtml(t("common.back"))}"><wa-icon name="chevron-left" aria-hidden="true"></wa-icon></a>
    <h1 id="new-admin-user-title" tabindex="-1">${escapeHtml(t("admin.users.add"))}</h1>
    <p class="muted">${escapeHtml(t("admin.users.help"))}</p>
    <form id="admin-user-form" class="site-details-form" data-dirty-form novalidate>
      <fieldset><legend>${escapeHtml(t("admin.users.invite"))}</legend>
        <div class="form-grid">
          <wa-input name="email" type="email" label="${escapeHtml(t("admin.users.email"))}" autocomplete="email" required aria-describedby="invitation-lookup-status"></wa-input>
          <p id="invitation-lookup-status" data-invitation-lookup-status role="status" aria-live="polite"></p>
          <wa-input name="firstName" label="${escapeHtml(t("admin.programs.firstName"))}" required></wa-input>
          <wa-input name="lastName" label="${escapeHtml(t("admin.programs.lastName"))}" required></wa-input>
          ${phoneInput("phone", t("siteAdmin.field.phone"), "", { required: true, type: "tel", autocomplete: "tel" })}
          <wa-select name="departmentId" label="${escapeHtml(t("admin.users.department"))}" placeholder="${escapeHtml(t("admin.users.chooseDepartment"))}">
            ${departments.map((item) => `<wa-option value="${escapeHtml(item.departmentId || item.name)}">${escapeHtml(item.name)}</wa-option>`).join("")}
          </wa-select>
          <div class="admin-role-label">
            <wa-select name="role" label="${escapeHtml(t("admin.users.role"))}" value="compliance-manager">
              <wa-option value="compliance-manager">${escapeHtml(t("admin.profile.manager"))}</wa-option>
              <wa-option value="compliance-supervisor">${escapeHtml(t("admin.profile.supervisor"))}</wa-option>
            </wa-select>
            <button class="btn-icon" id="show-admin-role-help" type="button" aria-label="${escapeHtml(t("admin.users.roleHelp"))}"><wa-icon name="circle-info" aria-hidden="true"></wa-icon></button>
          </div>
        </div>
        <div class="admin-invite-actions">
          <button class="btn-primary" type="submit">${escapeHtml(t("admin.users.send"))}</button>
          <button class="btn-secondary" type="button" data-save-cancel data-navigate="/administrators">${escapeHtml(t("common.cancel"))}</button>
        </div>
      </fieldset>
    </form>
    ${adminRoleHelpDialog()}
    ${discardChangesDialog()}
  </section>`;
}

export function adminInvitationError(error) {
  const key = {
    valid_email_required: "admin.users.invalidEmail",
    name_required: "admin.users.nameRequired",
    valid_phone_required: "admin.profile.invalidPhone",
    invalid_role: "admin.users.invalidRole",
    admin_user_exists: "admin.users.exists",
    compliance_profile_conflict: "admin.users.profileConflict",
  }[error?.message];
  return t(key || "admin.users.failed");
}

function adminUserRow(user) {
  const status = adminUserLifecycleStatus(user);
  const statusLabel =
    { active: "Active", invited: "Invited", suspended: "Suspended" }[status] ||
    status;
  const username = escapeHtml(user.username);
  const actions =
    status === "suspended"
      ? `<button class="btn-secondary" type="button" data-admin-user-action="reinstate" data-username="${username}">Reinstate</button>`
      : `${
          status === "invited"
            ? `<button class="btn-secondary" type="button" data-admin-user-action="reinvite" data-username="${username}">Re-invite</button>`
            : user.canResetPassword
              ? `<button class="btn-secondary" type="button" data-admin-user-action="reset" data-username="${username}">Reset password</button>`
              : ""
        }<button class="btn-danger" type="button" data-admin-user-action="suspend" data-username="${username}">Suspend</button>`;
  return `<tr><td>${escapeHtml(user.name || "—")}</td><td>${escapeHtml(user.email)}</td><td class="admin-user-role"><wa-select aria-label="Role for ${escapeHtml(user.email)}" data-admin-role data-username="${username}" value="${escapeHtml(user.role)}"><wa-option value="compliance-manager">Manager</wa-option><wa-option value="compliance-supervisor">Supervisor</wa-option></wa-select></td><td>${escapeHtml(statusLabel)}</td><td><div class="admin-user-actions">${actions}</div></td></tr>`;
}

function adminRoleHelpDialog() {
  return `<dialog id="admin-role-help-dialog" class="places-modal" aria-labelledby="admin-role-help-title">
    <form class="places-modal__card" method="dialog">
      <div class="places-modal__copy">
        <h2 class="places-modal__title" id="admin-role-help-title">User roles</h2>
        <div class="admin-role-help-copy">
          <section>
            <h3>Manager</h3>
            <p>Managers can update existing providers, programs, sites, contacts, setup codes, and device access. They can generate compliance letters, enroll devices, and revoke device access.</p>
          </section>
          <section>
            <h3>Supervisor</h3>
            <p>Supervisors can do everything a Manager can. They can also manage users, create and deactivate records, run bulk imports, and change a site's Site manager or lead program.</p>
          </section>
        </div>
      </div>
      <div class="places-modal__actions">
        <button class="btn-primary" value="close">Close</button>
      </div>
    </form>
  </dialog>`;
}

function adminUserLifecycleStatus(user) {
  if (user.lifecycleStatus) return user.lifecycleStatus;
  if (user.enabled === false) return "suspended";
  return user.status === "FORCE_CHANGE_PASSWORD" ? "invited" : "active";
}
