import { t } from "../../../../frontend/src/i18n/i18n.js";
import { primaryProgramStaffId } from "./program-staff.js";
import { escapeHtml } from "../../dom.js";
import {
  discardChangesDialog,
  entityBreadcrumb,
  phoneWithExtension,
} from "../shared.templates.js";
import { entityList, siteLabel } from "../directory/directory.templates.js";
import { phoneInput, formInput } from "../../form-fields.js";

export function newProgramView(state) {
  const params = new URLSearchParams(window.location.search);
  const inSiteFlow = params.get("returnTo") === "site-new";
  const inProviderFlow = params.get("returnTo") === "provider";
  const providerId = params.get("providerId") || "";
  return `<section class="creation-page" aria-labelledby="new-program-title">
    <a href="${inSiteFlow ? `/sites/new${providerId ? `?providerId=${encodeURIComponent(providerId)}` : ""}` : inProviderFlow && providerId ? `/providers/${encodeURIComponent(providerId)}` : "/programs"}" data-route class="site-back-link"><wa-icon name="chevron-left" aria-hidden="true"></wa-icon> ${inSiteFlow ? "Add new site" : inProviderFlow ? "Provider" : escapeHtml(t("admin.breadcrumb.admin"))}</a>
    <div><h1 id="new-program-title" tabindex="-1">${escapeHtml(t("admin.programs.createNew"))}</h1><p class="muted">${escapeHtml(t("admin.programs.createWithoutStaff"))}</p></div>
    <form id="program-form" class="site-details-form">
      ${formInput("program-name", t("admin.programs.name"), "", { required: true, autocomplete: "organization" })}
      <wa-select name="program-provider" label="${escapeHtml(t("admin.relationships.leadProvider"))}" required data-initial-value="${escapeHtml(providerId)}" placeholder="${escapeHtml(t("admin.programs.chooseProvider"))}">
        ${state.providers
          .filter((provider) => provider.status !== "inactive")
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(
            (provider) =>
              `<wa-option value="${escapeHtml(provider.providerId)}" ${provider.providerId === providerId ? "selected" : ""}>${escapeHtml(provider.name)}</wa-option>`,
          )
          .join("")}
      </wa-select>
      <button class="btn-primary" type="submit">${escapeHtml(t("admin.programs.createNew"))}</button>
    </form>
  </section>`;
}

/** @param {any} program */
export function programView(program, canAddStaff = false) {
  const primaryId = primaryProgramStaffId(program);
  const staff = (program.users || [])
    .filter((user) => user.status !== "inactive")
    .sort((a, b) =>
      `${a.firstName} ${a.lastName}`.localeCompare(
        `${b.firstName} ${b.lastName}`,
      ),
    );
  return `<section class="site-page">
    ${entityBreadcrumb("program", program)}
    <div class="panel__head">
      <div>
        <h1 tabindex="-1">${escapeHtml(program.name)}</h1>
      </div>
      ${program.needsReview ? '<span class="status-badge">Needs review</span>' : '<span class="status-badge">Active</span>'}
    </div>
    ${
      canAddStaff
        ? `<form id="program-details-form" class="site-details-form" data-dirty-form>
      ${formInput("program-name", t("admin.programs.name"), program.name, { required: true, autocomplete: "organization" })}
      <button class="btn-primary" type="submit" data-save-button disabled>${escapeHtml(t("common.save"))}</button>
    </form>${discardChangesDialog()}`
        : ""
    }
    <section aria-labelledby="program-sites-title">
      <h2 id="program-sites-title">Sites</h2>
      ${entityList(
        program.sites || [],
        (site) => `/sites/${encodeURIComponent(site.siteId)}`,
        (site) => site.siteName || site.name || site.siteId,
        (site) => site.status || "Active",
        "No sites are assigned to this program.",
      )}
    </section>
    <section class="subsection" aria-labelledby="program-staff-title">
      <div class="panel__head">
        <h2 id="program-staff-title">${escapeHtml(t("admin.programs.staff"))}</h2>
        ${canAddStaff ? `<button class="btn-primary" id="add-program-staff" type="button">${escapeHtml(t("admin.programs.addStaffMember"))}</button>` : ""}
      </div>
      ${
        staff.length
          ? `<ul class="site-directory-list">${staff
              .map(
                (
                  user,
                ) => `<li class="site-directory-row"><div class="site-directory-row__text">
        <span><strong>${escapeHtml(`${user.firstName || ""} ${user.lastName || ""}`.trim())}</strong>${user.userId === primaryId ? ` - <em>${escapeHtml(t("admin.programs.primaryContactInline"))}</em>` : ""}</span>
        <span>${escapeHtml(user.email || "")}</span>
        <span>${escapeHtml(phoneWithExtension(user))}</span>
        <span>${escapeHtml(t("admin.programs.assignedSites"))} ${user.assignedSites?.length ? user.assignedSites.map((site) => `<a href="/sites/${encodeURIComponent(site.siteId)}" data-route>${escapeHtml(siteLabel(site))}</a>`).join(", ") : escapeHtml(t(user.assignmentSitesUnavailable?.length ? "admin.programs.assignmentsUnavailable" : "admin.programs.noAssignedSites"))}${user.assignedSites?.length && user.assignmentSitesUnavailable?.length ? ` · ${escapeHtml(t("admin.programs.assignmentsUnavailable"))}` : ""}</span>
      </div><button class="btn-secondary" type="button" data-edit-program-staff="${escapeHtml(user.userId)}" aria-label="${escapeHtml(t("admin.programs.editStaffNamed", { name: `${user.firstName} ${user.lastName}` }))}">${escapeHtml(t("admin.programs.editStaff"))}</button></li>`,
              )
              .join("")}</ul>`
          : `<p class="empty-state">${escapeHtml(t("admin.programs.noStaff"))}</p>`
      }
    </section>
    ${canAddStaff ? programStaffDialog() : ""}
    ${staff.map((user) => programStaffEditDialog(user, user.userId === primaryId, canAddStaff)).join("")}
  </section>`;
}

function programStaffEditDialog(user, primary, canEditEmail = false) {
  return `<dialog id="edit-program-staff-${escapeHtml(user.userId)}" class="places-modal program-staff-edit-dialog" aria-labelledby="edit-staff-title-${escapeHtml(user.userId)}">
    <form data-program-staff-edit-form="${escapeHtml(user.userId)}" class="places-modal__card site-details-form">
      <h2 id="edit-staff-title-${escapeHtml(user.userId)}">${escapeHtml(t("admin.programs.editStaff"))}</h2>
      ${formInput("staff-first-name", t("admin.programs.firstName"), user.firstName, { required: true, autocomplete: "given-name" })}
      ${formInput("staff-last-name", t("admin.programs.lastName"), user.lastName, { required: true, autocomplete: "family-name" })}
      ${phoneInput("staff-phone", t("admin.programs.phone"), user.phone, { extension: user.phoneExtension, required: Boolean(user.phone), type: "tel", autocomplete: "tel" })}
      ${formInput("staff-email", t("admin.programs.email"), user.email, { required: true, type: "email", autocomplete: "email", disabled: !canEditEmail })}
      <wa-checkbox name="staff-primary-contact" ${canEditEmail ? "" : "disabled"} ${primary ? "checked" : ""}>${escapeHtml(t("admin.programs.primaryContact"))}</wa-checkbox>
      <p class="muted">${escapeHtml(t("admin.programs.primaryHelp"))}</p>
      <div class="places-modal__actions">
        <button class="btn-primary" type="submit">${escapeHtml(t("admin.programs.saveStaff"))}</button>
        <button class="btn-outline" type="button" data-cancel-program-staff-edit>${escapeHtml(t("admin.programs.cancel"))}</button>
      </div>
    </form>
  </dialog>`;
}

function programStaffDialog() {
  return `<dialog id="add-program-staff-dialog" class="places-modal" aria-labelledby="add-program-staff-title">
    <form id="program-staff-form" class="places-modal__card site-details-form">
      <h2 id="add-program-staff-title">${escapeHtml(t("admin.programs.addStaffMember"))}</h2>
      ${formInput("staff-first-name", t("admin.programs.firstName"), "", { required: true, autocomplete: "given-name" })}
      ${formInput("staff-last-name", t("admin.programs.lastName"), "", { required: true, autocomplete: "family-name" })}
      ${phoneInput("staff-phone", t("admin.programs.phone"), "", { required: true, type: "tel", autocomplete: "tel" })}
      ${formInput("staff-email", t("admin.programs.email"), "", { required: true, type: "email", autocomplete: "email" })}
      <div class="places-modal__actions">
        <button class="btn-primary" type="submit">${escapeHtml(t("admin.programs.addStaffMember"))}</button>
        <button class="btn-outline" id="cancel-program-staff" type="button">${escapeHtml(t("admin.programs.cancel"))}</button>
      </div>
    </form>
  </dialog>`;
}
