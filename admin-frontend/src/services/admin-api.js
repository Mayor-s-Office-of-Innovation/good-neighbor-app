import { localRoleHeaders } from "../local-role.js";
import { getFreshAdminToken, startAdminLogin } from "./admin-auth.js";
import { getAdminConfig } from "../config.js";

let loginRedirect = null;

function redirectToLogin() {
  if (!loginRedirect) {
    loginRedirect = startAdminLogin()
      // Navigation replaces this page. Keep its operations pending so their
      // success/error handlers cannot render a banner or toast during redirect.
      .then(() => new Promise(() => {}))
      .catch((error) => {
        loginRedirect = null;
        throw error;
      });
  }
  return loginRedirect;
}

/**
 * @param {string} path
 * @param {RequestInit} [init]
 */
async function authenticatedFetch(path, init = {}) {
  const config = getAdminConfig();
  if (loginRedirect) return loginRedirect;
  const token = await getFreshAdminToken();
  if (!config.localDebugAdmin && !token) return redirectToLogin();
  const res = await fetch(`${config.apiBase}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...localRoleHeaders(config),
      ...(init.headers || {}),
    },
  });
  if (!config.localDebugAdmin && res.status === 401) return redirectToLogin();
  return res;
}

/** @param {string} path @param {RequestInit} [init] */
async function adminFetch(path, init = {}) {
  const res = await authenticatedFetch(path, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || "admin_request_failed");
    /** @type {any} */ (err).status = res.status;
    // Some routes (analytics) explain the failure; surface it for the UI.
    if (typeof body.message === "string") {
      /** @type {any} */ (err).detail = body.message;
    }
    throw err;
  }
  return body;
}

export const adminApi = {
  revokeManagerDevices: (programId, userId, confirmation) =>
    adminFetch(
      `/admin/v1/programs/${encodeURIComponent(programId)}/users/${encodeURIComponent(userId)}/devices:revoke`,
      { method: "POST", body: JSON.stringify({ confirmation }) },
    ),
  getMyProfile: () => adminFetch("/admin/v1/profile"),
  updateMyProfile: (values) =>
    adminFetch("/admin/v1/profile", {
      method: "PUT",
      body: JSON.stringify(values),
    }),
  getSession: () => adminFetch("/admin/v1/session"),
  listAdminUsers: () => adminFetch("/admin/v1/admin-users"),
  inviteAdminUser: (values) =>
    adminFetch("/admin/v1/admin-users", {
      method: "POST",
      body: JSON.stringify(values),
    }),
  updateAdminUserRole: (username, role) =>
    adminFetch(`/admin/v1/admin-users/${encodeURIComponent(username)}/role`, {
      method: "PUT",
      body: JSON.stringify({ role }),
    }),
  suspendAdminUser: (username) =>
    adminFetch(
      `/admin/v1/admin-users/${encodeURIComponent(username)}/suspend`,
      {
        method: "POST",
      },
    ),
  reinstateAdminUser: (username) =>
    adminFetch(
      `/admin/v1/admin-users/${encodeURIComponent(username)}/reinstate`,
      {
        method: "POST",
      },
    ),
  reinviteAdminUser: (username) =>
    adminFetch(
      `/admin/v1/admin-users/${encodeURIComponent(username)}/reinvite`,
      { method: "POST" },
    ),
  resetAdminUserPassword: (username) =>
    adminFetch(
      `/admin/v1/admin-users/${encodeURIComponent(username)}/reset-password`,
      { method: "POST" },
    ),
  suggestAddresses: (query, signal) =>
    adminFetch("/admin/v1/address-suggestions", {
      method: "POST",
      body: JSON.stringify({ query }),
      signal,
    }),
  listProviders: () => adminFetch("/admin/v1/providers"),
  listPeople: () => adminFetch("/admin/v1/people"),
  createPerson: (values) =>
    adminFetch("/admin/v1/people", {
      method: "POST",
      body: JSON.stringify(values),
    }),
  updatePerson: (id, values) =>
    adminFetch(`/admin/v1/people/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(values),
    }),
  revokePersonDevices: (id, confirmation) =>
    adminFetch(`/admin/v1/people/${encodeURIComponent(id)}/devices:revoke`, {
      method: "POST",
      body: JSON.stringify({ confirmation }),
    }),
  transferProviderManager: (providerId, membershipId, targetId) =>
    adminFetch(
      `/admin/v1/providers/${encodeURIComponent(providerId)}/manager-memberships/${encodeURIComponent(membershipId)}/transfer`,
      { method: "POST", body: JSON.stringify({ providerId: targetId }) },
    ),
  assignPersonToSite: (siteId, person) =>
    adminFetch(
      `/admin/v1/sites/${encodeURIComponent(siteId)}/manager-memberships`,
      {
        method: "POST",
        body: JSON.stringify({
          personId: person.personId,
          name: person.name,
          email: person.email,
        }),
      },
    ),
  listPrograms: () => adminFetch("/admin/v1/programs"),
  listCityProgramManagers: () => adminFetch("/admin/v1/program-managers"),
  createCityProgramManager: (values) =>
    adminFetch("/admin/v1/program-managers", {
      method: "POST",
      body: JSON.stringify(values),
    }),
  updateCityProgramManager: (userId, values) =>
    adminFetch(`/admin/v1/program-managers/${encodeURIComponent(userId)}`, {
      method: "PATCH",
      body: JSON.stringify(values),
    }),
  listOversightOptions: () => adminFetch("/admin/v1/oversight-options"),
  createOversightOption: (values) =>
    adminFetch("/admin/v1/oversight-options", {
      method: "POST",
      body: JSON.stringify(values),
    }),
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
  removeSiteManager: (programId, userId) =>
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
  listProviderManagers: (providerId) =>
    adminFetch(
      `/admin/v1/providers/${encodeURIComponent(providerId)}/manager-memberships`,
    ),
  createProviderManager: (providerId, values) =>
    adminFetch(
      `/admin/v1/providers/${encodeURIComponent(providerId)}/manager-memberships`,
      { method: "POST", body: JSON.stringify(values) },
    ),
  updateProviderManager: (providerId, membershipId, values) =>
    adminFetch(
      `/admin/v1/providers/${encodeURIComponent(providerId)}/manager-memberships/${encodeURIComponent(membershipId)}`,
      { method: "PATCH", body: JSON.stringify(values) },
    ),
  deactivateProviderManager: (providerId, membershipId) =>
    adminFetch(
      `/admin/v1/providers/${encodeURIComponent(providerId)}/manager-memberships/${encodeURIComponent(membershipId)}`,
      { method: "DELETE" },
    ),
  reinstateProviderManager: (providerId, membershipId) =>
    adminFetch(
      `/admin/v1/providers/${encodeURIComponent(providerId)}/manager-memberships/${encodeURIComponent(membershipId)}/reinstate`,
      { method: "POST" },
    ),
  listProviderManagerGrants: (providerId) =>
    adminFetch(`/admin/v1/providers/${encodeURIComponent(providerId)}/grants`),
  createProviderManagerGrant: (
    providerId,
    membershipId,
    deliveryMode = "link",
  ) =>
    adminFetch(
      `/admin/v1/providers/${encodeURIComponent(providerId)}/manager-grants`,
      { method: "POST", body: JSON.stringify({ membershipId, deliveryMode }) },
    ),
  cancelProviderManagerGrant: (providerId, grantId) =>
    adminFetch(
      `/admin/v1/providers/${encodeURIComponent(providerId)}/grants/${encodeURIComponent(grantId)}`,
      { method: "DELETE" },
    ),
  revokeProviderManagerEnrollment: (providerId, enrollmentId) =>
    adminFetch(
      `/admin/v1/providers/${encodeURIComponent(providerId)}/manager-enrollments/${encodeURIComponent(enrollmentId)}/revoke`,
      { method: "POST" },
    ),
  updateProvider: (providerId, values) =>
    adminFetch(`/admin/v1/providers/${encodeURIComponent(providerId)}`, {
      method: "PATCH",
      body: JSON.stringify(values),
    }),
  assignProgramToProvider: (providerId, programId) =>
    adminFetch(
      `/admin/v1/providers/${encodeURIComponent(providerId)}/programs`,
      {
        method: "POST",
        body: JSON.stringify({ programId }),
      },
    ),
  createSite: (providerId, values) =>
    adminFetch(`/admin/v1/providers/${encodeURIComponent(providerId)}/sites`, {
      method: "POST",
      body: JSON.stringify(values),
    }),
  getSite: (siteId, rosterOnly = false) =>
    adminFetch(
      `/admin/v1/sites/${encodeURIComponent(siteId)}${rosterOnly ? "?roster=1" : ""}`,
    ),
  updateSite: (siteId, values) =>
    adminFetch(`/admin/v1/sites/${encodeURIComponent(siteId)}`, {
      method: "PATCH",
      body: JSON.stringify(values),
    }),
  reassignSite: (siteId, providerId, leadProgramId, options = {}) =>
    adminFetch(`/admin/v1/sites/${encodeURIComponent(siteId)}/reassign`, {
      method: "POST",
      body: JSON.stringify({ providerId, leadProgramId, ...options }),
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
  resendSiteLetter: (siteId, requestId) =>
    adminFetch(`/admin/v1/sites/${encodeURIComponent(siteId)}/letter:resend`, {
      method: "POST",
      body: JSON.stringify({ requestId }),
    }),
  listSiteTerms: (siteId) =>
    adminFetch(`/admin/v1/sites/${encodeURIComponent(siteId)}/terms`),
  createSiteTerms: (siteId, values) =>
    adminFetch(`/admin/v1/sites/${encodeURIComponent(siteId)}/terms`, {
      method: "POST",
      body: JSON.stringify(values),
    }),
  endSiteTerms: (siteId) =>
    adminFetch(`/admin/v1/sites/${encodeURIComponent(siteId)}/terms:close`, {
      method: "POST",
    }),
  replaceSiteComplianceManagers: (siteId, managerIds) =>
    adminFetch(
      `/admin/v1/sites/${encodeURIComponent(siteId)}/compliance-managers`,
      {
        method: "PUT",
        body: JSON.stringify({ managerIds }),
      },
    ),
  getSitePerimeter: (siteId) =>
    adminFetch(`/admin/v1/sites/${encodeURIComponent(siteId)}/perimeter`),
  updateSitePerimeter: (siteId, perimeter, expectedUpdatedAt) =>
    adminFetch(`/admin/v1/sites/${encodeURIComponent(siteId)}/perimeter`, {
      method: "PUT",
      body: JSON.stringify({ perimeter, expectedUpdatedAt }),
    }),
  listManagerMemberships: (siteId) =>
    adminFetch(
      `/admin/v1/sites/${encodeURIComponent(siteId)}/manager-memberships`,
    ),
  createManagerMembership: (siteId, name, email, programId = "", userId = "") =>
    adminFetch(
      `/admin/v1/sites/${encodeURIComponent(siteId)}/manager-memberships`,
      {
        method: "POST",
        body: JSON.stringify({ name, email, programId, userId }),
      },
    ),
  updateManagerMembership: (siteId, membershipId, name, email) =>
    adminFetch(
      `/admin/v1/sites/${encodeURIComponent(siteId)}/manager-memberships/${encodeURIComponent(membershipId)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ name, email }),
      },
    ),
  deactivateManagerMembership: (siteId, membershipId) =>
    adminFetch(
      `/admin/v1/sites/${encodeURIComponent(siteId)}/manager-memberships/${encodeURIComponent(membershipId)}`,
      { method: "DELETE" },
    ),
  listManagerGrants: (siteId) =>
    adminFetch(`/admin/v1/sites/${encodeURIComponent(siteId)}/grants`),
  createManagerGrant: (siteId, membershipId, deliveryMode = "link") =>
    adminFetch(`/admin/v1/sites/${encodeURIComponent(siteId)}/manager-grants`, {
      method: "POST",
      body: JSON.stringify({ membershipId, deliveryMode }),
    }),
  cancelManagerGrant: (siteId, grantId) =>
    adminFetch(
      `/admin/v1/sites/${encodeURIComponent(siteId)}/grants/${encodeURIComponent(grantId)}`,
      { method: "DELETE" },
    ),
  previewSiteImport: (fileName, csv) =>
    adminFetch("/admin/v1/site-imports/preview", {
      method: "POST",
      body: JSON.stringify({ fileName, csv }),
    }),
  listSiteImports: () => adminFetch("/admin/v1/site-imports"),
  applySiteImport: (importId, previewVersion, idempotencyKey) =>
    adminFetch(`/admin/v1/site-imports/${encodeURIComponent(importId)}/apply`, {
      method: "POST",
      body: JSON.stringify({ previewVersion, idempotencyKey }),
    }),
  getSiteImport: (importId) =>
    adminFetch(`/admin/v1/site-imports/${encodeURIComponent(importId)}`),
  downloadSiteImportConflicts: async (importId) => {
    const response = await authenticatedFetch(
      `/admin/v1/site-imports/${encodeURIComponent(importId)}/conflicts.csv`,
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
  revokeSelectedDeviceBindings: (siteId, bindingIds) =>
    adminFetch(
      `/admin/v1/sites/${encodeURIComponent(siteId)}/device-bindings:revoke`,
      {
        method: "POST",
        body: JSON.stringify({ bindingIds }),
      },
    ),
  revokeAllSiteDeviceBindings: (siteId, confirmation) =>
    adminFetch(
      `/admin/v1/sites/${encodeURIComponent(siteId)}/device-bindings:revoke-all`,
      {
        method: "POST",
        body: JSON.stringify({ confirmation }),
      },
    ),
  suspendDeviceBinding: (siteId, bindingId, reason) =>
    adminFetch(
      `/admin/v1/sites/${encodeURIComponent(siteId)}/device-bindings/${encodeURIComponent(bindingId)}/suspend`,
      {
        method: "POST",
        body: JSON.stringify({ reason }),
      },
    ),
  getPhysicalDevice: (physicalDeviceId) =>
    adminFetch(
      `/admin/v1/physical-devices/${encodeURIComponent(physicalDeviceId)}`,
    ),
  revokePhysicalDeviceEverywhere: (physicalDeviceId, confirmation) =>
    adminFetch(
      `/admin/v1/physical-devices/${encodeURIComponent(physicalDeviceId)}/revoke`,
      {
        method: "POST",
        body: JSON.stringify({ confirmation }),
      },
    ),
  listEmergencyRevocationSites: () =>
    adminFetch("/admin/v1/emergency-site-revocations/sites"),
  previewEmergencySiteRevocation: (siteIds) =>
    adminFetch("/admin/v1/emergency-site-revocations:preview", {
      method: "POST",
      body: JSON.stringify({ siteIds }),
    }),
  startEmergencySiteRevocation: (siteIds, confirmation) =>
    adminFetch("/admin/v1/emergency-site-revocations", {
      method: "POST",
      body: JSON.stringify({ siteIds, confirmation }),
    }),
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
