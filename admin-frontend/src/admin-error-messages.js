// Shared by creation forms and operation toasts. API codes stay out of the UI.
const messages = {
  program_update_conflict: "admin.programs.renameConflict",
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
  invalid_encoding: "admin.import.invalidEncoding",
  unreadable_csv: "admin.import.unreadableCsv",
  invalid_headers: "admin.import.invalidHeaders",
  invalid_row_count: "admin.import.invalidRowCount",
  request_blocked: "admin.errors.requestBlocked",
  request_too_large: "admin.errors.requestTooLarge",
  access_denied: "admin.errors.loginFailed",
  admin_group_assignment_failed: "admin.errors.adminGroupFailed",
  admin_user_change_in_progress: "admin.errors.adminUserBusy",
  admin_user_exists: "admin.errors.adminUserExists",
  admin_user_not_found: "admin.errors.adminUserUnavailable",
  admin_user_suspended: "admin.errors.adminUserSuspended",
  ambiguous_manager_identity: "admin.errors.managerAmbiguous",
  boolean_required: "admin.errors.badRequest",
  cannot_demote_self: "admin.errors.cannotDemoteSelf",
  cannot_suspend_self: "admin.errors.cannotSuspendSelf",
  cognito_not_configured: "admin.errors.userAccountsUnavailable",
  compliance_manager_profile_required: "admin.errors.complianceProfileRequired",
  compliance_profile_conflict: "admin.errors.complianceProfileConflict",
  confirmation_mismatch: "admin.errors.confirmationMismatch",
  confirmation_required: "admin.errors.badRequest",
  conflict_report_failed: "admin.errors.importConflictReport",
  current_letter_changed: "admin.errors.letterChanged",
  current_letter_required: "admin.errors.letterRequired",
  device_binding_already_revoked: "admin.errors.deviceAlreadyRevoked",
  device_binding_not_found: "admin.errors.deviceUnavailable",
  device_not_found: "admin.errors.deviceUnavailable",
  device_revocation_conflict: "admin.errors.deviceChanged",
  device_suspension_conflict: "admin.errors.deviceChanged",
  different_provider_required: "admin.errors.differentProvider",
  edit_person_contact: "admin.errors.editPersonContact",
  email_required: "admin.errors.emailRequired",
  expected_version_required: "admin.errors.badRequest",
  forbidden: "admin.errors.forbidden",
  idempotency_key_conflict: "admin.errors.badRequest",
  import_not_found: "admin.errors.importUnavailable",
  invalid_address_query: "admin.errors.addressQueryLength",
  invalid_binding_selection: "admin.errors.bindingSelection",
  invalid_check_cadence: "admin.errors.checkCadence",
  invalid_compliance_manager: "admin.errors.complianceManagerUnavailable",
  invalid_delivery_channel: "admin.errors.badRequest",
  invalid_delivery_mode: "admin.errors.badRequest",
  invalid_device_binding: "admin.errors.badRequest",
  invalid_expiry: "admin.errors.termsDateInvalid",
  invalid_json: "admin.errors.badRequest",
  invalid_login_state: "admin.errors.loginFailed",
  invalid_manager_name: "admin.errors.managerNameInvalid",
  invalid_oversight_option_type: "admin.errors.badRequest",
  invalid_perimeter: "admin.errors.perimeterInvalid",
  invalid_primary_contact: "admin.errors.badRequest",
  invalid_program_staff: "admin.errors.badRequest",
  invalid_request_id: "admin.errors.badRequest",
  invalid_role: "admin.users.invalidRole",
  invalid_site_selection: "admin.errors.siteSelection",
  invalid_site_type: "admin.errors.badRequest",
  invalid_suspension_reason: "admin.errors.suspensionReason",
  invalid_terms_range: "admin.errors.termsDateInvalid",
  invitation_not_pending: "admin.errors.invitationAccepted",
  invitation_pending: "admin.errors.invitationPending",
  last_active_supervisor: "admin.errors.lastSupervisor",
  letter_email_unavailable: "admin.errors.letterEmailUnavailable",
  manager_device_revocation_incomplete: "admin.errors.managerDevicesIncomplete",
  manager_grant_conflict: "admin.enrollment.conflict",
  manager_grant_not_found: "admin.errors.managerInvitationUnavailable",
  manager_membership_not_found: "admin.errors.managerUnavailable",
  manager_membership_required: "admin.errors.badRequest",
  manager_removal_conflict: "admin.errors.managerAccessChanged",
  membership_binding_limit_exceeded: "admin.errors.managerDeviceLimit",
  missing_admin_auth_config: "admin.errors.loginUnavailable",
  multi_site_revocation_conflict: "admin.errors.revocationChanged",
  no_active_checks_period: "admin.errors.termsNotActive",
  oversight_option_exists: "admin.errors.oversightOptionExists",
  perimeter_required: "admin.errors.perimeterRequired",
  perimeter_update_conflict: "admin.errors.perimeterChanged",
  person_migration_required: "admin.errors.personMigrationRequired",
  person_source_conflict: "admin.errors.personChanged",
  person_update_limit_exceeded: "admin.errors.personUpdateLimit",
  physical_device_binding_limit_exceeded: "admin.errors.deviceLimit",
  physical_device_not_found: "admin.errors.deviceUnavailable",
  physical_device_revocation_conflict: "admin.errors.deviceChanged",
  profile_change_in_progress: "admin.errors.profileBusy",
  profile_identity_mismatch: "admin.errors.profileIdentityMismatch",
  profile_recovery_pending: "admin.errors.profileBusy",
  program_has_sites: "admin.errors.programHasSites",
  program_manager_directory_sync_failed: "admin.errors.programManagerSync",
  program_manager_not_found: "admin.errors.programManagerUnavailable",
  program_manager_required: "admin.errors.programManagerRequired",
  program_primary_contact_in_use: "admin.programs.reassignPrimaryBeforeRemoval",
  program_required: "admin.errors.programRequired",
  program_staff_conflict: "admin.errors.programStaffChanged",
  program_user_in_use: "admin.errors.staffInUse",
  program_user_not_found: "admin.errors.programUserUnavailable",
  provider_and_program_required: "admin.errors.leadProgramRequired",
  provider_has_no_active_sites: "admin.errors.providerNoSites",
  provider_manager_enrollment_conflict: "admin.errors.deviceChanged",
  provider_manager_enrollment_not_found: "admin.errors.deviceUnavailable",
  provider_manager_grant_already_active: "admin.enrollment.alreadyActive",
  provider_manager_grant_conflict: "admin.enrollment.conflict",
  provider_manager_grant_not_found: "admin.errors.managerInvitationUnavailable",
  provider_manager_not_found: "admin.errors.managerUnavailable",
  provider_manager_required: "admin.errors.badRequest",
  provider_site_limit_exceeded: "admin.errors.providerSiteLimit",
  reasons_required: "admin.errors.reasonsRequired",
  site_assignment_required: "admin.errors.siteAccessRequired",
  site_manager_not_found: "admin.errors.managerUnavailable",
  site_manager_required: "admin.errors.siteManagerRequired",
  site_not_found: "admin.errors.siteUnavailable",
  site_primary_contact_in_use: "admin.programs.reassignPrimaryBeforeRemoval",
  site_reassignment_conflict: "admin.errors.siteChanged",
  site_revocation_conflict: "admin.errors.revocationChanged",
  site_user_assignment_conflict: "admin.errors.siteUsersChanged",
  stale_preview: "admin.errors.importStale",
  supervisor_required: "admin.errors.supervisorRequired",
  terms_close_conflict: "admin.errors.termsChanged",
  terms_write_conflict: "admin.errors.termsChanged",
  token_exchange_failed: "admin.errors.loginFailed",
  token_refresh_failed: "admin.errors.loginFailed",
  too_many_compliance_managers: "admin.oversight.managerLimit",
  unsupported_profile_field: "admin.errors.badRequest",
  user_required: "admin.errors.badRequest",
  username_required: "admin.errors.badRequest",
  valid_name_required: "admin.errors.validName",
  valid_phone_required: "admin.profile.invalidPhone",
  verified_contact_required: "admin.errors.unverifiedContact",
  admin_request_failed: "admin.toast.requestFailed",
};

// Errors whose text the app wrote for staff; anything else could be an API code or browser English.
/** @type {WeakSet<object>} */
const appWritten = new WeakSet();

/**
 * An error whose message staff may read as is, such as text from t().
 * @param {string} text
 * @returns {Error}
 */
export function appMessageError(text) {
  const error = new Error(text);
  appWritten.add(error);
  return error;
}

export function adminErrorMessage(error, t, fallback) {
  const key = messages[error?.message];
  if (typeof key === "string") return t(key);
  // App-written text names the actual problem; a form's fallback is only generic.
  if (error && appWritten.has(error)) return error.message;
  if (fallback) return fallback;
  return t("admin.toast.requestFailed");
}

/**
 * <admin-app>'s error line text. Only known codes and appMessageError() text show;
 * anything else, such as a sign-in callback's own words, shows the generic message.
 * @param {Error | string} error a sign-in callback sends a bare string
 * @param {(key: string) => string} t
 */
export function errorLineText(error, t) {
  const message = typeof error === "string" ? error : error?.message;
  if (!message) return "";
  return adminErrorMessage(typeof error === "string" ? { message } : error, t);
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
