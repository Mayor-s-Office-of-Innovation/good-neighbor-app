// HTML for the Site record page. siteSectionView picks which tab's template
// to draw, and the new Site flow reuses siteTypeSelect.
import { siteProviderPrograms } from "./site-program.js";
import { t } from "../../../../frontend/src/i18n/i18n.js";
import { escapeHtml, formatTimestamp } from "../../dom.js";
import { canEditSite } from "../../site-permissions.js";
import { siteManagersEditorView } from "./manager.templates.js";
import {
  siteTermsView,
  siteLettersView,
  siteComplianceSummaryView,
  complianceReasonsDialog,
} from "./compliance.templates.js";
import { siteAccessView } from "./access.templates.js";
import {
  parseLegacyAddress,
  addressEditor,
  streetLineFromParts,
  formatAddressParts,
} from "./site-address.js";
import { siteOversightView } from "./oversight.templates.js";
import { phoneInput, formInput } from "../../form-fields.js";

/**
 * @typedef {import("../../admin-types.js").AdminState} AdminState
 * @typedef {import("../../admin-types.js").AdminSite} AdminSite
 */

/** @param {string} siteName */
function deactivateSiteSection(siteName) {
  return `<section class="subsection" aria-labelledby="deactivate-site-title">
    <h2 id="deactivate-site-title">${escapeHtml(t("admin.site.deactivate"))}</h2>
    <p id="deactivate-site-copy" class="muted">${escapeHtml(t("admin.site.deactivateDescription"))}</p>
    <form id="deactivate-site-form" class="inline-form destructive-confirmation" aria-describedby="deactivate-site-copy">
      <wa-input name="confirmation" required autocomplete="off" label="${escapeHtml(t("admin.site.deactivateConfirmation", { name: siteName }))}"></wa-input>
      <button class="btn-danger" type="submit" disabled>${escapeHtml(t("admin.site.deactivate"))}</button>
    </form>
  </section>`;
}

/** @param {string} siteId @param {string} current @param {boolean} [showAppSettings] */
export function siteSectionNav(siteId, current, showAppSettings = false) {
  const sections = [
    ["details", "Site details"],
    ["oversight", "Oversight"],
    ["compliance", "Compliance"],
    ["access", "App access"],
    ...(showAppSettings ? [["settings", t("admin.sites.appSettings")]] : []),
  ];
  return `<nav class="entity-tabs" aria-label="Site sections">${sections
    .map(
      ([value, label]) =>
        `<a href="/sites/${encodeURIComponent(siteId)}?section=${value}" data-route ${value === current ? 'aria-current="page"' : ""}>${label}</a>`,
    )
    .join("")}</nav>`;
}

/** @param {AdminState} state @param {string} section @param {string} [subview] */
export function siteSectionView(state, section, subview = "") {
  const site = /** @type {AdminSite} */ (state.site);
  const readOnly = canEditSite(state)
    ? ""
    : `<wa-callout variant="warning" appearance="filled" size="small" role="status"><wa-icon slot="icon" name="triangle-exclamation" aria-hidden="true"></wa-icon>${escapeHtml(t("admin.sites.readOnly"))}</wa-callout>`;
  if (section === "oversight")
    return `${readOnly}${siteOversightView(state)}${state.siteSaveMessage ? `<p class="success" role="status">${escapeHtml(state.siteSaveMessage)}</p>` : ""}`;
  if (section === "compliance") {
    return `${readOnly}${siteComplianceSummaryView(state)}${state.siteSaveMessage ? `<p class="success" role="status">${escapeHtml(state.siteSaveMessage)}</p>` : ""}${siteTermsView(state)}${siteLettersView(state)}${sitePerimeterView(state)}${complianceReasonsDialog()}`;
  }
  if (section === "access") return readOnly + siteAccessView(state);
  if (section === "settings" && state.capabilities.createEntities === true)
    return siteDeliberate311View(state);
  return `${readOnly}${siteEditor(state)}
    ${state.siteSaveMessage ? `<p id="site-save-status" class="success" role="status">${escapeHtml(state.siteSaveMessage)}</p>` : ""}
    ${state.capabilities.createEntities ? deactivateSiteSection(site.name) : ""}
    `;
}

/** @param {AdminState} state */
function sitePerimeterView(state) {
  const site = /** @type {AdminSite} */ (state.site);
  const conflict = state.perimeterError.includes("Reload the latest version");
  const updatedBy =
    site.perimeterUpdatedSource === "good-neighbor"
      ? ` ${escapeHtml(t(site.perimeterUpdatedDeviceLabel ? "admin.perimeter.appDeviceLabel" : "admin.perimeter.appDeviceId", { device: site.perimeterUpdatedDeviceLabel || site.perimeterUpdatedBy }))}`
      : site.perimeterUpdatedBy
        ? ` by ${escapeHtml(site.perimeterUpdatedBy)}`
        : "";
  return `<section class="subsection" aria-labelledby="perimeter-title">
    <div>
      <h2 id="perimeter-title">Perimeter</h2>
      <p class="muted">${escapeHtml(t("admin.perimeter.descriptionHint"))}</p>
    </div>
    <form id="site-perimeter-form" class="site-details-form" data-dirty-form>
      <wa-textarea class="perimeter-description" label="Perimeter description" name="perimeter" rows="8" maxlength="4000" value="${escapeHtml(site.perimeter || "")}" placeholder="e.g., &quot;16th Street between #1456 and #1756&quot;" required></wa-textarea>
      <div class="form-actions">
        <button class="btn-primary" type="submit" data-save-button disabled>${state.perimeterSaving ? "Saving…" : "Save perimeter"}</button>
      </div>
    </form>
    ${site.perimeterUpdatedAt ? `<p class="muted">Last updated ${escapeHtml(formatTimestamp(site.perimeterUpdatedAt))}${updatedBy}.</p>` : ""}
    ${state.perimeterError ? `<div class="error site-details-form__message" role="alert"><p>${escapeHtml(state.perimeterError)}</p>${conflict ? '<button class="btn-secondary" id="reload-site-perimeter" type="button">Reload latest Site</button>' : ""}</div>` : ""}
    ${state.perimeterMessage ? `<p class="success" role="status">${escapeHtml(state.perimeterMessage)}</p>` : ""}
  </section>`;
}

export function siteTypeSelect(value) {
  const options = [
    ["", "Not set"],
    ["permanent_supportive_housing", "Permanent supportive housing"],
    ["shelter", "Shelter"],
    ["drop_in", "Drop-in"],
    ["other", t("admin.sites.typeOther")],
  ];
  return `<wa-select name="site-type" label="Site type">
    ${options.map(([optionValue, label]) => `<wa-option value="${optionValue}" ${optionValue === value ? "selected" : ""}>${label}</wa-option>`).join("")}
  </wa-select>`;
}

/**
 * @param {AdminSite} site
 * @param {boolean} saving
 * @param {string} saveError
 */
function siteEditor(state) {
  const site = /** @type {AdminSite} */ (state.site);
  const address = site.addressParts || parseLegacyAddress(site.address) || {};
  const publicContact = site.publicContact || site.contactPerson || {};
  const programs = siteProviderPrograms(state.programs, site.providerId);
  const hasAddress = Boolean(site.address || streetLineFromParts(address));
  return `<div class="panel__head"><h2>${escapeHtml(t("admin.sites.detailsTitle"))}</h2></div>
  <form id="site-details-form" class="site-details-form" data-read-only="${!canEditSite(state)}" data-dirty-form>
    <fieldset>
      <legend>Site name and public contact</legend>
      <div class="form-grid form-grid--one" data-site-details-fields>
        ${formInput("site-name", "Site name", site.name, { required: true, autocomplete: "organization" })}
        ${siteTypeSelect(site.siteType || "")}
        <div class="form-grid form-grid--two">
          ${formInput("public-contact-email", "Public contact email", publicContact.email, { type: "email", autocomplete: "email" })}
          ${phoneInput("public-contact-phone", "Public contact phone", publicContact.phone, { extension: publicContact.phoneExtension, type: "tel", autocomplete: "tel", pattern: "(?:\\+?1[ .-]?)?\\(?[0-9]{3}\\)?[ .-]?[0-9]{3}[ .-]?[0-9]{4}" })}
        </div>
        <button class="btn-primary" type="submit" data-save-site-details disabled>${state.siteSaving ? "Saving…" : "Save changes"}</button>
      </div>
    </fieldset>
    <fieldset>
      <legend>Address</legend>
      <div data-address-container>
        ${
          hasAddress
            ? `<div class="address-display">
                <p data-address-display>${escapeHtml(site.address || formatAddressParts(address))}</p>
                <button class="btn-secondary" type="button" data-edit-address aria-controls="site-address-editor" aria-expanded="false">Edit address</button>
              </div>
              <div id="site-address-editor" data-address-editor hidden>
                ${addressEditor(address)}
                <button class="btn-primary" type="button" data-save-address disabled>Save address</button>
              </div>`
            : `<div data-address-editor>
                ${addressEditor(address)}
                <button class="btn-primary" type="button" data-save-address disabled>Save address</button>
              </div>`
        }
      </div>
    </fieldset>
    <fieldset>
      <legend>${escapeHtml(t("admin.relationships.siteAffiliations"))}</legend>
      <div class="form-grid form-grid--one">
        <wa-select name="lead-provider-id" label="${escapeHtml(t("admin.relationships.leadProvider"))}" data-initial-value="${escapeHtml(site.providerId)}">${state.providers
          .filter((p) => p.status !== "inactive")
          .map(
            (p) =>
              `<wa-option value="${escapeHtml(p.providerId)}" ${p.providerId === site.providerId ? "selected" : ""}>${escapeHtml(p.name)}</wa-option>`,
          )
          .join("")}</wa-select>
        <wa-select name="lead-program-id" label="${escapeHtml(t("admin.relationships.leadProgram"))}" placeholder="No lead program assigned" data-initial-value="${escapeHtml(site.leadProgramId || "")}">
          <wa-option value="" ${site.leadProgramId ? "" : "selected"}>No lead program assigned</wa-option>
          ${programs.map((program) => `<wa-option value="${escapeHtml(program.programId)}" ${program.programId === site.leadProgramId ? "selected" : ""}>${escapeHtml(program.name)}</wa-option>`).join("")}
          ${state.capabilities.createEntities && site.providerId ? `<wa-option value="__create_program__" data-create-program>${escapeHtml(t("admin.programs.createNew"))}</wa-option>` : ""}
        </wa-select>
        <button class="btn-primary" type="button" data-save-lead-program disabled>${escapeHtml(t("admin.relationships.saveAffiliations"))}</button>
      </div>
    </fieldset>
    ${state.siteSaveError ? `<p id="site-save-error" class="error site-details-form__message" role="alert">${escapeHtml(state.siteSaveError)}</p>` : ""}
  </form>
  ${siteManagersEditorView(state)}
  ${leadProgramConfirmationDialog()}
  ${state.capabilities.createEntities && site.providerId ? createSiteProgramDialog() : ""}
  `;
}

/** @param {AdminState} state */
function siteDeliberate311View(state) {
  if (state.capabilities.createEntities !== true || !state.site) return "";
  const enabled = state.site.deliberate311ProductionEnabled !== false;
  return `<section class="subsection" aria-labelledby="site-deliberate-311-title">
    <h2 id="site-deliberate-311-title">${escapeHtml(t("admin.sites.deliberate311.title"))}</h2>
    <form id="site-deliberate-311-form" class="site-details-form" data-dirty-form aria-labelledby="site-deliberate-311-title">
      <div class="form-grid form-grid--one">
        <wa-select name="deliberate-311-enabled" value="${enabled}" label="${escapeHtml(t("admin.sites.deliberate311.label"))}" data-initial-value="${enabled}">
          <wa-option value="true" ${enabled ? "selected" : ""}>${escapeHtml(t("admin.sites.deliberate311.production"))}</wa-option>
          <wa-option value="false" ${enabled ? "" : "selected"}>${escapeHtml(t("admin.sites.deliberate311.simulated"))}</wa-option>
        </wa-select>
        <p>${escapeHtml(t("admin.sites.deliberate311.hint"))}</p>
        <button class="btn-primary" type="submit" data-save-button disabled>${escapeHtml(t("common.save"))}</button>
      </div>
    </form>
  </section>`;
}

function createSiteProgramDialog() {
  return `<dialog id="create-site-program-dialog" class="places-modal" aria-labelledby="create-site-program-title">
    <form class="places-modal__card site-details-form">
      <h2 id="create-site-program-title">${escapeHtml(t("admin.programs.createNew"))}</h2>
      ${formInput("program-name", t("admin.programs.name"), "", { required: true, autocomplete: "organization" })}
      <div class="places-modal__actions">
        <button class="btn-primary" type="submit">${escapeHtml(t("admin.programs.createNew"))}</button>
        <button class="btn-outline" type="button" data-close-dialog>${escapeHtml(t("common.cancel"))}</button>
      </div>
    </form>
  </dialog>`;
}

function leadProgramConfirmationDialog() {
  return `<dialog id="lead-program-confirmation-dialog" class="places-modal" aria-labelledby="lead-program-confirmation-title" aria-describedby="lead-program-confirmation-copy">
    <form class="places-modal__card" method="dialog">
      <div class="places-modal__copy">
        <h2 class="places-modal__title" id="lead-program-confirmation-title">${escapeHtml(t("admin.relationships.confirmSiteChange"))}</h2>
        <p class="places-modal__text" id="lead-program-confirmation-copy">${escapeHtml(t("admin.relationships.providerAccessWarning"))}</p>
      </div>
      <div class="places-modal__actions">
        <button class="btn-primary" value="confirm">${escapeHtml(t("admin.relationships.saveAffiliations"))}</button>
        <button class="btn-outline" value="cancel">Cancel</button>
      </div>
    </form>
  </dialog>`;
}
