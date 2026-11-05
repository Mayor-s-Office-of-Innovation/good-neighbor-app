// HTML for the Site manager record and a Site's manager list. The Site record
// and Site access tab reuse siteManagersEditorView and managerMembershipList.
import { t } from "../../../../frontend/src/i18n/i18n.js";
import { escapeHtml } from "../../dom.js";
import { canEditSite, canEditSiteManager } from "../../site-permissions.js";
import {
  discardChangesDialog,
  entityBreadcrumb,
  phoneWithExtension,
} from "../shared.templates.js";
import { siteLabel } from "../directory/directory.templates.js";
import { phoneInput, formInput } from "../../form-fields.js";

/**
 * @typedef {import("../../main.js").AdminState} AdminState
 */

function managerProgramChangeDialog() {
  return `<dialog id="manager-program-change-dialog" class="places-modal" aria-labelledby="manager-program-change-title" aria-describedby="manager-program-change-copy">
    <form class="places-modal__card" method="dialog">
      <div class="places-modal__copy">
        <h2 class="places-modal__title" id="manager-program-change-title">Confirm move to a new program</h2>
        <p class="places-modal__text" id="manager-program-change-copy">This will remove the manager from any sites associated with the current program. They will immediately lose access to the Good Neighbor app for those sites.</p>
      </div>
      <div class="places-modal__actions">
        <button class="btn-danger" value="confirm">Confirm change</button>
        <button class="btn-outline" value="cancel">Cancel change</button>
      </div>
    </form>
  </dialog>`;
}

/** @param {string} managerName */
function removeSiteManagerDialog(managerName) {
  return `<dialog id="remove-site-manager-dialog" class="places-modal" aria-labelledby="remove-site-manager-title" aria-describedby="remove-site-manager-copy">
    <form class="places-modal__card" method="dialog">
      <div class="places-modal__copy">
        <h2 class="places-modal__title" id="remove-site-manager-title">Remove ${escapeHtml(managerName)}?</h2>
        <p class="places-modal__text" id="remove-site-manager-copy">This will permanently remove the manager, remove them from every assigned Site, and immediately revoke their Good Neighbor app access.</p>
      </div>
      <div class="places-modal__actions">
        <button class="btn-danger" value="confirm">${escapeHtml(t("admin.managers.deleteRecord"))}</button>
        <button class="btn-outline" value="cancel">Cancel</button>
      </div>
    </form>
  </dialog>`;
}

/** @param {AdminState} state */
export function siteManagersEditorView(state) {
  const availableManagers = state.availableSiteUsers.filter(
    (user) =>
      !state.managerMemberships.some(
        (member) =>
          (member.personId === user.personId && !!user.personId) ||
          member.userId === user.userId ||
          (!member.userId &&
            member.email?.toLowerCase() === user.email?.toLowerCase()),
      ),
  );
  const managerPrompt = t("admin.siteManagers.assignExisting");
  return `<section class="subsection" aria-labelledby="site-managers-title">
    <div class="panel__head"><h2 id="site-managers-title">${escapeHtml(t("admin.siteManagers.title"))}</h2>${canEditSite(state) ? `<button class="btn-secondary" id="create-site-manager" type="button">${escapeHtml(t("admin.siteManagers.createButton"))}</button>` : ""}</div>
    <p>${escapeHtml(t("admin.siteManagers.description"))}</p>
    ${managerMembershipList(state.managerMemberships, state.site.siteId, true, canEditSite(state))}
    ${
      canEditSite(state)
        ? `<form id="manager-membership-form" class="inline-form manager-membership-form">
      <div class="manager-assignment-search">
        <wa-input data-manager-search type="search" label="${escapeHtml(managerPrompt)}" placeholder="${escapeHtml(t("admin.siteManagers.searchPlaceholder"))}" autocomplete="off" with-clear></wa-input>
        <input type="hidden" name="manager-user-id" value="">
        <p class="muted" role="status" data-manager-search-status></p>
        <ul class="manager-search-results" data-manager-search-results hidden>
          ${availableManagers
            .map((user) => {
              const name =
                [user.firstName, user.lastName].filter(Boolean).join(" ") ||
                user.name ||
                user.email;
              return `<li hidden><button class="btn-outline" type="button" data-manager-option="${escapeHtml(user.userId)}" data-manager-search-text="${escapeHtml(`${name} ${user.email || ""}`.toLocaleLowerCase())}">${escapeHtml(name)} — ${escapeHtml(user.email || "")}</button></li>`;
            })
            .join("")}
        </ul>
      </div>
      <div class="manager-membership-actions" data-manager-membership-actions hidden>
        <button class="btn-primary" type="submit">${escapeHtml(t("admin.siteManagers.assignToSite"))}</button>
        <button class="btn-outline" type="button" data-cancel-manager-assignment>${escapeHtml(t("common.cancel"))}</button>
      </div>
    </form>`
        : ""
    }
    ${canEditSite(state) ? newSiteManagerDialog() : ""}

    ${removeManagerMembershipDialog(state.managerMembershipRemovalTarget, state.site.name)}
  </section>`;
}

function newSiteManagerDialog() {
  return `<dialog id="new-site-manager-dialog" class="places-modal" aria-labelledby="new-site-manager-title">
    <form id="new-site-manager-form" class="places-modal__card site-details-form">
      <h2 id="new-site-manager-title">${escapeHtml(t("admin.siteManagers.newTitle"))}</h2>
      ${formInput("new-manager-first-name", t("admin.programs.firstName"), "", { required: true, autocomplete: "given-name" })}
      ${formInput("new-manager-last-name", t("admin.programs.lastName"), "", { required: true, autocomplete: "family-name" })}
      ${phoneInput("new-manager-phone", t("admin.programs.phone"), "", { required: true, type: "tel", autocomplete: "tel" })}
      ${formInput("new-manager-email", t("admin.programs.email"), "", { required: true, type: "email", autocomplete: "email" })}
      <wa-checkbox name="email-enrollment-link">${escapeHtml(t("admin.enrollment.emailOnCreation"))}</wa-checkbox>
      <div class="places-modal__actions">
        <button class="btn-primary" type="submit">${escapeHtml(t("common.save"))}</button>
        <button class="btn-outline" type="button" data-cancel-new-site-manager>${escapeHtml(t("common.cancel"))}</button>
      </div>
    </form>
  </dialog>`;
}

/** @param {any[]} memberships @param {string} siteId @param {boolean} [editing] @param {boolean} [canManage] */
export function managerMembershipList(
  memberships,
  siteId,
  editing = false,
  canManage = false,
) {
  if (!memberships.length) {
    return `<p class="empty-state">${escapeHtml(t("admin.siteManagers.none"))}</p>`;
  }
  return `<ul class="contact-list">${memberships
    .map(
      (membership) => `<li>
        <div><strong>${escapeHtml(membership.name)}</strong><span><a href="mailto:${escapeHtml(membership.email)}">${escapeHtml(membership.email)}</a></span><span class="muted">Has ${escapeHtml(membership.activeBindingCount || 0)} active device${Number(membership.activeBindingCount || 0) === 1 ? "" : "s"} in use at this site</span></div>
        <div class="contact-list__actions">${
          editing
            ? `${(membership.personId || membership.userId) && canManage ? `<a class="btn-secondary" href="/managers/${encodeURIComponent(membership.personId || membership.userId)}?returnSite=${encodeURIComponent(siteId)}" data-route>${escapeHtml(t("common.edit"))}</a>` : ""}${canManage ? `<button class="btn-danger" type="button" data-remove-manager-membership="${escapeHtml(membership.membershipId)}">${escapeHtml(t("admin.siteManagers.remove"))}</button>` : ""}`
            : `<button class="btn-secondary" type="button" data-issue-manager-grant="${escapeHtml(membership.membershipId)}" data-delivery-mode="link">${escapeHtml(t("admin.enrollment.emailMagicLink"))}</button><button class="btn-secondary" type="button" data-issue-manager-grant="${escapeHtml(membership.membershipId)}" data-delivery-mode="code">${escapeHtml(t("admin.enrollment.emailOneTimeCode"))}</button><button class="btn-secondary" type="button" data-show-enrollment-code="${escapeHtml(membership.membershipId)}" data-enrollment-scope="site">${escapeHtml(t("admin.enrollment.showCode"))}</button>`
        }</div>
      </li>`,
    )
    .join("")}</ul>`;
}

/** @param {any | null} membership @param {string} siteName */
function removeManagerMembershipDialog(membership, siteName) {
  if (!membership) return "";
  const deviceCount = Number(membership.activeBindingCount || 0);
  return `<dialog id="remove-manager-membership-dialog" class="places-modal" aria-labelledby="remove-manager-membership-title" aria-describedby="remove-manager-membership-copy">
    <form class="places-modal__card" method="dialog">
      <div class="places-modal__copy">
        <h2 class="places-modal__title" id="remove-manager-membership-title">Remove ${escapeHtml(membership.name)} as site manager?</h2>
        <p class="places-modal__text" id="remove-manager-membership-copy">This will remove them from ${escapeHtml(siteName)} and immediately revoke access for ${escapeHtml(deviceCount)} active device${deviceCount === 1 ? "" : "s"} at this site. Their assignments at other sites will remain active.</p>
      </div>
      <div class="places-modal__actions">
        <button class="btn-danger" value="confirm">Remove site manager</button>
        <button class="btn-outline" value="cancel">Cancel</button>
      </div>
    </form>
  </dialog>`;
}

/** @param {AdminState} state @param {any | null} manager */
export function siteManagerEditorView(state, manager) {
  const isNew = !manager;
  const returnSite =
    new URLSearchParams(window.location.search).get("returnSite") || "";
  const canManageAssignments = state.capabilities.createEntities === true;
  const assignmentDisabled = canManageAssignments ? "" : "disabled";
  const programId = manager?.primaryProgramId ?? manager?.programId ?? "";
  const assigned = new Set(
    (manager?.assignedSites || []).map((site) => site.siteId),
  );
  const programs = state.programs
    .filter((program) => program.status !== "inactive")
    .sort((a, b) => a.name.localeCompare(b.name));
  const sites = state.sites
    .filter((site) => site.status !== "inactive")
    .sort((a, b) => siteLabel(a).localeCompare(siteLabel(b)));
  const title = isNew
    ? "Add new manager"
    : `${manager.firstName} ${manager.lastName}`.trim();
  return `<section class="site-page manager-record" aria-labelledby="manager-record-title">
    ${isNew ? `<a class="site-back-link" href="${returnSite ? `/sites/${encodeURIComponent(returnSite)}?section=details` : "/managers"}" data-route><wa-icon name="chevron-left" aria-hidden="true"></wa-icon> ${escapeHtml(t("common.back"))}</a>` : ""}
    ${entityBreadcrumb("manager", manager || {}, state.programs, state.providers)}
    <div class="panel__head">
      <h1 id="manager-record-title" tabindex="-1">${escapeHtml(title)}</h1>
      ${isNew || manager?.personId ? "" : `<button class="btn-danger" type="button" data-remove-site-manager>${escapeHtml(t("admin.managers.deleteRecord"))}</button>`}
    </div>
    <form id="site-manager-record-form" class="site-details-form" data-read-only="${!canEditSiteManager(state)}" data-dirty-form data-return-site="${escapeHtml(returnSite)}">
      <fieldset>
        <legend>Manager details</legend>
        <wa-select name="manager-program-id" label="${escapeHtml(t("admin.relationships.primaryProgram"))}" placeholder="${escapeHtml(t("admin.relationships.none"))}" ${assignmentDisabled}><wa-option value="" ${programId ? "" : "selected"}>${escapeHtml(t("admin.relationships.none"))}</wa-option>${programs.map((program) => `<wa-option value="${escapeHtml(program.programId)}" ${program.programId === programId ? "selected" : ""}>${escapeHtml(program.name)}</wa-option>`).join("")}</wa-select>
        <wa-select name="manager-provider-id" label="${escapeHtml(t("admin.relationships.primaryProvider"))}" ${assignmentDisabled}><wa-option value="" ${manager?.primaryProviderId ? "" : "selected"}>${escapeHtml(t("admin.relationships.none"))}</wa-option>${state.providers
          .filter((p) => p.status !== "inactive")
          .map(
            (p) =>
              `<wa-option value="${escapeHtml(p.providerId)}" ${p.providerId === manager?.primaryProviderId ? "selected" : ""}>${escapeHtml(p.name)}</wa-option>`,
          )
          .join("")}</wa-select>
        <p class="field-help">${escapeHtml(t("admin.relationships.affiliationHelp"))}</p>
        <div class="form-grid form-grid--one">
          ${formInput("manager-first-name", "First name", manager?.firstName || "", { required: true, autocomplete: "given-name" })}
          ${formInput("manager-last-name", "Last name", manager?.lastName || "", { required: true, autocomplete: "family-name" })}
          ${phoneInput("manager-phone", "Contact phone", manager?.phone || "", { extension: manager?.phoneExtension, extensionName: "manager-phone-extension", required: !manager || Boolean(manager.phone), type: "tel", autocomplete: "tel" })}
          ${formInput("manager-email", "Contact email", manager?.email || "", { required: true, type: "email", autocomplete: "email", disabled: !canManageAssignments })}
        </div>
      </fieldset>
      <fieldset>
        <legend>Assigned sites</legend>
        <p class="muted">${escapeHtml(t("admin.relationships.assignmentHelp"))}</p>
        <div class="manager-site-options">
          ${sites
            .map((site) => {
              const matches = true;
              return `<label class="manager-site-option" data-manager-site-program="${escapeHtml(site.leadProgramId || "")}" ${matches ? "" : "hidden"}><wa-checkbox name="manager-site-id" value="${escapeHtml(site.siteId)}" ${assigned.has(site.siteId) ? "checked" : ""} ${matches && canManageAssignments ? "" : "disabled"}>${escapeHtml(siteLabel(site))}</wa-checkbox></label>`;
            })
            .join("")}
          <p class="empty-state" data-manager-sites-empty ${sites.length ? "hidden" : ""}>${escapeHtml(t("admin.relationships.noSites"))}</p>
        </div>
      </fieldset>
      ${state.siteSaveMessage ? `<p class="success" role="status">${escapeHtml(state.siteSaveMessage)}</p>` : ""}
      <div class="row">
        <button class="btn-primary" type="submit" data-save-button disabled>${isNew ? "Add manager" : "Save changes"}</button>
        ${returnSite ? `<a class="btn-secondary" href="/sites/${encodeURIComponent(returnSite)}?section=details" data-route>${escapeHtml(t("common.cancel"))}</a>` : ""}
      </div>
    </form>
    ${
      isNew
        ? ""
        : `<section class="subsection" aria-labelledby="manager-device-revocation-title">
      <h2 id="manager-device-revocation-title">${escapeHtml(t("admin.devices.removeAllSites"))}</h2>
      <p>${escapeHtml(t("admin.devices.managerRevokeHelp"))}</p>
      <form id="revoke-manager-devices" class="inline-form destructive-confirmation">
        <wa-input name="confirmation" type="email" required autocomplete="off" label="${escapeHtml(t("admin.devices.confirmEmail", { email: manager.email }))}"></wa-input>
        <button class="btn-danger" type="submit" disabled>${escapeHtml(t("admin.devices.removeAllSites"))}</button>
        <p data-revocation-status role="status"></p>
      </form>
    </section>`
    }
    ${isNew ? "" : `${managerProgramChangeDialog()}${removeSiteManagerDialog(title)}`}
    ${discardChangesDialog()}
  </section>`;
}

export function siteManagerContactDetails(user) {
  if (!user) return "";
  return `<p class="muted">${escapeHtml(user.email || "No email")} · ${escapeHtml(phoneWithExtension(user) || "No phone")}</p>`;
}
