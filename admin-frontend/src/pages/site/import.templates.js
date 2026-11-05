import { t } from "../../../../frontend/src/i18n/i18n.js";
import { escapeHtml } from "../../dom.js";

/**
 * @typedef {import("../../main.js").AdminState} AdminState
 */

/** @param {AdminState} state */
export function siteImportView(state) {
  const preview = state.importPreview;
  const counts = preview?.counts || {};
  const ready = Number(counts.create || 0) + Number(counts.reuse || 0);
  const acceptable = Number(counts.acceptable || 0);
  const applicable = ready + acceptable;
  const skipped = Number(counts.conflict || 0) + Number(counts.invalid || 0);
  const hasConflictReport =
    skipped > 0 ||
    Number(state.importResult?.outcomes?.skipped_conflict || 0) > 0 ||
    Number(state.importResult?.outcomes?.failed || 0) > 0;
  const uploadView = `<section class="panel" aria-labelledby="upload-title">
      <div class="panel__head import-upload-heading">
        <h2 id="upload-title">Upload new or updated site records</h2>
        <button class="btn-icon" id="show-import-help" type="button" aria-label="CSV upload requirements"><wa-icon name="circle-info" aria-hidden="true"></wa-icon></button>
      </div>
      <form id="site-import-form" class="site-import-form">
        <label class="file-picker">
          <span class="file-picker__control">
            <span class="file-picker__button">Choose CSV file</span>
            <span class="file-picker__name" id="site-import-file-name" aria-live="polite" hidden></span>
          </span>
          <input class="file-picker__input" name="site-import-file" type="file" accept="text/csv,.csv" aria-describedby="site-import-file-name" required />
        </label>
        <button class="btn-primary" type="submit" ${state.importBusy ? "disabled" : ""}>${state.importBusy ? "Working…" : "Preview import"}</button>
      </form>
    </section>
    ${pastImportsTable(state.importHistory)}
    ${siteImportHelpDialog()}`;
  const completed = state.importResult?.status === "complete";
  const resultsView = `<section class="panel" aria-labelledby="import-results-title">
    <div class="panel__head"><h2 id="import-results-title">${escapeHtml(t("admin.import.resultsTitle"))}</h2>
    <button class="btn-secondary" id="cancel-site-import" type="button">${escapeHtml(t("admin.import.startNew"))}</button></div>
    <p>${escapeHtml(
      t("admin.import.outcomeCounts", {
        applied: Number(state.importResult?.outcomes?.applied || 0),
        failed:
          Number(state.importResult?.outcomes?.failed || 0) +
          Number(state.importResult?.outcomes?.skipped_conflict || 0),
      }),
    )}</p>
    ${importRowsTable(state.importResult?.rows || preview?.rows || [])}
    ${hasConflictReport ? `<button class="btn-secondary" id="download-import-conflicts" type="button">${escapeHtml(t("admin.import.downloadConflicts"))}</button>` : ""}
  </section>`;
  const reviewView = `<section class="panel" aria-labelledby="review-title">
      <div class="panel__head"><h2 id="review-title">2. Review record completeness</h2><button class="btn-secondary" id="cancel-site-import" type="button" ${state.importBusy ? "disabled" : ""}>Cancel</button></div>
      <dl class="import-summary"><div><dt>Perfect</dt><dd>${ready}</dd></div><div><dt>Acceptable</dt><dd>${acceptable}</dd></div><div><dt>Not ready</dt><dd>${skipped}</dd></div></dl>
      ${importRowsTable(preview?.rows || [])}
      <div class="confirmation"><p><strong>Import ${applicable} perfect or acceptable rows; skip ${skipped} not-ready rows.</strong></p><button class="btn-primary" id="apply-site-import" type="button" ${state.importBusy ? "disabled" : ""}>Confirm and apply</button>${hasConflictReport ? '<button class="btn-secondary" id="download-import-conflicts" type="button">Download conflict CSV</button>' : ""}</div>
      ${state.importBusy ? '<div class="import-progress" role="status" aria-live="polite"><wa-spinner aria-hidden="true"></wa-spinner><span>Importing records…</span></div>' : ""}
    </section>`;
  return `<section class="directory" aria-labelledby="import-title">
    <a class="site-back-link" href="/sites" data-route><wa-icon name="chevron-left" aria-hidden="true"></wa-icon> ${escapeHtml(t("admin.breadcrumb.admin"))}</a>
    <div class="page-head"><div><h1 id="import-title" tabindex="-1">Import sites</h1><p class="muted">Upload a CSV file of sites, providers, programs, and contact details.</p></div></div>
    ${
      state.importNotice
        ? `<section class="panel" role="status">
      <p><strong>${escapeHtml(state.importNotice.title)}</strong></p>
      <p>${escapeHtml(state.importNotice.message)}</p>
      <button class="btn-secondary" id="dismiss-import-notice" type="button">${escapeHtml(t("toastUi.dismiss.aria", { title: state.importNotice.title }))}</button>
    </section>`
        : ""
    }
    ${completed ? resultsView : preview ? reviewView : uploadView}
  </section>`;
}

/** @param {any[]} imports */
function pastImportsTable(imports) {
  const rows = imports.length
    ? imports
        .map((item) => {
          const status = importHistoryStatus(item);
          return `<tr>
            <td><a href="/sites/import?importId=${encodeURIComponent(item.importId)}" data-route>${escapeHtml(item.fileName || "Imported CSV")}</a></td>
            <td>${escapeHtml(formatImportDate(item.completedAt))}</td>
            <td>${escapeHtml(formatImportTime(item.completedAt))}</td>
            <td><span class="status-badge status-badge--${status.tone}">${status.label}</span></td>
            <td>${escapeHtml(Number(item.recordsAdded || 0))} added · ${escapeHtml(Number(item.recordsUpdated || 0))} updated${status.failed ? ` · ${escapeHtml(status.failed)} failed` : ""}</td>
          </tr>`;
        })
        .join("")
    : '<tr><td colspan="5" class="empty-state">No past imports.</td></tr>';
  return `<section class="panel" aria-labelledby="past-imports-title">
    <h2 id="past-imports-title">Past imports</h2>
    <div class="table-wrap"><table><thead><tr><th>Filename</th><th>Date</th><th>Time</th><th>Result</th><th>Records</th></tr></thead><tbody>${rows}</tbody></table></div>
  </section>`;
}

/** @param {any} item */
function importHistoryStatus(item) {
  const failed =
    Number(item.recordsFailed || 0) ||
    Number(item.outcomes?.failed || 0) +
      Number(item.outcomes?.skipped_conflict || 0);
  const applied =
    Number(item.recordsAdded || 0) + Number(item.recordsUpdated || 0);
  const resultStatus =
    item.resultStatus ||
    (failed === 0 ? "succeeded" : applied > 0 ? "partial" : "failed");
  if (resultStatus === "failed") {
    return { label: "Failed", tone: "not-ready", failed };
  }
  if (resultStatus === "partial") {
    return { label: "Partial", tone: "acceptable", failed };
  }
  return { label: "Completed", tone: "ready", failed: 0 };
}

/** @param {{ title: string, message: string } | null} notice */

function siteImportHelpDialog() {
  return `<dialog id="site-import-help-dialog" class="places-modal" aria-labelledby="site-import-help-title">
    <form class="places-modal__card import-help" method="dialog">
      <div class="import-help__close-row">
        <button class="btn-icon" type="submit" value="close" aria-label="${escapeHtml(t("common.close"))}"><wa-icon name="xmark" aria-hidden="true"></wa-icon></button>
      </div>
      <div class="places-modal__copy">
        <h2 class="places-modal__title" id="site-import-help-title">CSV upload requirements</h2>
        <div class="import-help__body">
          <p>Upload a UTF-8 CSV no larger than 1 MB or 500 data rows.</p>
          <p>The first row must contain these columns in this exact order:</p>
          <p class="column-list"><code>Provider</code>, <code>Program</code>, <code>Site name</code>, <code>Site address</code>, <code>Site type</code>, <code>Department</code>, <code>Site manager first name</code>, <code>Site manager last name</code>, <code>Site manager phone</code>, <code>Site manager extension</code>, <code>Site manager email</code>, <code>Program manager first name</code>, <code>Program manager last name</code>, <code>Program manager phone</code>, <code>Program manager extension</code>, <code>Program manager department</code>, <code>Program manager email</code>, <code>Provider manager first name</code>, <code>Provider manager last name</code>, <code>Provider manager phone</code>, <code>Provider manager extension</code>, <code>Provider manager email</code>.</p>
          <p>Program manager phone is required. Other phone and all extension columns may be blank. All remaining fields are required.</p>
          <p>Use another row with the same Site to add another Site manager, Program manager, or Provider manager. Put values containing commas in double quotes.</p>
          <p>Department names must match an existing department or one of the supported DPH and HSH names. Unknown names are held for manual resolution.</p>
        </div>
      </div>
    </form>
  </dialog>`;
}

/** @param {string | null | undefined} value */
function formatImportDate(value) {
  const date = new Date(value || "");
  return Number.isNaN(date.getTime())
    ? "Not available"
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}

/** @param {string | null | undefined} value */
function formatImportTime(value) {
  const date = new Date(value || "");
  return Number.isNaN(date.getTime())
    ? "Not available"
    : new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(date);
}

/** @param {any[]} rows */
function importRowsTable(rows) {
  return `<div class="table-wrap"><table><thead><tr><th>Status</th><th>Row</th><th>Site</th><th>Provider</th><th>Program</th><th>Reason</th></tr></thead><tbody>${rows
    .map((row) => {
      const status = importRowStatus(row);
      return `<tr><td><span class="status-badge status-badge--${status.tone}">${status.label}</span></td><td>${escapeHtml(row.rowNumber)}</td><td>${escapeHtml(row.source?.["Site name"] || "")}</td><td>${escapeHtml(row.source?.Provider || "")}</td><td>${escapeHtml(row.source?.Program || "")}</td><td>${escapeHtml(importRowReason(row))}</td></tr>`;
    })
    .join("")}</tbody></table></div>`;
}

/** @param {any} row */
function importRowStatus(row) {
  if (row.outcome === "applied") {
    return { label: "Imported", tone: "ready" };
  }
  if (row.outcome === "retryable_failed") {
    return { label: "Retry needed", tone: "acceptable" };
  }
  if (row.outcome === "failed" || row.outcome === "skipped_conflict") {
    return { label: "Not imported", tone: "not-ready" };
  }
  const classification = row.classification;
  if (classification === "create" || classification === "reuse") {
    return { label: "Perfect", tone: "ready" };
  }
  if (classification === "acceptable") {
    return { label: "Acceptable", tone: "acceptable" };
  }
  return { label: "Not ready", tone: "not-ready" };
}

/** @param {any} row */
function importRowReason(row) {
  if (row.reasonCode === "retryable_apply_error") {
    return row.outcome === "failed"
      ? "The temporary service error persisted, so this row was not imported."
      : "Temporary service error. The importer will retry this row.";
  }
  if (row.reasonCode === "import_dependency_failed")
    return t("admin.import.dependencyFailed");
  const applyFailureMessages = {
    invalid_apply_transaction:
      "The importer could not construct a valid database transaction.",
    import_service_configuration_error:
      "The import service is not configured correctly.",
    unexpected_apply_error: "The importer encountered an unexpected error.",
    changed_after_preview:
      "The underlying data changed after this preview was created.",
  };
  if (applyFailureMessages[row.reasonCode]) {
    return applyFailureMessages[row.reasonCode];
  }
  if (row.reasonCode === "missing_optional_value") {
    const missing = String(row.existingValue || "").trim();
    return missing ? `Missing optional: ${missing}` : "Optional fields missing";
  }
  if (row.reasonCode !== "missing_required_value") {
    return row.reasonCode || "—";
  }
  const missing = String(row.existingValue || "").trim();
  return missing ? `Missing: ${missing}` : "Missing required value";
}
