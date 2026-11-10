// @vitest-environment node
import { test } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  adminErrorMessage,
  appMessageError,
  errorLineText,
} from "./admin-error-messages.js";
import { createActionFeedback } from "./action-feedback-core.js";

const en = JSON.parse(
  readFileSync(
    new URL("../../frontend/src/i18n/catalogs/en.json", import.meta.url),
    "utf8",
  ),
);
const t = (key) => en[key] ?? key;

for (const [code, title, message] of [
  ["provider_already_exists", "providerExistsTitle", "providerExists"],
  ["site_already_exists", "siteExistsTitle", "siteExists"],
  ["provider_manager_already_assigned", "staffAssignedTitle", "staffAssigned"],
  ["provider_manager_conflict", "staffChangedTitle", "staffChanged"],
]) {
  test(`${code} has consistent toast and inline recovery instructions`, () => {
    const error = Object.assign(new Error(code), { status: 409 });
    const notices = [];
    const feedback = createActionFeedback(
      "saved",
      (notice) => notices.push(notice),
      t,
    );
    feedback.failure(error);
    feedback.failure(error);
    assert.equal(notices.length, 1);
    assert.equal(notices[0].title, t(`admin.errors.${title}`));
    assert.equal(notices[0].message, t(`admin.errors.${message}`));
    assert.equal(adminErrorMessage(error, t), notices[0].message);
  });
}

test("staff validation is readable inline and does not create an extra toast", () => {
  for (const [code, key] of [
    ["provider_manager_name_required", "staffNameRequired"],
    ["valid_email_required", "emailRequired"],
    ["phone_required", "phoneRequired"],
    ["invalid_person_contact", "staffContact"],
  ]) {
    const error = Object.assign(new Error(code), { status: 400 });
    assert.equal(adminErrorMessage(error, t), t(`admin.errors.${key}`));
    const notices = [];
    createActionFeedback("saved", (notice) => notices.push(notice), t).failure(
      error,
    );
    assert.equal(notices.length, 0);
  }
});

test("unknown server errors do not leak codes or override partial-save messaging", () => {
  assert.equal(
    adminErrorMessage(
      Object.assign(new Error("database_internal_error"), { status: 500 }),
      t,
    ),
    t("admin.toast.requestFailed"),
  );
  const notices = [];
  const feedback = createActionFeedback(
    "saved",
    (notice) => notices.push(notice),
    t,
  );
  feedback.changed();
  feedback.failure(
    Object.assign(new Error("provider_manager_conflict"), { status: 409 }),
  );
  assert.equal(notices[0].title, t("admin.toast.partial"));
});

test("stale site settings explain how to recover instead of a generic failure", () => {
  const error = Object.assign(new Error("site_changed"), { status: 409 });
  assert.equal(adminErrorMessage(error, t), t("admin.errors.siteChanged"));
  assert.notEqual(adminErrorMessage(error, t), t("admin.toast.requestFailed"));
});

test("request rejections give localized recovery instructions", () => {
  for (const [code, status, key] of [
    ["request_blocked", 403, "requestBlocked"],
    ["request_too_large", 413, "requestTooLarge"],
  ]) {
    assert.equal(
      adminErrorMessage(Object.assign(new Error(code), { status }), t),
      t(`admin.errors.${key}`),
    );
  }
});

for (const locale of ["en", "es", "fil", "vi", "zh-Hant"]) {
  test(`CSV validation errors give specific recovery instructions in ${locale}`, () => {
    const catalog = JSON.parse(
      readFileSync(
        new URL(
          `../../frontend/src/i18n/catalogs/${locale}.json`,
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const t = (key) => catalog[key];
    for (const [code, key] of [
      ["invalid_encoding", "invalidEncoding"],
      ["unreadable_csv", "unreadableCsv"],
      ["invalid_headers", "invalidHeaders"],
      ["invalid_row_count", "invalidRowCount"],
    ]) {
      const error = Object.assign(new Error(code), { status: 400 });
      const message = adminErrorMessage(error, t);
      assert.equal(message, t(`admin.import.${key}`));
      assert.equal(typeof message, "string");
      assert.ok(message.length > 0);
      assert.notEqual(message, t("admin.toast.requestFailed"));
      assert.notEqual(message, code);
    }
  });
}

// Each of these codes used to show the generic text; each row pins its own message.
for (const [code, key] of [
  ["access_denied", "admin.errors.loginFailed"],
  ["admin_group_assignment_failed", "admin.errors.adminGroupFailed"],
  ["admin_user_change_in_progress", "admin.errors.adminUserBusy"],
  ["admin_user_exists", "admin.errors.adminUserExists"],
  ["admin_user_not_found", "admin.errors.adminUserUnavailable"],
  ["admin_user_suspended", "admin.errors.adminUserSuspended"],
  ["ambiguous_manager_identity", "admin.errors.managerAmbiguous"],
  ["boolean_required", "admin.errors.badRequest"],
  ["cannot_demote_self", "admin.errors.cannotDemoteSelf"],
  ["cannot_suspend_self", "admin.errors.cannotSuspendSelf"],
  ["cognito_not_configured", "admin.errors.userAccountsUnavailable"],
  [
    "compliance_manager_profile_required",
    "admin.errors.complianceProfileRequired",
  ],
  ["compliance_profile_conflict", "admin.errors.complianceProfileConflict"],
  ["confirmation_mismatch", "admin.errors.confirmationMismatch"],
  ["confirmation_required", "admin.errors.badRequest"],
  ["conflict_report_failed", "admin.errors.importConflictReport"],
  ["current_letter_changed", "admin.errors.letterChanged"],
  ["current_letter_required", "admin.errors.letterRequired"],
  ["device_binding_already_revoked", "admin.errors.deviceAlreadyRevoked"],
  ["device_binding_not_found", "admin.errors.deviceUnavailable"],
  ["device_not_found", "admin.errors.deviceUnavailable"],
  ["device_revocation_conflict", "admin.errors.deviceChanged"],
  ["device_suspension_conflict", "admin.errors.deviceChanged"],
  ["different_provider_required", "admin.errors.differentProvider"],
  ["edit_person_contact", "admin.errors.editPersonContact"],
  ["email_required", "admin.errors.emailRequired"],
  ["expected_version_required", "admin.errors.badRequest"],
  ["forbidden", "admin.errors.forbidden"],
  ["idempotency_key_conflict", "admin.errors.badRequest"],
  ["import_not_found", "admin.errors.importUnavailable"],
  ["invalid_address_query", "admin.errors.addressQueryLength"],
  ["invalid_binding_selection", "admin.errors.bindingSelection"],
  ["invalid_check_cadence", "admin.errors.checkCadence"],
  ["invalid_compliance_manager", "admin.errors.complianceManagerUnavailable"],
  ["invalid_delivery_channel", "admin.errors.badRequest"],
  ["invalid_delivery_mode", "admin.errors.badRequest"],
  ["invalid_device_binding", "admin.errors.badRequest"],
  ["invalid_expiry", "admin.errors.termsDateInvalid"],
  ["invalid_json", "admin.errors.badRequest"],
  ["invalid_login_state", "admin.errors.loginFailed"],
  ["invalid_manager_name", "admin.errors.managerNameInvalid"],
  ["invalid_oversight_option_type", "admin.errors.badRequest"],
  ["invalid_perimeter", "admin.errors.perimeterInvalid"],
  ["invalid_primary_contact", "admin.errors.badRequest"],
  ["invalid_program_staff", "admin.errors.badRequest"],
  ["invalid_request_id", "admin.errors.badRequest"],
  ["invalid_role", "admin.users.invalidRole"],
  ["invalid_site_selection", "admin.errors.siteSelection"],
  ["invalid_site_type", "admin.errors.badRequest"],
  ["invalid_suspension_reason", "admin.errors.suspensionReason"],
  ["invalid_terms_range", "admin.errors.termsDateInvalid"],
  ["invitation_not_pending", "admin.errors.invitationAccepted"],
  ["invitation_pending", "admin.errors.invitationPending"],
  ["last_active_supervisor", "admin.errors.lastSupervisor"],
  ["letter_email_unavailable", "admin.errors.letterEmailUnavailable"],
  [
    "manager_device_revocation_incomplete",
    "admin.errors.managerDevicesIncomplete",
  ],
  ["manager_grant_conflict", "admin.enrollment.conflict"],
  ["manager_grant_not_found", "admin.errors.managerInvitationUnavailable"],
  ["manager_membership_not_found", "admin.errors.managerUnavailable"],
  ["manager_membership_required", "admin.errors.badRequest"],
  ["manager_removal_conflict", "admin.errors.managerAccessChanged"],
  ["membership_binding_limit_exceeded", "admin.errors.managerDeviceLimit"],
  ["missing_admin_auth_config", "admin.errors.loginUnavailable"],
  ["multi_site_revocation_conflict", "admin.errors.revocationChanged"],
  ["no_active_checks_period", "admin.errors.termsNotActive"],
  ["oversight_option_exists", "admin.errors.oversightOptionExists"],
  ["perimeter_required", "admin.errors.perimeterRequired"],
  ["perimeter_update_conflict", "admin.errors.perimeterChanged"],
  ["person_migration_required", "admin.errors.personMigrationRequired"],
  ["person_source_conflict", "admin.errors.personChanged"],
  ["person_update_limit_exceeded", "admin.errors.personUpdateLimit"],
  ["physical_device_binding_limit_exceeded", "admin.errors.deviceLimit"],
  ["physical_device_not_found", "admin.errors.deviceUnavailable"],
  ["physical_device_revocation_conflict", "admin.errors.deviceChanged"],
  ["profile_change_in_progress", "admin.errors.profileBusy"],
  ["profile_identity_mismatch", "admin.errors.profileIdentityMismatch"],
  ["profile_recovery_pending", "admin.errors.profileBusy"],
  ["program_has_sites", "admin.errors.programHasSites"],
  ["program_manager_directory_sync_failed", "admin.errors.programManagerSync"],
  ["program_manager_not_found", "admin.errors.programManagerUnavailable"],
  ["program_manager_required", "admin.errors.programManagerRequired"],
  [
    "program_primary_contact_in_use",
    "admin.programs.reassignPrimaryBeforeRemoval",
  ],
  ["program_required", "admin.errors.programRequired"],
  ["program_staff_conflict", "admin.errors.programStaffChanged"],
  ["program_user_in_use", "admin.errors.staffInUse"],
  ["program_user_not_found", "admin.errors.programUserUnavailable"],
  ["provider_and_program_required", "admin.errors.leadProgramRequired"],
  ["provider_has_no_active_sites", "admin.errors.providerNoSites"],
  ["provider_manager_enrollment_conflict", "admin.errors.deviceChanged"],
  ["provider_manager_enrollment_not_found", "admin.errors.deviceUnavailable"],
  ["provider_manager_grant_already_active", "admin.enrollment.alreadyActive"],
  ["provider_manager_grant_conflict", "admin.enrollment.conflict"],
  [
    "provider_manager_grant_not_found",
    "admin.errors.managerInvitationUnavailable",
  ],
  ["provider_manager_not_found", "admin.errors.managerUnavailable"],
  ["provider_manager_required", "admin.errors.badRequest"],
  ["provider_site_limit_exceeded", "admin.errors.providerSiteLimit"],
  ["reasons_required", "admin.errors.reasonsRequired"],
  ["site_assignment_required", "admin.errors.siteAccessRequired"],
  ["site_manager_not_found", "admin.errors.managerUnavailable"],
  ["site_manager_required", "admin.errors.siteManagerRequired"],
  ["site_not_found", "admin.errors.siteUnavailable"],
  [
    "site_primary_contact_in_use",
    "admin.programs.reassignPrimaryBeforeRemoval",
  ],
  ["site_reassignment_conflict", "admin.errors.siteChanged"],
  ["site_revocation_conflict", "admin.errors.revocationChanged"],
  ["site_user_assignment_conflict", "admin.errors.siteUsersChanged"],
  ["stale_preview", "admin.errors.importStale"],
  ["supervisor_required", "admin.errors.supervisorRequired"],
  ["terms_close_conflict", "admin.errors.termsChanged"],
  ["terms_write_conflict", "admin.errors.termsChanged"],
  ["token_exchange_failed", "admin.errors.loginFailed"],
  ["token_refresh_failed", "admin.errors.loginFailed"],
  ["too_many_compliance_managers", "admin.oversight.managerLimit"],
  ["unsupported_profile_field", "admin.errors.badRequest"],
  ["user_required", "admin.errors.badRequest"],
  ["username_required", "admin.errors.badRequest"],
  ["valid_name_required", "admin.errors.validName"],
  ["valid_phone_required", "admin.profile.invalidPhone"],
  ["verified_contact_required", "admin.errors.unverifiedContact"],
]) {
  test(`${code} explains what went wrong and what to do next`, () => {
    const error = Object.assign(new Error(code), { status: 400 });
    assert.ok(en[key], `${key} is in the English catalog`);
    assert.equal(adminErrorMessage(error, t), en[key]);
  });
}

test("a translated message the app wrote shows as is, even with no spaces", () => {
  const zh = JSON.parse(
    readFileSync(
      new URL("../../frontend/src/i18n/catalogs/zh-Hant.json", import.meta.url),
      "utf8",
    ),
  );
  const timeout = zh["admin.errors.requestTimeout"];
  assert.equal(adminErrorMessage(appMessageError(timeout), t), timeout);
  assert.equal(errorLineText(appMessageError(timeout), t), timeout);
});

test("a message the app wrote shows instead of a form's generic fallback", () => {
  const timeout = t("admin.errors.requestTimeout");
  assert.equal(
    adminErrorMessage(appMessageError(timeout), t, "Form fallback"),
    timeout,
  );
});

test("text the app didn't write shows the generic message", () => {
  for (const error of [
    new Error("Something the server said"),
    new TypeError("Failed to fetch"),
    "Any sentence",
    "Failed to fetch",
  ])
    assert.equal(errorLineText(error, t), t("admin.toast.requestFailed"));
  assert.equal(
    errorLineText("access_denied", t),
    t("admin.errors.loginFailed"),
  );
});
