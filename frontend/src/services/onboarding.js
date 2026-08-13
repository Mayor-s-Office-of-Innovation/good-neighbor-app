/*
  MOCK onboarding backend.

  In production, a site administrator receives an email containing a link to the
  app plus a one-time setup code tied to their location, e.g.

      https://<host>/gnp/?code=HCM-4820

  Opening the link (or typing the code) posts it to a backend, which validates it
  and returns the bound site. That gives lightweight identity assurance — the
  device is provably associated with a real location — WITHOUT a login, and the
  staffer never has to pick their site from a list.

  Phase 1 has no backend and doesn't send email, so this module fakes the
  validation exchange behind the same async shape the real endpoint will have.
  Swap the body for a fetch() later; callers don't change.
*/

// Sample code → site mappings, so the relationship is obviously data-driven.
// Per the Phase 1 mock, any non-empty code that isn't listed here still resolves
// to the default site rather than failing.
const CODE_TO_SITE = {
  "HCM-4820": "Health Center — Mission",
  "CH-1001": "City Hall",
  "LIB-2200": "Main Library",
};
const DEFAULT_SITE = "Health Center — Mission";

/**
 * Validate a setup code against the (mocked) backend.
 * @param {string} code
 * @returns {Promise<{ok:true, code:string, site:string} | {ok:false, reason:'empty'|'network'}>}
 */
export async function validateSetupCode(code) {
  const trimmed = String(code || "")
    .trim()
    .toUpperCase();
  await delay(650); // simulate a network round-trip so the UI shows its spinner
  if (!trimmed) return { ok: false, reason: "empty" };
  const site = CODE_TO_SITE[trimmed] || DEFAULT_SITE;
  return { ok: true, code: trimmed, site };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
