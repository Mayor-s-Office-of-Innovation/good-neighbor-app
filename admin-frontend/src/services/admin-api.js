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
    const err = new Error(body.error || "admin_request_failed");
    // Some routes (analytics) explain the failure; surface it for the UI.
    if (typeof body.message === "string") {
      /** @type {any} */ (err).detail = body.message;
    }
    throw err;
  }
  return body;
}

export const adminApi = {
  listProviders: () => adminFetch("/admin/v1/providers"),
  listPrograms: () => adminFetch("/admin/v1/programs"),
  createProgram: (values) =>
    adminFetch("/admin/v1/programs", {
      method: "POST",
      body: JSON.stringify(values),
    }),
  getProgram: (programId) =>
    adminFetch(`/admin/v1/programs/${encodeURIComponent(programId)}`),
  updateProgram: (programId, values) =>
    adminFetch(`/admin/v1/programs/${encodeURIComponent(programId)}`, {
      method: "PATCH",
      body: JSON.stringify(values),
    }),
  deactivateProgram: (programId) =>
    adminFetch(`/admin/v1/programs/${encodeURIComponent(programId)}`, {
      method: "DELETE",
    }),
  createProgramUser: (programId, values) =>
    adminFetch(`/admin/v1/programs/${encodeURIComponent(programId)}/users`, {
      method: "POST",
      body: JSON.stringify(values),
    }),
  updateProgramUser: (programId, userId, values) =>
    adminFetch(
      `/admin/v1/programs/${encodeURIComponent(programId)}/users/${encodeURIComponent(userId)}`,
      {
        method: "PATCH",
        body: JSON.stringify(values),
      },
    ),
  deactivateProgramUser: (programId, userId) =>
    adminFetch(
      `/admin/v1/programs/${encodeURIComponent(programId)}/users/${encodeURIComponent(userId)}`,
      { method: "DELETE" },
    ),
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
  createSite: (providerId, { name, address, leadProgramId }) =>
    adminFetch(`/admin/v1/providers/${encodeURIComponent(providerId)}/sites`, {
      method: "POST",
      body: JSON.stringify({ name, address, leadProgramId }),
    }),
  getSite: (siteId) =>
    adminFetch(`/admin/v1/sites/${encodeURIComponent(siteId)}`),
  updateSite: (siteId, values) =>
    adminFetch(`/admin/v1/sites/${encodeURIComponent(siteId)}`, {
      method: "PATCH",
      body: JSON.stringify(values),
    }),
  reassignSite: (siteId, providerId, leadProgramId) =>
    adminFetch(`/admin/v1/sites/${encodeURIComponent(siteId)}/reassign`, {
      method: "POST",
      body: JSON.stringify({ providerId, leadProgramId }),
    }),
  assignSiteUser: (siteId, userId, primary = false) =>
    adminFetch(`/admin/v1/sites/${encodeURIComponent(siteId)}/users`, {
      method: "POST",
      body: JSON.stringify({ userId, primary }),
    }),
  unassignSiteUser: (siteId, userId) =>
    adminFetch(
      `/admin/v1/sites/${encodeURIComponent(siteId)}/users/${encodeURIComponent(userId)}`,
      { method: "DELETE" },
    ),
  listSiteTerms: (siteId) =>
    adminFetch(`/admin/v1/sites/${encodeURIComponent(siteId)}/terms`),
  createSiteTerms: (siteId, values) =>
    adminFetch(`/admin/v1/sites/${encodeURIComponent(siteId)}/terms`, {
      method: "POST",
      body: JSON.stringify(values),
    }),
  getSitePerimeter: (siteId) =>
    adminFetch(`/admin/v1/sites/${encodeURIComponent(siteId)}/perimeter`),
  updateSitePerimeter: (siteId, perimeter, expectedUpdatedAt) =>
    adminFetch(`/admin/v1/sites/${encodeURIComponent(siteId)}/perimeter`, {
      method: "PUT",
      body: JSON.stringify({ perimeter, expectedUpdatedAt }),
    }),
  previewSiteImport: (fileName, csv) =>
    adminFetch("/admin/v1/site-imports/preview", {
      method: "POST",
      body: JSON.stringify({ fileName, csv }),
    }),
  applySiteImport: (importId, previewVersion, idempotencyKey) =>
    adminFetch(`/admin/v1/site-imports/${encodeURIComponent(importId)}/apply`, {
      method: "POST",
      body: JSON.stringify({ previewVersion, idempotencyKey }),
    }),
  getSiteImport: (importId) =>
    adminFetch(`/admin/v1/site-imports/${encodeURIComponent(importId)}`),
  downloadSiteImportConflicts: async (importId) => {
    const config = getAdminConfig();
    const token = getAdminToken();
    const response = await fetch(
      `${config.apiBase}/admin/v1/site-imports/${encodeURIComponent(importId)}/conflicts.csv`,
      {
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(config.localDebugAdmin
            ? {
                "x-debug-groups": "central-admin",
                "x-debug-sub": "local-admin",
              }
            : {}),
        },
      },
    );
    if (!response.ok) throw new Error("conflict_report_failed");
    return response.blob();
  },
  presignComplianceLetter: (siteId, file) =>
    adminFetch(
      `/admin/v1/sites/${encodeURIComponent(siteId)}/compliance-letters:presign`,
      {
        method: "POST",
        body: JSON.stringify({
          contentType: "application/pdf",
          size: file.size,
          fileName: file.name,
        }),
      },
    ),
  uploadComplianceLetter: async (uploadUrl, file) => {
    const response = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "content-type": "application/pdf" },
      body: file,
    });
    if (!response.ok) throw new Error("compliance_letter_upload_failed");
  },
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
  issueSetupCode: (siteId, email, accessLevel = "general") =>
    adminFetch(`/admin/v1/sites/${encodeURIComponent(siteId)}/setup-codes`, {
      method: "POST",
      body: JSON.stringify({ email, accessLevel }),
    }),
  listDevices: (siteId) =>
    adminFetch(`/admin/v1/sites/${encodeURIComponent(siteId)}/devices`),
  revokeDevice: (siteId, deviceId) =>
    adminFetch(
      `/admin/v1/sites/${encodeURIComponent(siteId)}/devices/${encodeURIComponent(deviceId)}`,
      { method: "DELETE" },
    ),
  // Analytics (ADR 0013): the reporting lake, never the app database.
  /** The canned query catalog. */
  analyticsCatalog: () => adminFetch("/admin/v1/analytics/queries"),
  /**
   * Run one catalog query with parameters.
   * @param {string} queryId
   * @param {Record<string, string | number>} params
   * @returns {Promise<{ columns: string[], rows: unknown[][], truncated: boolean, elapsedMs: number, asOf: string | null }>}
   */
  analyticsRun: (queryId, params) =>
    adminFetch(`/admin/v1/analytics/queries/${encodeURIComponent(queryId)}`, {
      method: "POST",
      body: JSON.stringify({ params }),
    }),
  /**
   * Run raw read-only SQL (the advanced panel).
   * @param {string} sql
   * @returns {Promise<{ columns: string[], rows: unknown[][], truncated: boolean, elapsedMs: number, asOf: string | null }>}
   */
  analyticsQuery: (sql) =>
    adminFetch("/admin/v1/analytics/query", {
      method: "POST",
      body: JSON.stringify({ sql }),
    }),
};
