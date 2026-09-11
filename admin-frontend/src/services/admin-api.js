import { getAdminToken } from "./admin-auth.js";
import { getAdminConfig } from "../config.js";

/**
 * @param {string} path
 * @param {RequestInit} [init]
 */
async function adminFetch(path, init = {}) {
  const config = getAdminConfig();
  const token = getAdminToken();
  const res = await fetch(`${config.apiBase}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(config.localDebugAdmin
        ? {
            "x-debug-groups": "central-admin",
            "x-debug-sub": "local-admin",
          }
        : {}),
      ...(init.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error || "admin_request_failed");
  }
  return body;
}

export const adminApi = {
  listProviders: () => adminFetch("/admin/v1/providers"),
  createProvider: (name) =>
    adminFetch("/admin/v1/providers", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  deactivateProvider: (providerId) =>
    adminFetch(`/admin/v1/providers/${encodeURIComponent(providerId)}`, {
      method: "DELETE",
    }),
  getProvider: (providerId) =>
    adminFetch(`/admin/v1/providers/${encodeURIComponent(providerId)}`),
  createSite: (providerId, name) =>
    adminFetch(`/admin/v1/providers/${encodeURIComponent(providerId)}/sites`, {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  getSite: (siteId) =>
    adminFetch(`/admin/v1/sites/${encodeURIComponent(siteId)}`),
  deactivateSite: (siteId) =>
    adminFetch(`/admin/v1/sites/${encodeURIComponent(siteId)}`, {
      method: "DELETE",
    }),
  listMasterContacts: (siteId) =>
    adminFetch(`/admin/v1/sites/${encodeURIComponent(siteId)}/master-contacts`),
  addMasterContact: (siteId, email, name) =>
    adminFetch(
      `/admin/v1/sites/${encodeURIComponent(siteId)}/master-contacts`,
      {
        method: "POST",
        body: JSON.stringify({ email, name }),
      },
    ),
  removeMasterContact: (siteId, emailHash) =>
    adminFetch(
      `/admin/v1/sites/${encodeURIComponent(siteId)}/master-contacts/${encodeURIComponent(emailHash)}`,
      { method: "DELETE" },
    ),
  issueSetupCode: (siteId, email) =>
    adminFetch(`/admin/v1/sites/${encodeURIComponent(siteId)}/setup-codes`, {
      method: "POST",
      body: JSON.stringify({ email }),
    }),
  listDevices: (siteId) =>
    adminFetch(`/admin/v1/sites/${encodeURIComponent(siteId)}/devices`),
  revokeDevice: (siteId, deviceId) =>
    adminFetch(
      `/admin/v1/sites/${encodeURIComponent(siteId)}/devices/${encodeURIComponent(deviceId)}`,
      { method: "DELETE" },
    ),
};
