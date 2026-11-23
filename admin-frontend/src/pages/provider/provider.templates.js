import { providerManagerPath } from "../../provider-manager-directory.js";
import { t } from "../../../../frontend/src/i18n/i18n.js";
import { escapeHtml, formatTimestamp } from "../../dom.js";
import { enrollmentCodePanel } from "../../enrollment-code-view.js";
import {
  discardChangesDialog,
  shortOpaqueId,
  entityBreadcrumb,
} from "../shared.templates.js";
import { phoneInput, formInput } from "../../form-fields.js";

/**
 * @typedef {import("../../admin-types.js").AdminState} AdminState
 * @typedef {import("../../admin-types.js").AdminProvider} AdminProvider
 */

export function newProviderView() {
  const inSiteFlow =
    new URLSearchParams(window.location.search).get("returnTo") === "site-new";
  return `<section class="creation-page" aria-labelledby="new-provider-title">
    <a href="${inSiteFlow ? "/sites/new" : "/providers"}" data-route class="site-back-link"><wa-icon name="chevron-left" aria-hidden="true"></wa-icon> ${inSiteFlow ? "Add new site" : "Providers"}</a>
    <div><h1 id="new-provider-title" tabindex="-1">Add new provider</h1><p class="muted">Create the provider record. ${inSiteFlow ? "You’ll return to the new Site flow afterward." : ""}</p></div>
    <form id="provider-form" class="site-details-form">
      ${formInput("provider-name", "Provider name", "", { required: true, autocomplete: "organization" })}
      <button class="btn-primary" type="submit">Add provider</button>
    </form>
  </section>`;
}

/** @param {AdminState} state */
export function providerView(state) {
  const provider = /** @type {AdminProvider} */ (state.provider);
  const linkedPrograms = state.programs
    .filter(
      (program) =>
        program.status !== "inactive" &&
        program.providerId === provider.providerId,
    )
    .sort((a, b) => a.name.localeCompare(b.name));
  const availablePrograms = state.programs
    .filter(
      (program) =>
        program.status !== "inactive" &&
        program.providerId !== provider.providerId,
    )
    .sort((a, b) => a.name.localeCompare(b.name));
  const access =
    new URLSearchParams(location.search).get("section") === "access";
  return `<section class="site-page site-record" aria-labelledby="provider-title">
    ${entityBreadcrumb("provider", provider)}
    <div class="panel__head">
      <h1 id="provider-title" tabindex="-1">${escapeHtml(provider.name)}</h1>
    </div>
    <nav class="entity-tabs" aria-label="${escapeHtml(t("admin.providerManagers.providerTabs"))}">
      <a href="/providers/${encodeURIComponent(provider.providerId)}?section=details" data-route ${access ? "" : 'aria-current="page"'}>${escapeHtml(t("admin.providerManagers.providerDetails"))}</a>
      ${state.capabilities.manageProviderManagers ? `<a href="/providers/${encodeURIComponent(provider.providerId)}?section=access" data-route ${access ? 'aria-current="page"' : ""}>${escapeHtml(t("admin.providerManagers.appAccess"))}</a>` : ""}
    </nav>
    ${
      access
        ? state.capabilities.manageProviderManagers
          ? providerAccessView(state)
          : ""
        : `
    <form id="provider-details-form" class="site-details-form" data-dirty-form>
      ${formInput("provider-name", "Provider name", provider.name, { required: true, autocomplete: "organization" })}
      <button class="btn-primary" type="submit" data-save-button disabled>Save changes</button>
    </form>
    ${state.siteSaveMessage ? `<p class="success" role="status">${escapeHtml(state.siteSaveMessage)}</p>` : ""}
    ${state.capabilities.manageProviderManagers ? providerManagerPanel(state) : ""}
    <section class="subsection" aria-labelledby="provider-programs-title">
      <div class="panel__head">
        <h2 id="provider-programs-title">Programs</h2>
        <a class="btn-link" href="/programs/new?providerId=${encodeURIComponent(provider.providerId)}&returnTo=provider" data-route>Create a new program</a>
      </div>
      ${linkedPrograms.length ? `<ul class="site-directory-list">${linkedPrograms.map((program) => `<li><a class="site-directory-row" href="/programs/${encodeURIComponent(program.programId)}" data-route><span class="site-directory-row__text"><strong>${escapeHtml(program.name)}</strong><span>Program</span></span><span class="site-directory-row__caret" aria-hidden="true">›</span></a></li>`).join("")}</ul>` : '<p class="empty-state">No programs are linked to this provider.</p>'}
      <form id="provider-program-form" class="inline-form">
        <wa-select name="program-id" label="Add program" required placeholder="Choose a program" ${availablePrograms.length ? "" : "disabled"}>
          ${availablePrograms.map((program) => `<wa-option value="${escapeHtml(program.programId)}">${escapeHtml(program.name)}</wa-option>`).join("")}
        </wa-select>
        <button class="btn-primary" type="submit" data-add-program-button disabled>Add program</button>
      </form>
      ${!availablePrograms.length && linkedPrograms.length ? '<p class="muted">Every active Program is already linked to this provider.</p>' : ""}
    </section>
    ${state.capabilities.createEntities ? `<section class="subsection"><h2>${escapeHtml(t("admin.providerManagers.deactivateProvider"))}</h2><p>${escapeHtml(t("admin.providerManagers.deactivateProviderHelp"))}</p><button class="btn-danger" type="button" data-deactivate-provider="${escapeHtml(provider.providerId)}">${escapeHtml(t("admin.providerManagers.deactivateProvider"))}</button></section>` : ""}
    `
    }
    ${deactivateProviderDialog(provider.name)}
    ${discardChangesDialog()}
  </section>`;
}

/** @param {AdminState} state */
function providerManagerPanel(state) {
  return `<section class="subsection" aria-labelledby="provider-managers-title">
    <div class="panel__head"><h2 id="provider-managers-title">${escapeHtml(t("admin.providerManagers.title"))}</h2><button class="btn-primary" id="add-provider-manager" type="button" aria-haspopup="dialog">${escapeHtml(t("admin.providers.addManager"))}</button></div>
    <p class="muted">${escapeHtml(t("admin.enrollment.providerDefinition"))}</p>
    ${state.providerManagers
      .filter((manager) => manager.status === "active")
      .map((manager) => providerManagerRow(manager, state.provider.providerId))
      .join("")}
    <form class="inline-form" data-assign-existing-provider-person><wa-select name="person-id" label="${escapeHtml(t("admin.relationships.assignExistingPerson"))}" placeholder="${escapeHtml(t("admin.relationships.choosePerson"))}" required>${(
      state.people || []
    )
      .filter(
        (person) =>
          !state.providerManagers.some(
            (m) => m.personId === person.personId && m.status === "active",
          ),
      )
      .map(
        (person) =>
          `<wa-option value="${escapeHtml(person.personId)}">${escapeHtml(person.name)} · ${escapeHtml(person.email)}</wa-option>`,
      )
      .join(
        "",
      )}</wa-select><button class="btn-secondary" type="submit">${escapeHtml(t("admin.relationships.assignPerson"))}</button></form>
    <dialog id="add-provider-manager-dialog" class="places-modal" data-provider-manager-dialog aria-labelledby="add-provider-manager-title">
      <form class="places-modal__card site-details-form" data-provider-manager-form>
        <h2 id="add-provider-manager-title">${escapeHtml(t("admin.providers.addManager"))}</h2>
        <div class="form-grid">
          ${formInput("provider-manager-first-name", "First name", "", { required: true, autocomplete: "given-name" })}
          ${formInput("provider-manager-last-name", "Last name", "", { required: true, autocomplete: "family-name" })}
          ${formInput("provider-manager-email", "Email", "", { required: true, type: "email", autocomplete: "email" })}
          ${phoneInput("provider-manager-phone", "Phone", "", { required: true, type: "tel", autocomplete: "tel" })}
        </div>
        <div class="places-modal__actions">
          <button class="btn-primary" type="submit">${escapeHtml(t("admin.providers.addManager"))}</button>
          <button class="btn-outline" type="button" data-close-dialog>${escapeHtml(t("common.cancel"))}</button>
        </div>
      </form>
    </dialog>
  </section>`;
}

/** @param {any} manager @param {string} providerId */
function providerManagerRow(manager, providerId) {
  const inactive = manager.status === "inactive";
  return `<article class="provider-manager-summary" data-provider-manager-row><div><h3>${escapeHtml(manager.name)}</h3><a href="mailto:${escapeHtml(manager.email)}">${escapeHtml(manager.email)}</a><p class="muted">${escapeHtml(t("admin.providerManagers.deviceCount", { count: manager.activeDeviceCount || 0 }))}${inactive ? ` · ${escapeHtml(t("admin.providerManagers.inactive"))}` : ""}</p></div><div class="row">
    <a class="btn-secondary" href="${providerManagerPath(providerId, manager.membershipId)}" data-route>${escapeHtml(t("common.edit"))}</a>
    <button class="${inactive ? "btn-secondary" : "btn-danger"}" type="button" data-provider-manager-status="${escapeHtml(manager.membershipId)}" data-provider-manager-active="${inactive ? "true" : "false"}">${escapeHtml(t(inactive ? "admin.providerManagers.reinstate" : "admin.siteManagers.remove"))}</button>
  </div></article>`;
}

export function providerManagerDetailView(state, membershipId) {
  const manager = state.providerManagers.find(
    (item) => item.membershipId === membershipId,
  );
  if (!manager)
    return `<p role="alert">${escapeHtml(t("admin.providerManagers.notFound"))}</p>`;
  return `<section class="site-page site-record"><nav class="entity-breadcrumb" aria-label="${escapeHtml(t("admin.breadcrumb.label"))}"><a href="/provider-managers" data-route>${escapeHtml(t("admin.providerManagers.title"))}</a><span aria-hidden="true"> › </span><a href="/providers/${encodeURIComponent(state.provider.providerId)}?section=details" data-route>${escapeHtml(state.provider.name)}</a></nav>
    <h1 tabindex="-1">${escapeHtml(manager.name)}</h1>
    <form id="provider-manager-record-form" class="site-details-form" data-provider-manager-form data-dirty-form>
      <h2>${escapeHtml(t("admin.providerManagers.details"))}</h2>
      <input type="hidden" name="provider-manager-membership-id" value="${escapeHtml(manager.membershipId)}">
      ${formInput("provider-manager-first-name", t("admin.programs.firstName"), manager.firstName, { required: true, autocomplete: "given-name" })}
      ${formInput("provider-manager-last-name", t("admin.programs.lastName"), manager.lastName, { required: true, autocomplete: "family-name" })}
      ${formInput("provider-manager-email", t("admin.programs.email"), manager.email, { required: true, type: "email", autocomplete: "email" })}
      ${phoneInput("provider-manager-phone", t("admin.programs.phone"), manager.phone, { extension: manager.phoneExtension, required: true, type: "tel", autocomplete: "tel" })}
      <button class="btn-primary" type="submit" data-save-button disabled>${escapeHtml(t("admin.programs.saveStaff"))}</button>
    </form>
    <section class="subsection"><h2>${escapeHtml(t("admin.providerManagers.associatedProvider"))}</h2>${manager.status === "inactive" ? `<p>${escapeHtml(t("admin.providerManagers.noAssignedProvider"))}</p><button class="btn-secondary" type="button" data-provider-manager-status="${escapeHtml(manager.membershipId)}" data-provider-manager-active="true">${escapeHtml(t("admin.providerManagers.reassign", { name: state.provider.name }))}</button>` : `<a href="/providers/${encodeURIComponent(state.provider.providerId)}" data-route>${escapeHtml(state.provider.name)}</a>`}</section>
    ${
      manager.status === "active"
        ? `<section class="subsection"><h2>${escapeHtml(t("admin.relationships.changeProvider"))}</h2><p>${escapeHtml(t("admin.relationships.transferHelp"))}</p><form data-transfer-provider-manager="${escapeHtml(manager.membershipId)}" class="site-details-form"><wa-select name="target-provider" label="${escapeHtml(t("admin.relationships.newProvider"))}" required placeholder="${escapeHtml(t("admin.relationships.chooseProvider"))}">${state.providers
            .filter(
              (p) =>
                p.status !== "inactive" &&
                p.providerId !== state.provider.providerId,
            )
            .map(
              (p) =>
                `<wa-option value="${escapeHtml(p.providerId)}">${escapeHtml(p.name)}</wa-option>`,
            )
            .join(
              "",
            )}</wa-select><wa-input name="confirmation" label="${escapeHtml(t("admin.relationships.confirmTransfer", { name: manager.email }))}" required></wa-input><button class="btn-danger" type="submit">${escapeHtml(t("admin.relationships.changeProvider"))}</button></form></section>`
        : ""
    }
    ${providerDeviceRemovalForm(state, manager)}
    ${discardChangesDialog()}
  </section>`;
}

function providerEmailActions(manager) {
  return `<div class="contact-list__actions"><button class="btn-secondary" type="button" data-issue-provider-manager-grant="${escapeHtml(manager.membershipId)}" data-delivery-mode="link">${escapeHtml(t("admin.enrollment.emailMagicLink"))}</button><button class="btn-secondary" type="button" data-issue-provider-manager-grant="${escapeHtml(manager.membershipId)}" data-delivery-mode="code">${escapeHtml(t("admin.enrollment.emailOneTimeCode"))}</button><button class="btn-secondary" type="button" data-show-enrollment-code="${escapeHtml(manager.membershipId)}" data-enrollment-scope="provider">${escapeHtml(t("admin.enrollment.showCode"))}</button></div>`;
}

function providerAccessView(state) {
  const active = state.providerManagers.filter(
    (manager) => manager.status === "active",
  );
  return `<section><h2>${escapeHtml(t("admin.providerManagers.accessTitle"))}</h2><p>${escapeHtml(t("admin.providerManagers.accessInstructions"))}</p>${active.length ? `<ul class="contact-list provider-access-managers">${active.map((manager) => `<li><div><strong>${escapeHtml(manager.name)}</strong><span>${escapeHtml(manager.email)}</span>${state.providerManagerGrantErrors?.[manager.membershipId] ? `<p class="error" role="alert" data-provider-manager-grant-error="${escapeHtml(manager.membershipId)}">${escapeHtml(state.providerManagerGrantErrors[manager.membershipId])}</p>` : ""}</div>${providerEmailActions(manager)}</li>`).join("")}</ul>` : `<p class="empty-state">${escapeHtml(t("admin.providerManagers.none"))}</p>`}</section>
    ${enrollmentCodePanel(state, "provider", state.provider.providerId)}<section class="subsection">${providerManagerGrantList(state.providerManagerGrants)}</section>
    <section class="subsection"><h2>${escapeHtml(t("admin.enrollment.enrolledDevices"))}</h2>${providerManagerEnrollmentList(state.providerManagerEnrollments, state.providerManagers)}</section>
    ${providerDeviceRemovalForm(state)}
  `;
}

function providerDeviceRemovalForm(state, manager = null) {
  const confirmation = manager ? manager.email : state.provider.name;
  return `<section class="subsection"><h2>${escapeHtml(t(manager ? "admin.providerManagers.removeAccess" : "admin.providerManagers.removeAllAccess"))}</h2><p>${escapeHtml(t(manager ? "admin.providerManagers.unlinkHelp" : "admin.providerManagers.removeAccessHelp"))}</p><form class="inline-form destructive-confirmation" data-revoke-provider-devices data-membership-id="${escapeHtml(manager?.membershipId || "")}" data-confirmation="${escapeHtml(confirmation)}">
    <wa-input name="confirmation" required autocomplete="off" label="${escapeHtml(t(manager ? "admin.providerManagers.confirmManager" : "admin.providerManagers.confirmProvider", { name: confirmation }))}"></wa-input><button class="btn-danger" type="submit" disabled>${escapeHtml(t("admin.providerManagers.removeAccess"))}</button>
  </form></section>`;
}

/** @param {any[]} grants */
function providerManagerGrantList(grants) {
  if (!grants.length) {
    return `<h2>${escapeHtml(t("admin.enrollment.history", { count: 0 }))}</h2>`;
  }
  return `<details class="table-disclosure"><summary>${escapeHtml(t("admin.enrollment.history", { count: grants.length }))}</summary><div class="table-wrap"><table class="provider-enrollment-history"><thead><tr><th>Recipient</th><th>${escapeHtml(t("admin.enrollment.type"))}</th><th>Sites</th><th>Issued</th><th>Expires</th><th>Status</th><th>Delivery</th><th>Action</th></tr></thead><tbody>${grants
    .map(
      (grant) =>
        `<tr><td><span class="enrollment-recipient"><span>${escapeHtml(grant.issuedTo)}</span>${grant.enrollmentUrl ? `<button class="btn-icon enrollment-copy" type="button" title="Copy enrollment link" aria-label="Copy provider enrollment link for ${escapeHtml(grant.issuedTo)}" data-copy-enrollment-url="${escapeHtml(grant.enrollmentUrl)}"><wa-icon name="copy" aria-hidden="true"></wa-icon></button><span class="visually-hidden" aria-live="polite" data-copy-status></span>` : ""}</span></td><td>${escapeHtml(t(grant.deliveryMode === "code" ? "admin.enrollment.oneTimeCode" : "admin.enrollment.magicLink"))}</td><td>${escapeHtml(grant.siteCount || 0)}</td><td>${escapeHtml(formatTimestamp(grant.createdAt))}</td><td>${escapeHtml(formatTimestamp(grant.expiresAt))}</td><td>${escapeHtml(grant.status)}</td><td>${escapeHtml(grant.deliveryChannel === "screen" ? t("admin.enrollment.screenIssued") : grant.deliveryStatus || "queued")}</td><td>${grant.status === "pending" ? `<button class="btn-danger" type="button" data-cancel-provider-manager-grant="${escapeHtml(grant.grantId)}">Cancel</button>` : "—"}</td></tr>`,
    )
    .join("")}</tbody></table></div></details>`;
}

function providerManagerEnrollmentList(enrollments, managers) {
  const active = enrollments.filter((item) => item.status !== "revoked");
  if (!active.length)
    return `<p class="empty-state">${escapeHtml(t("admin.providerManagers.noDevices"))}</p>`;
  const names = new Map(
    managers.map((manager) => [manager.membershipId, manager.name]),
  );
  return `<div class="table-wrap"><table><thead><tr><th>Provider Manager</th><th>Device</th><th>Sites</th><th>Enrolled</th><th>Action</th></tr></thead><tbody>${active
    .map(
      (enrollment) =>
        `<tr><td>${escapeHtml(names.get(enrollment.membershipId) || "Provider Manager")}</td><td>ID ${escapeHtml(shortOpaqueId(enrollment.physicalDeviceId))}</td><td>${escapeHtml(enrollment.activeSiteCount ?? enrollment.siteCount ?? 0)} of ${escapeHtml(enrollment.siteCount || 0)} active</td><td>${escapeHtml(formatTimestamp(enrollment.createdAt))}</td><td><button class="btn-danger" type="button" data-revoke-provider-enrollment="${escapeHtml(enrollment.enrollmentId)}">Revoke device</button></td></tr>`,
    )
    .join("")}</tbody></table></div>`;
}

/** @param {string} providerName */
function deactivateProviderDialog(providerName) {
  return `<dialog id="deactivate-provider-dialog" class="places-modal" aria-labelledby="deactivate-provider-title" aria-describedby="deactivate-provider-copy">
    <form class="places-modal__card" method="dialog">
      <div class="places-modal__copy">
        <h2 class="places-modal__title" id="deactivate-provider-title">Deactivate ${escapeHtml(providerName)}?</h2>
        <p class="places-modal__text" id="deactivate-provider-copy">This will remove the provider from the active Providers &amp; Programs list. Its programs, sites, and app access will not be changed.</p>
      </div>
      <div class="places-modal__actions">
        <button class="btn-danger" value="confirm">Deactivate provider</button>
        <button class="btn-outline" value="cancel">Cancel</button>
      </div>
    </form>
  </dialog>`;
}
