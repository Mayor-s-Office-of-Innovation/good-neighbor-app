// Shared by creation forms and operation toasts. API codes stay out of the UI.
const messages = {
  program_already_exists: "admin.programs.duplicateHelp",
  provider_already_exists: "admin.errors.providerExists",
  site_changed: "admin.errors.siteChanged",
  site_already_exists: "admin.errors.siteExists",
  provider_manager_already_assigned: "admin.errors.staffAssigned",
  provider_manager_conflict: "admin.errors.staffChanged",
  person_update_conflict: "admin.errors.staffChanged",
  staff_source_changed: "admin.programs.staffSourceChanged",
  name_required: "admin.errors.nameRequired",
  provider_manager_name_required: "admin.errors.staffNameRequired",
  valid_email_required: "admin.errors.emailRequired",
  provider_manager_email_invalid: "admin.errors.emailRequired",
  phone_required: "admin.errors.phoneRequired",
  provider_manager_phone_required: "admin.errors.phoneRequired",
  invalid_person_contact: "admin.errors.staffContact",
  provider_not_found: "admin.errors.providerUnavailable",
  provider_required: "admin.errors.providerUnavailable",
  program_not_found: "admin.errors.programUnavailable",
  incompatible_program: "admin.errors.programUnavailable",
  site_program_required: "admin.errors.programUnavailable",
  invalid_internal_site_contact: "admin.errors.staffUnavailable",
  invalid_staff_source: "admin.errors.staffUnavailable",
  person_not_found: "admin.errors.staffUnavailable",
  affiliation_not_found: "admin.errors.affiliationUnavailable",
  request_blocked: "admin.errors.requestBlocked",
  request_too_large: "admin.errors.requestTooLarge",
  admin_request_failed: "admin.toast.requestFailed",
};

export function adminErrorMessage(error, t, fallback) {
  const key = messages[error?.message];
  if (typeof key === "string") return t(key);
  if (fallback) return fallback;
  // Preserve deliberately localized client validation; never expose API codes,
  // exception names, server details, or transport errors as user instructions.
  if (
    !error?.status &&
    /\s/.test(error?.message || "") &&
    !(error instanceof TypeError)
  )
    return error.message;
  return t("admin.toast.requestFailed");
}

export function creationConflictTitle(error) {
  return {
    program_already_exists: "admin.programs.duplicateTitle",
    provider_already_exists: "admin.errors.providerExistsTitle",
    site_already_exists: "admin.errors.siteExistsTitle",
    provider_manager_already_assigned: "admin.errors.staffAssignedTitle",
    provider_manager_conflict: "admin.errors.staffChangedTitle",
    person_update_conflict: "admin.errors.staffChangedTitle",
  }[error?.message];
}
