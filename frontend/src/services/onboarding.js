/*
  Site-code login client. The backend owns whether a code exists, is active, and
  which provider site it binds to; the frontend only formats the prompt and stores
  the returned binding after a successful check.
*/

// Same-origin everywhere: in dev the Vite proxy forwards `/site-code` → the local
// API (no CORS — see vite.config.js); in production the SPA and API share one
// CloudFront distribution, so BASE stays "" and the call is relative. Setting
// VITE_API_BASE to a cross-origin URL would trip the connect-src 'self' CSP.
// Shared strategy with services/api.js. Cast `import.meta`: Vite's env types
// aren't wired into this checkJs project.
const BASE = /** @type {any} */ (import.meta).env?.VITE_API_BASE ?? "";

/**
 * @typedef {object} ProviderSite
 * @property {string} id
 * @property {string} siteId
 * @property {string} name
 */

/**
 * Validate a setup code against the backend.
 * @param {string} code
 * @returns {Promise<{ok:true, code:string, providerSite:ProviderSite} | {ok:false, reason:'empty'|'invalid'|'network'}>}
 */
export async function validateSetupCode(code) {
  const formatted = formatSiteCode(code);
  if (!formatted) {
    return { ok: false, reason: "empty" };
  }

  let response;
  try {
    response = await fetch(`${BASE}/site-code`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: formatted }),
    });
  } catch {
    return { ok: false, reason: "network" };
  }

  if (response.status === 401 || response.status === 404) {
    return { ok: false, reason: "invalid" };
  }
  if (!response.ok) {
    return { ok: false, reason: "network" };
  }

  const data = await response.json().catch(() => null);
  if (!data?.providerSite?.siteId || !data.providerSite.name) {
    return { ok: false, reason: "network" };
  }

  return {
    ok: true,
    code: String(data.code || formatted),
    providerSite: data.providerSite,
  };
}

/**
 * @typedef {object} SiteSearchResult
 * @property {string} siteId
 * @property {string} [providerSiteId]
 * @property {string} name
 * @property {string} [providerName]
 * @property {string} [label]
 */

/**
 * Search public-safe site names for the code request flow.
 * @param {string} query
 * @returns {Promise<{ok:true, sites:SiteSearchResult[]} | {ok:false, reason:'empty'|'network'}>}
 */
export async function searchSites(query) {
  const q = String(query || "").trim();
  if (q.length < 2) return { ok: false, reason: "empty" };

  let response;
  try {
    response = await fetch(
      `${BASE}/v1/sites:search?q=${encodeURIComponent(q)}`,
    );
  } catch {
    return { ok: false, reason: "network" };
  }

  if (!response.ok) return { ok: false, reason: "network" };
  const data = await response.json().catch(() => null);
  return {
    ok: true,
    sites: Array.isArray(data?.sites) ? data.sites : [],
  };
}

/**
 * Request a setup code email for an approved site contact.
 * @param {{ siteId: string, email: string }} request
 * @returns {Promise<{ok:true, message:string} | {ok:false, reason:'invalid'|'network'}>}
 */
export async function requestSetupCode({ siteId, email }) {
  if (!siteId || !isPlausibleEmail(email)) {
    return { ok: false, reason: "invalid" };
  }

  let response;
  try {
    response = await fetch(`${BASE}/v1/setup-codes:request`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ siteId, email }),
    });
  } catch {
    return { ok: false, reason: "network" };
  }

  if (response.status === 400) return { ok: false, reason: "invalid" };
  if (!response.ok) return { ok: false, reason: "network" };
  const data = await response.json().catch(() => null);
  return {
    ok: true,
    message:
      typeof data?.message === "string"
        ? data.message
        : "If that email is authorized for this site, we will send a new setup code.",
  };
}

/**
 * @param {string} code
 * @returns {string}
 */
export function formatSiteCode(code) {
  return String(code || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 6);
}

/**
 * @param {string} email
 * @returns {boolean}
 */
function isPlausibleEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
}
