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
