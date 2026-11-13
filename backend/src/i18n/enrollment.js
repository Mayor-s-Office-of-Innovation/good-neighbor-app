// Transactional enrollment email catalog. Emails currently use English.
const en = {
  "enrollment.email.recovery":
    "Use the applicable link below to enroll as a Site Manager. Each link gives access to one Site and can be reused in another browser before it expires.",
  "enrollment.email.code":
    "Open the link below, then enter this enrollment code manually: {code}",
  "enrollment.email.confirm":
    "Open the link below, then choose Enroll this device. Opening the link alone does not activate your invitation.",
  "enrollment.email.expiry":
    "This invitation gives access to {scope} until {expires}. You can use it in another browser before it expires. Do not forward it.",
};

/** @param {keyof typeof en} key @param {Record<string,string>} [values] */
export function t(key, values = {}) {
  return en[key].replace(/\{(\w+)\}/g, (_, name) => values[name] ?? "");
}
