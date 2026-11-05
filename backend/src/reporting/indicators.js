// Each indicator stands alone; nothing here combines them into a Site status.

import { activeCatalog } from "../analysis/guidance/catalog-registry.js";

// The plan's window, for Issues whose rule sets none.
const DEFAULT_RESPONSE_HOURS = 72;

// Tasks from before rules carried a window get the current rule's, as
// handlers/tasks.js does.
const RULE_HOURS = new Map(
  activeCatalog().rules.map((r) => [r.ruleId, r.maxAcceptableResponseHours]),
);

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

/**
 * @param {unknown} hours
 * @returns {hours is number}
 */
const isHours = (hours) =>
  typeof hours === "number" && Number.isFinite(hours) && hours >= 0;

// 0 turns the overdue check off, as the app does for "Call 911" rules.
/**
 * @param {{ maxAcceptableResponseHours?: unknown, ruleId?: string | null }} task
 * @returns {number}
 */
export function responseHours(task) {
  if (isHours(task.maxAcceptableResponseHours))
    return task.maxAcceptableResponseHours;
  const rule = task.ruleId ? RULE_HOURS.get(task.ruleId) : undefined;
  return isHours(rule) ? rule : DEFAULT_RESPONSE_HOURS;
}

/**
 * @param {string} createdAt
 * @param {number} hours 0 has no deadline
 * @returns {string | null}
 */
export function responseDeadline(createdAt, hours) {
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created) || !(hours > 0)) return null;
  return new Date(created + hours * 3_600_000).toISOString();
}

/** @typedef {"awaiting" | "overdue" | "onTime" | "late" | "unknown" | "notTimed"} ResponseState */

/**
 * As of the snapshot, never the reader's clock. `responded` counts any
 * response, timed or not.
 * @param {{ createdAt: string, firstResponseAt: string | null, responded: boolean, responseHours: number }} issue
 * @param {string} evaluatedAt
 * @returns {ResponseState}
 */
export function responseState(issue, evaluatedAt) {
  // The app never marks a 0-hour task overdue (domain/task-updates.js).
  if (issue.responseHours === 0) return "notTimed";
  const deadline = responseDeadline(issue.createdAt, issue.responseHours);
  if (!deadline) return "unknown";
  const now = Date.parse(evaluatedAt);
  const answered = issue.firstResponseAt
    ? Date.parse(issue.firstResponseAt)
    : NaN;
  if (Number.isFinite(answered) && answered <= now)
    return answered <= Date.parse(deadline) ? "onTime" : "late";
  // A response with no time can't be judged on time or late.
  if (issue.responded && !Number.isFinite(answered)) return "unknown";
  return now > Date.parse(deadline) ? "overdue" : "awaiting";
}

/**
 * @param {unknown} severity numeric 1–5
 * @returns {"minor" | "moderate" | "severe" | "unknown"}
 */
export function severityBand(severity) {
  if (severity === 1 || severity === 2) return "minor";
  if (severity === 3) return "moderate";
  if (severity === 4 || severity === 5) return "severe";
  return "unknown";
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
