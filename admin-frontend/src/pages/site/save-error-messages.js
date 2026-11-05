// Turns Site, compliance period and Site manager save errors into messages,
// so users never see a raw API code.
import { adminErrorMessage } from "../../admin-error-messages.js";
import { t } from "../../../../frontend/src/i18n/i18n.js";

/**
 * @param {unknown} error
 * @returns {string}
 */
export function siteSaveErrorMessage(error) {
  const code = error instanceof Error ? error.message : "";
  if (code === "lead_program_required") {
    return "Choose a Lead program before saving.";
  }
  if (code === "site_creation_incomplete") {
    return "The Site was created, but its address, manager, or public contact was not fully saved. Reopen the Site and complete the missing fields.";
  }
  if (code === "invalid_public_contact") {
    return "Enter a valid public contact email and 10-digit phone number.";
  }
  if (code === "address_not_found") {
    return "We couldn't geocode this address. Check it and try again.";
  }
  if (code === "geocoding_unavailable") {
    return "The geocoding service is unavailable. Try again shortly.";
  }
  if (code === "address_required") {
    return "Enter an address before saving the site.";
  }
  if (code === "invalid_address") {
    return "Enter a complete address with a two-letter state and valid ZIP code.";
  }
  if (code === "invalid_contact_person") {
    return "Enter the contact's first and last name, a valid email, and a valid US phone number.";
  }
  if (code === "invalid_oversight") {
    return "Check the City program manager, department, and system of care.";
  }
  if (code === "valid_phone_required") {
    return "Enter a valid 10-digit City program manager phone number.";
  }
  if (code === "invalid_compliance") {
    return t("admin.compliance.checkInputs");
  }
  if (
    code === "invalid_compliance_letter" ||
    code === "pdf_required" ||
    code === "invalid_file_size"
  ) {
    return "Choose a PDF compliance letter no larger than 10 MB.";
  }
  if (code === "compliance_letter_upload_failed") {
    return "The compliance letter upload failed. Try again.";
  }
  if (code === "site_update_conflict") {
    return "Someone else updated this site. Reload it before saving your changes.";
  }
  return adminErrorMessage(error, t, t("admin.toast.requestFailed"));
}

export function compliancePeriodErrorMessage(error) {
  const code = error instanceof Error ? error.message : "";
  if (code === "generator_contact_required")
    return t("admin.compliance.generatorContactRequired", {
      profile: t("admin.profile.title"),
    });
  if (code === "generator_department_required")
    return t("admin.compliance.generatorDepartmentRequired");
  if (code === "expiry_required")
    return "Enter the last day checks are required for the selected reasons.";
  if (code === "letter_details_required")
    return "Complete the Site manager, address, department, and City program manager contact details before requiring checks.";
  if (code === "terms_overlap" || code === "terms_start_conflict")
    return "This compliance period overlaps another period for the Site.";
  return "The perimeter check compliance period couldn't be saved. Try again.";
}

export function managerSaveErrorMessage(error) {
  const code = error instanceof Error ? error.message : "";
  if (code === "first_name_required") return "Enter the manager's first name.";
  if (code === "last_name_required") return "Enter the manager's last name.";
  if (code === "valid_email_required" || code === "invalid_manager_email")
    return "Enter a valid contact email.";
  if (code === "phone_required") return "Enter a contact phone number.";
  if (code === "manager_membership_exists")
    return "This manager is already assigned to one of the selected Sites.";
  if (code === "manager_membership_conflict")
    return "A Site assignment changed. Reload the manager and try again.";
  return "The site manager couldn't be saved. Try again.";
}
