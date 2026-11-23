// HTML for the Site compliance tab. siteSectionView in record.templates.js
// draws it when the Compliance tab is open.
import { t } from "../../../../frontend/src/i18n/i18n.js";
import { escapeHtml, formatTimestamp } from "../../dom.js";

/**
 * @typedef {import("../../admin-types.js").AdminState} AdminState
 */

/** @param {AdminState} state */
export function siteTermsView(state) {
  const terms = [...state.siteTerms].sort((a, b) =>
    String(b.effectiveStart).localeCompare(String(a.effectiveStart)),
  );
  const active = activeSiteTerms(terms);
  const history = terms.filter((term) => term !== active);
  return `<section class="subsection" aria-labelledby="terms-title">
    <details data-site-terms ${state.expandedTermsSiteId === state.site.siteId ? "open" : ""}>
      <summary><h2 id="terms-title">${escapeHtml(t("admin.compliance.pastPeriods"))}</h2></summary>
      ${termsHistory(history, "No past perimeter check compliance periods.", true)}
    </details>
  </section>`;
}

export function siteLettersView(state) {
  const site = state.site;
  const current = site?.complianceLetters?.current;
  const past = site?.complianceLetters?.past || [];
  const emails = [...(state.letterEmailHistory || [])].sort(
    (a, b) => a.number - b.number,
  );
  return `<section class="subsection" aria-labelledby="letters-title"><details data-site-letters ${state.expandedLettersSiteId === site.siteId ? "open" : ""}>
    <summary><h2 id="letters-title">${escapeHtml(t("admin.letters.title"))}</h2></summary>
    ${current ? `<div class="compliance-letter-preview">${current.previewUrl && current.url ? `<a class="compliance-letter-preview__thumbnail" href="${escapeHtml(current.url)}" target="_blank" rel="noopener" aria-label="Open ${escapeHtml(current.fileName || "the current perimeter check letter")}"><img src="${escapeHtml(current.previewUrl)}" alt="" loading="lazy" /></a>` : ""}<p>Current letter: ${current.url ? `<a href="${escapeHtml(current.url)}" target="_blank" rel="noopener">${escapeHtml(current.fileName || "Open PDF")}</a>` : escapeHtml(current.fileName || current.status || "Generating")}</p>${current.termsVersionId ? `<button type="button" class="btn-secondary" data-resend-letter>${escapeHtml(t("admin.letters.resend"))}</button>` : ""}</div>` : `<p class="${state.site?.letterState === "draft_pending" ? "" : "empty-state"}">${state.site?.letterState === "draft_pending" ? "The letter is being generated." : "No letter has been generated yet"}</p>`}
    <h3>Past letters</h3>
    ${past.length ? `<ul>${past.map((letter) => `<li>${letter.url ? `<a href="${escapeHtml(letter.url)}" target="_blank" rel="noopener">${escapeHtml(letter.fileName || letter.createdAt || "Previous letter")}</a>` : escapeHtml(letter.fileName || letter.createdAt || "Previous letter")}</li>`).join("")}</ul>` : '<p class="empty-state">No past letters.</p>'}
    <h3>${escapeHtml(t("admin.letters.emailHistory"))}</h3>
    ${state.letterEmailUncertain ? `<p class="error" role="alert">${escapeHtml(t("admin.letters.deliveryUncertain"))}</p>` : ""}
    ${emails.length ? `<div class="table-wrap"><table><thead><tr><th scope="col">#</th><th scope="col">${escapeHtml(t("admin.letters.letterLink"))}</th><th scope="col">${escapeHtml(t("admin.letters.sentTo"))}</th><th scope="col">${escapeHtml(t("admin.letters.dateSent"))}</th></tr></thead><tbody>${emails.map((email) => `<tr><td>${email.number}</td><td><a href="${escapeHtml(email.letter.url)}" target="_blank" rel="noopener">${escapeHtml(email.letter.fileName)}</a></td><td>${(email.recipients || []).map((address) => escapeHtml(address)).join("<br>") || "—"}</td><td>${escapeHtml(formatTimestamp(email.sentAt))}${email.provider === "local-preview" ? ` (${escapeHtml(t("admin.letters.localPreview"))})` : ""}</td></tr>`).join("")}</tbody></table></div>` : `<p class="empty-state">${escapeHtml(t("admin.letters.noEmails"))}</p>`}
    ${state.letterHistoryCursor ? `<button class="btn-secondary" id="more-letter-history" type="button">${escapeHtml(t("admin.status.loadMore"))}</button>` : ""}
  </details></section>`;
}

/** @param {any[]} terms @param {string} [emptyMessage] @param {boolean} [past] */
function termsHistory(
  terms,
  emptyMessage = "No effective-dated terms have been added.",
  past = false,
) {
  if (!terms.length)
    return `<p class="empty-state">${escapeHtml(emptyMessage)}</p>`;
  return `<div class="table-wrap"><table class="compliance-terms-table"><colgroup><col class="compliance-terms-date"><col class="compliance-terms-date"><col class="compliance-terms-reasons"><col class="compliance-terms-monitoring"><col class="compliance-terms-cadence"><col class="compliance-terms-created"></colgroup><thead><tr><th>${escapeHtml(t("admin.compliance.started"))}</th><th>${escapeHtml(t(past ? "admin.compliance.ended" : "admin.compliance.ends"))}</th><th>${escapeHtml(t("admin.compliance.reasonsGiven"))}</th><th>${escapeHtml(t("siteAdmin.compliance.enhancedMonitoring"))}</th><th>Checks/day</th><th>Created</th></tr></thead><tbody>${terms
    .map(
      (term) =>
        `<tr><td>${escapeHtml(term.effectiveStart)}</td><td>${escapeHtml(term.endedOn || term.periodEnd || (past ? "Until further notice" : t("admin.compliance.noEndDate")))}</td><td>${(term.reasons || []).length ? term.reasons.map((reason) => `<button type="button" class="btn-link compliance-reason-link" data-compliance-reason="${escapeHtml(reason)}" aria-haspopup="dialog" aria-controls="compliance-reasons-dialog" aria-label="${escapeHtml(t("admin.compliance.viewReason", { number: reason }))}">${escapeHtml(reason)}</button>`).join(", ") : "Legacy period"}</td><td>${escapeHtml(t(term.underEnhancedMonitoring ? "admin.compliance.yes" : "admin.compliance.no"))}</td><td>${escapeHtml(term.requiredChecksPerDay)}</td><td>${escapeHtml(formatTimestamp(term.createdAt))}</td></tr>`,
    )
    .join("")}</tbody></table></div>`;
}

export function siteComplianceSummaryView(state) {
  const sortedTerms = [...state.siteTerms].sort((a, b) =>
    String(b.effectiveStart).localeCompare(String(a.effectiveStart)),
  );
  const active = activeSiteTerms(sortedTerms);
  const missingLetterDetails = complianceLetterDetailsMissing(state);
  return `<section class="site-details-form compliance-status" aria-labelledby="compliance-title">
    <h2 id="compliance-title">${escapeHtml(t("admin.compliance.statusTitle"))}</h2>
    ${active ? `<div class="compliance-status-row"><p>${escapeHtml(t("admin.compliance.active"))}</p><button type="button" class="btn-danger" data-end-checks>${escapeHtml(t("admin.compliance.cancelRequirement"))}</button></div>` : `<p>${escapeHtml(t("admin.compliance.inactive"))}</p><button type="button" class="btn-primary" data-require-checks ${missingLetterDetails ? 'disabled aria-describedby="perimeter-checks-prerequisite-error"' : ""}>${escapeHtml(t("admin.compliance.requireChecks"))}</button>`}
    ${missingLetterDetails ? '<p id="perimeter-checks-prerequisite-error" class="error compliance-prerequisite-error" role="alert">Complete the Site manager, address, department, and City program manager contact details before requiring checks.</p>' : ""}
    ${active ? termsHistory([active]) : ""}
  </section>
  ${newChecksPeriodDialog(state)}
  <dialog id="end-checks-period-dialog" class="places-modal" aria-labelledby="end-checks-period-title" aria-describedby="end-checks-period-copy">
    <form class="places-modal__card" method="dialog">
      <div class="places-modal__copy">
        <h2 id="end-checks-period-title">${escapeHtml(t("admin.compliance.endTitle"))}</h2>
        <p id="end-checks-period-copy">${escapeHtml(t("admin.compliance.endConfirmation"))}</p>
      </div>
      <div class="places-modal__actions">
        <button class="btn-danger" value="confirm">${escapeHtml(t("admin.compliance.endRequirement"))}</button>
        <button class="btn-secondary" value="cancel">${escapeHtml(t("admin.compliance.keepRequirement"))}</button>
      </div>
    </form>
  </dialog>`;
}

function complianceLetterDetailsMissing(state) {
  const site = state.site;
  if (!site) return true;
  const oversight = site.oversight || {};
  return !(
    site.name &&
    site.address &&
    state.assignedUsers.some((manager) =>
      Boolean(manager.firstName && manager.lastName),
    ) &&
    oversight.managingCityDepartment
  );
}

/** The same numbered descriptions appear in setup and the history reference. */
function complianceReasons() {
  return ["1", "2", "3", "4", "6"].map((number) => [
    number,
    t(`admin.compliance.reason${number}`),
  ]);
}

export function complianceReasonsDialog() {
  return `<dialog id="compliance-reasons-dialog" class="places-modal compliance-reasons-dialog" aria-labelledby="compliance-reasons-title">
    <form class="places-modal__card" method="dialog">
      <div class="compliance-reasons-dialog__close-row">
        <button class="btn-icon" type="submit" value="close" aria-label="${escapeHtml(t("common.close"))}" autofocus><wa-icon name="xmark" aria-hidden="true"></wa-icon></button>
      </div>
      <div class="places-modal__copy">
        <h2 id="compliance-reasons-title">${escapeHtml(t("admin.compliance.reasonsTitle"))}</h2>
        <ol class="compliance-reasons-list">${complianceReasons()
          .map(
            ([number, text]) =>
              `<li value="${number}">${escapeHtml(text)}</li>`,
          )
          .join("")}</ol>
      </div>
    </form>
  </dialog>`;
}

function newChecksPeriodDialog(state) {
  const mappedReason = {
    permanent_supportive_housing: "2",
    shelter: "3",
    drop_in: "4",
  }[state.site?.siteType || ""];
  const reasons = complianceReasons();
  return `<dialog id="new-checks-period-dialog" class="places-modal compliance-period-dialog" aria-labelledby="new-checks-period-title">
    <form id="site-compliance-form" class="places-modal__card site-details-form" novalidate>
      <div class="places-modal__copy">
        <h3 class="places-modal__title" id="new-checks-period-title">Set up the perimeter check requirement</h3>
        <p>Indicate why perimeter checks will apply.</p>
        <fieldset class="form-grid form-grid--one compliance-period-reasons">
          <legend>Select one or more reasons</legend>
          ${reasons.map(([value, label]) => `<wa-checkbox name="terms-reason" value="${value}" ${mappedReason === value ? "checked" : ""}>${escapeHtml(label)}</wa-checkbox>`).join("")}
        </fieldset>
        <div class="form-grid form-grid--one compliance-period-fields">
          <wa-number-input name="terms-checks-per-day" label="${escapeHtml(t("siteAdmin.compliance.checksPerDay"))}" min="1" max="8" step="1" value="3" required>
            <wa-icon slot="decrement-icon" name="minus" aria-hidden="true"></wa-icon>
            <wa-icon slot="increment-icon" name="plus" aria-hidden="true"></wa-icon>
          </wa-number-input>
          <wa-select name="terms-site-manager-id" label="${escapeHtml(t("admin.compliance.addressLetterTo"))}" placeholder="Choose a Site manager" hint="${escapeHtml(t("admin.compliance.letterRecipientsHint"))}" required>
            ${state.assignedUsers.map((manager) => `<wa-option value="${escapeHtml(manager.userId)}" ${state.assignedUsers.length === 1 ? "selected" : ""}>${escapeHtml(`${manager.firstName || ""} ${manager.lastName || ""}`.trim())}</wa-option>`).join("")}
          </wa-select>
          <wa-input name="terms-expiry" type="date" label="Define when the check requirement will end" data-expiry-field hidden></wa-input>

        </div>
        <p class="error site-details-form__message compliance-period-error" role="alert" data-form-save-error hidden></p>
      </div>
      <div class="places-modal__actions">
        <button class="btn-primary" type="submit" data-save-button>${escapeHtml(t("admin.letters.saveSend"))}</button>
        <button class="btn-secondary" type="button" data-cancel-checks-period>Cancel</button>
      </div>
    </form>
  </dialog>`;
}

function activeSiteTerms(terms) {
  const today = todayPacific();
  return terms.find(
    (term) =>
      term.status !== "cancelled" &&
      !term.endedAt &&
      term.effectiveStart <= today &&
      (!term.expiresOnExclusive || term.expiresOnExclusive > today) &&
      (!term.periodEnd || term.periodEnd >= today),
  );
}

function todayPacific() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Los_Angeles",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(new Date())
      .map(({ type, value }) => [type, value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}
