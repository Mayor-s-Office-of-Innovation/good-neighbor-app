import { phoneExtensionField } from "../../phone-extension.js";
import { t } from "../../../../frontend/src/i18n/i18n.js";
import { escapeHtml } from "../../dom.js";
import { siteTypeSelect } from "./record.templates.js";
import { addressEditor } from "./site-address.js";
import { formInput } from "../../form-fields.js";

export function newSiteFlowView(state) {
  const params = new URLSearchParams(window.location.search);
  const providerId = params.get("providerId") || "";
  const programId = params.get("programId") || "";
  const provider = state.providers.find(
    (item) => item.providerId === providerId,
  );
  const programs = state.programs.filter(
    (program) =>
      program.status !== "inactive" && program.providerId === providerId,
  );
  const program = programs.find((item) => item.programId === programId);
  const step = !provider ? 1 : !program ? 2 : 3;
  return `<section class="creation-page" aria-labelledby="new-site-title">
    <a href="/sites" data-route class="site-back-link"><wa-icon name="chevron-left" aria-hidden="true"></wa-icon> ${escapeHtml(t("admin.breadcrumb.admin"))}</a>
    <div><h1 id="new-site-title" tabindex="-1">Add new site</h1><p class="muted">Step ${step} of 3</p></div>
    <ol class="flow-steps" aria-label="New Site progress">
      <li ${step === 1 ? 'aria-current="step"' : ""}>Provider</li>
      <li ${step === 2 ? 'aria-current="step"' : ""}>Lead Program</li>
      <li ${step === 3 ? 'aria-current="step"' : ""}>Site record</li>
    </ol>
    ${step === 1 ? newSiteProviderStep(state.providers) : ""}
    ${step === 2 ? newSiteProgramStep(provider, programs) : ""}
    ${step === 3 ? newSiteRecordStep(provider, program, state.newSiteUsers) : ""}
  </section>`;
}

function newSiteProviderStep(providers) {
  return `<section class="flow-section" aria-labelledby="provider-step-title">
    <div class="panel__head"><div><h2 id="provider-step-title">Select provider</h2><p class="muted">Choose the provider responsible for this Site.</p></div><a class="btn-link" href="/providers/new?returnTo=site-new" data-route>Add new provider</a></div>
    <form id="new-site-provider-form" class="site-details-form">
      <wa-select name="provider-id" label="Provider" required placeholder="Choose a provider">
        ${providers
          .filter((provider) => provider.status !== "inactive")
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(
            (provider) =>
              `<wa-option value="${escapeHtml(provider.providerId)}">${escapeHtml(provider.name)}</wa-option>`,
          )
          .join("")}
      </wa-select>
      <button class="btn-primary" type="submit">Continue</button>
    </form>
  </section>`;
}

function newSiteProgramStep(provider, programs) {
  return `<section class="flow-section" aria-labelledby="program-step-title">
    <p class="muted">Provider: <strong>${escapeHtml(provider.name)}</strong> · <a href="/sites/new" data-route>Change</a></p>
    <div class="panel__head"><div><h2 id="program-step-title">Select lead Program</h2><p class="muted">Choose the Program that leads this Site.</p></div><a class="btn-link" href="/programs/new?returnTo=site-new&providerId=${encodeURIComponent(provider.providerId)}" data-route>Add new program</a></div>
    <form id="new-site-program-form" class="site-details-form">
      <input type="hidden" name="provider-id" value="${escapeHtml(provider.providerId)}" />
      <wa-select name="program-id" label="Lead Program" required placeholder="Choose a Program">
        ${programs.map((program) => `<wa-option value="${escapeHtml(program.programId)}">${escapeHtml(program.name)}</wa-option>`).join("")}
      </wa-select>
      ${programs.length ? "" : '<p class="muted">This provider has no Programs yet. Add one to continue.</p>'}
      <button class="btn-primary" type="submit" ${programs.length ? "" : "disabled"}>Continue</button>
    </form>
  </section>`;
}

function newSiteRecordStep(provider, program, users) {
  return `<section class="flow-section" aria-labelledby="record-step-title">
    <p class="muted">Provider: <strong>${escapeHtml(provider.name)}</strong> · Lead Program: <strong>${escapeHtml(program.name)}</strong> · <a href="/sites/new?providerId=${encodeURIComponent(provider.providerId)}" data-route>Change</a></p>
    <div><h2 id="record-step-title">Create Site record</h2><p class="muted">Complete every required field. Required empty fields are marked below.</p></div>
    <form id="new-site-record-form" class="site-details-form new-record-form">
      <input type="hidden" name="provider-id" value="${escapeHtml(provider.providerId)}" />
      <input type="hidden" name="lead-program-id" value="${escapeHtml(program.programId)}" />
      <fieldset><legend>Site details</legend><div class="form-grid form-grid--one">
        ${requiredFlowInput("site-name", "Site name", { autocomplete: "organization" })}
        ${siteTypeSelect("")}
      </div></fieldset>
      <fieldset><legend>Address</legend>
        ${addressEditor({}, { required: true })}
      </fieldset>
      <p class="muted">${escapeHtml(t("admin.sites.assignManagerLater"))}</p>
      <fieldset><legend>Public site contact</legend><div class="form-grid form-grid--two">
        ${requiredFlowInput("public-contact-email", "Email", { type: "email", autocomplete: "email" })}
        ${phoneExtensionField(requiredFlowInput("public-contact-phone", "Phone", { type: "tel", autocomplete: "tel", pattern: "[0-9()+ .-]{10,20}" }), formInput("public-contact-extension", t("admin.phone.extension"), "", { autocomplete: "tel-extension", maxlength: 20 }), escapeHtml(t("admin.phone.addExtension")), false, escapeHtml(t("admin.phone.removeExtension")))}
      </div></fieldset>
      <button class="btn-primary" type="submit" data-address-dependent disabled>Create Site</button>
    </form>
  </section>`;
}

function requiredFlowInput(name, label, options = {}) {
  return `<wa-input class="required-flow-field" name="${escapeHtml(name)}" required data-empty type="${escapeHtml(options.type || "text")}" ${options.autocomplete ? `autocomplete="${escapeHtml(options.autocomplete)}"` : ""} ${options.pattern ? `pattern="${escapeHtml(options.pattern)}"` : ""} ${options.maxlength ? `maxlength="${escapeHtml(options.maxlength)}"` : ""}><span slot="label">${escapeHtml(label)} <em>Required</em></span></wa-input>`;
}
