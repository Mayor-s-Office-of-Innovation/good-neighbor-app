/*
  Site-code login client. The backend owns whether a code exists, is active, and
  which provider site it binds to; the frontend only formats the prompt and stores
  the returned binding after a successful check.
*/

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
    const apiUrl = apiBaseUrl();
    response = await fetch(`${apiUrl}/site-code`, {
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

function apiBaseUrl() {
  const env =
    /** @type {{ env?: { VITE_API_BASE_URL?: string } }} */ (import.meta).env ||
    {};
  const configured = env.VITE_API_BASE_URL;
  if (configured) return configured.replace(/\/$/, "");
  return isLocalHost() ? localDevApiBaseUrl() : "";
}

function localDevApiBaseUrl() {
  const host = globalThis.location?.hostname || "127.0.0.1";
  return `http://${host}:3001`;
}

function isLocalHost() {
  const host = globalThis.location?.hostname;
  return host === "127.0.0.1" || host === "localhost";
}
