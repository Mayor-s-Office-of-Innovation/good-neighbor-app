// Transactional enrollment email catalog. Emails currently use English.
const en = {
  "enrollment.email.code":
    "Open the link below, then enter this enrollment code manually: {code}",
  "enrollment.email.confirm":
    "Open the link below, then choose Enroll this device. Opening the link alone does not activate your invitation.",
  "enrollment.email.expiry":
    "This invitation expires {expires} and enrolls one device for {scope} only. Do not forward it.",
};

/** @param {keyof typeof en} key @param {Record<string,string>} [values] */
export function t(key, values = {}) {
  return en[key].replace(/\{(\w+)\}/g, (_, name) => values[name] ?? "");
}
