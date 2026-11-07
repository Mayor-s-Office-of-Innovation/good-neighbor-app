// Each indicator stands alone; nothing here combines them into a Site status.

// Same checks the app runs when staff save a contact (handlers/site.js).
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * @param {unknown} phone
 * @returns {boolean}
 */
function validPhone(phone) {
  const digits = text(phone).replace(/\D/g, "");
  return digits.length === 10 || (digits.length === 11 && digits[0] === "1");
}

/**
 * @param {unknown} email
 * @returns {boolean}
 */
function validEmail(email) {
  return EMAIL.test(text(email));
}

/** @typedef {{ state: "available" | "missing" | "unknown", reasonCodes: string[] }} ContactState */

// Needs a valid email and phone, as the policy asks of the public contact
// (support/policy.js, p. 3).
/**
 * @param {Record<string, any>} contact
 * @returns {ContactState}
 */
function contactState(contact) {
  /** @type {string[]} */
  const reasonCodes = [];
  if (!text(contact.email)) reasonCodes.push("no_email");
  else if (!validEmail(contact.email)) reasonCodes.push("invalid_email");
  if (!text(contact.phone)) reasonCodes.push("no_phone");
  else if (!validPhone(contact.phone)) reasonCodes.push("invalid_phone");
  if (!reasonCodes.length) return { state: "available", reasonCodes };
  // Site imports copy phones as typed, so a value the check rejects may
  // still reach someone; only a blank field is surely missing.
  const blank = reasonCodes.some((r) => r.startsWith("no_"));
  return { state: blank ? "missing" : "unknown", reasonCodes };
}

// Today's Site record, since there is no contact history.
/**
 * @param {Record<string, any> | null | undefined} site
 * @returns {ContactState}
 */
export function publicContactState(site) {
  if (!site) return { state: "unknown", reasonCodes: ["no_site_record"] };
  return contactState(site.publicContact ?? {});
}

// The copy the app keeps on the Site whenever its manager list changes
// (lib/site-primary-contact.js).
/**
 * @param {Record<string, any> | null | undefined} site
 * @returns {ContactState}
 */
export function siteContactState(site) {
  if (!site) return { state: "unknown", reasonCodes: ["no_site_record"] };
  const contact = site.primaryContact;
  if (!contact)
    return site.primaryContactUserId
      ? { state: "unknown", reasonCodes: ["contact_copy_missing"] }
      : { state: "missing", reasonCodes: ["no_site_contact"] };
  return contactState(contact);
}
