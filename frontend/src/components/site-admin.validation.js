/** @param {unknown} value */
const text = (value) => String(value || "").trim();

/** @param {string} value */
export function formatAdminDate(value) {
  if (!value) return "Present";
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      }).format(date);
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
    return "First and last name are required.";
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text(value.email))) {
    return "Enter a correctly formed email address.";
  }
  const digits = text(value.phone).replace(/\D/g, "");
  if (!(digits.length === 10 || (digits.length === 11 && digits[0] === "1"))) {
    return "Enter a valid US phone number.";
  }
  return "";
}

/** @param {Record<string, any>} value */
export function validateSiteDetails(value) {
  const address = value.address || {};
  if (!text(value.name)) return "Site name is required.";
  if (
    !text(address.streetNumber) ||
    !text(address.streetAddress) ||
    !text(address.city)
  ) {
    return "Street number, street address, and city are required.";
  }
  if (!/^[A-Za-z]{2}$/.test(text(address.state))) {
    return "Enter a two-letter state abbreviation.";
  }
  if (!/^\d{5}(?:-\d{4})?$/.test(text(address.zip))) {
    return "Enter a valid ZIP code.";
  }
  return "";
}

/** @param {unknown} left @param {unknown} right */
export function valuesChanged(left, right) {
  return JSON.stringify(left) !== JSON.stringify(right);
}
