/*
  devices.js — device registration + token refresh client (Option 4 device
  auth, docs/adr/0010-device-token-auth.md). Pure services: they call the API
  and return the session; storage stays in db.js (the `site` record), and
  attach/refresh wiring lives in services/api.js.

  The device registers ONCE against the site code and must never need the code
  again — the code-holder (a manager) may be unavailable while workers use the
  device daily. After registration the session renews itself via the single-use
  rotating refresh token.
*/

// Same-origin everywhere (shared strategy with services/api.js): in dev the
// Vite proxy forwards `/v1/*` → the local API; in production the SPA and API
// share one CloudFront origin. Cast `import.meta`: Vite's env types aren't
// wired into this checkJs project.
const BASE = /** @type {any} */ (import.meta).env?.VITE_API_BASE ?? "";

/**
 * @typedef {object} DeviceSession
 * @property {string} deviceId
 * @property {{ siteId: string, name: string }} site
 * @property {string} token        the access token (JWT)
 * @property {string} refreshToken single-use, rotating (JWT)
 * @property {number} expiresIn    access-token TTL in seconds
 * @property {number} refreshExpiresIn refresh-token TTL in seconds
 * @property {number} tokenGeneration revocation counter this session was minted against
 */

/**
 * POST /v1/devices — register (or re-register after a wipe) this device against
 * a site code and mint its first session. `deviceId` is server-owned: pass a
 * previous id to re-register the same device, omit for a fresh device.
 * @param {string} code
 * @param {{ deviceId?: string, label?: string }} [opts]
 * @returns {Promise<DeviceSession>}
 * @throws {Error} "invalid site code" (401) or a network/5xx failure
 */
export async function registerDevice(code, opts = {}) {
  const res = await fetch(`${BASE}/v1/devices`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code,
      ...(opts.deviceId ? { deviceId: opts.deviceId } : {}),
      ...(opts.label ? { label: opts.label } : {}),
    }),
  });
  if (res.status === 401 || res.status === 404) {
    throw new Error("invalid site code");
  }
  if (!res.ok) {
    throw new Error(`device registration failed (${res.status})`);
  }
  const body = await res.json();
  assertSession(body);
  return body;
}

/**
 * POST /v1/devices/token:refresh — exchange the stored single-use refresh
 * token for a fresh session pair. The old refresh token is dead after this
 * call; the caller must persist the new one before doing anything else.
 * @param {string} refreshToken
 * @returns {Promise<DeviceSession>}
 * @throws {Error} "refresh rejected" (401 — expired/revoked/replayed) or a
 *   network/5xx failure
 */
export async function refreshDeviceToken(refreshToken) {
  const res = await fetch(`${BASE}/v1/devices/token:refresh`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refreshToken }),
  });
  if (!res.ok) {
    throw new Error("refresh rejected");
  }
  const body = await res.json();
  assertSession(body);
  return body;
}

/**
 * Shape-check the session the server returned; a malformed 2xx is a network-
 * grade failure, not something to store.
 * @param {any} body
 * @returns {void} throws on a malformed body
 */
function assertSession(body) {
  if (
    !body ||
    typeof body.deviceId !== "string" ||
    typeof body.token !== "string" ||
    typeof body.refreshToken !== "string" ||
    typeof body.expiresIn !== "number" ||
    !body.site?.siteId
  ) {
    throw new Error("malformed device session response");
  }
}
