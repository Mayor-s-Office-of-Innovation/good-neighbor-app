import { formatDateTime } from "../i18n/dates.js";
import { t } from "../i18n/i18n.js";

/** @param {unknown} value */
const text = (value) => String(value || "").trim();

/** @param {string} value a calendar date, "YYYY-MM-DD" */
export function formatAdminDate(value) {
  if (!value) return t("siteAdmin.datePresent");
  // Anchor at noon Pacific so the Pacific-fixed formatter shows this calendar
  // day whatever the device's zone (DST shifts it by an hour at most).
  const date = new Date(`${value}T12:00:00-08:00`);
  return Number.isNaN(date.getTime())
    ? value
    : formatDateTime(date, {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
}

/** @param {unknown} value */
export function formatAdminPhone(value) {
  const original = text(value);
  const digits = original.replace(/\D/g, "");
  const national =
    digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (national.length !== 10) return original;
  return `${national.slice(0, 3)}-${national.slice(3, 6)}-${national.slice(6)}`;
}

/** @param {Array<Record<string, unknown>>} bindings */
export function formatDeviceEnrollmentSummary(bindings) {
  const count = bindings.filter(
    (binding) => binding.status === "active",
  ).length;
  if (count === 0) {
    return 'Click "Manage" to enroll new team member devices.';
  }
  const subject = count === 1 ? "1 device is" : `${count} devices are`;
  return `${subject} enrolled. Click "Manage" to revoke access or add new devices.`;
}

/** @param {Record<string, unknown>} value */
export function validateContact(value) {
  if (!text(value.firstName) || !text(value.lastName)) {
    return t("siteAdmin.validation.nameRequired");
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text(value.email))) {
    return t("siteAdmin.validation.email");
  }
  const digits = text(value.phone).replace(/\D/g, "");
  if (!(digits.length === 10 || (digits.length === 11 && digits[0] === "1"))) {
    return t("siteAdmin.validation.phone");
  }
  return "";
}

/** @param {Record<string, any>} value */
export function validateSiteDetails(value) {
  const address = value.address || {};
  if (!text(value.name)) return t("siteAdmin.validation.siteNameRequired");
  if (
    !text(address.streetNumber) ||
    !text(address.streetAddress) ||
    !text(address.city)
  ) {
    return t("siteAdmin.validation.addressRequired");
  }
  if (!/^[A-Za-z]{2}$/.test(text(address.state))) {
    return t("siteAdmin.validation.state");
  }
  if (!/^\d{5}(?:-\d{4})?$/.test(text(address.zip))) {
    return t("siteAdmin.validation.zip");
  }
  return "";
}

/** @param {unknown} left @param {unknown} right */
export function valuesChanged(left, right) {
  return JSON.stringify(left) !== JSON.stringify(right);
}
