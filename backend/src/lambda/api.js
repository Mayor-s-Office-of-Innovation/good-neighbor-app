import {
  getSystemStatus,
  getStatusEntries,
  getStatusMedia,
  getStatusDuplicate,
} from "../handlers/system-status.js";
import {
  listPeople,
  createPerson,
  updatePerson,
} from "../handlers/admin-people.js";
import {
  getDuplicateLinks,
  separateDuplicate,
} from "../handlers/duplicate-links.js";
import { get311Media } from "../integrations/sf311-media.js";
import { getDuplicateResult } from "../handlers/duplicate-results.js";
import {
  listCareWork,
  createCareWork,
  getCareWork,
  presignCarePhoto,
  getCarePhoto,
} from "../handlers/care-work.js";
// API Gateway (HTTP API v2) entrypoint for the whole check/artifact API. One
// Lambda backs every route; API Gateway sets `event.routeKey` to the matched
// route (e.g. "POST /v1/checks/{checkId}"), so we dispatch on it directly — no
// path-param regex needed (the gateway already matched). This table mirrors
// `scripts/local-api.mjs` (the in-process dev stand-in) and the Terraform
// `aws_apigatewayv2_route` set; keep all three in step.

import {
  createCheck,
  completeCheck,
  listChecks,
  getCaptureGuidance,
  getCheck,
} from "../handlers/checks.js";
import {
  presignUpload,
  registerArtifact,
  deleteArtifact,
  updateArtifactLocation,
  presignMedia,
} from "../handlers/artifacts.js";
import {
  createComplaint,
  deleteComplaint,
  deleteComplaintArtifact,
  getComplaint,
  listComplaints,
  presignComplaintArtifact,
  presignComplaintMedia,
  registerComplaintArtifact,
  retryComplaint,
} from "../handlers/complaints.js";
import {
  get311RequestDetail,
  get311RequestDetails,
  listTasks,
} from "../handlers/tasks.js";
import {
  createTaskUpdate,
  documentTaskUpdate,
  getTaskUpdates,
  registerTaskUpdateMedia,
} from "../handlers/task-updates.js";
import {
  completeTask,
  evaluateAssessment,
  getGuidance,
  submitConditionAnswers,
} from "../handlers/guidance.js";
import { handler as submissionsHandler } from "../handlers/submissions.js";
import { handler as healthHandler } from "../handlers/health.js";
import { handler as siteCodeHandler } from "../handlers/site-code.js";
import { registerDevice, refreshDeviceToken } from "../handlers/devices.js";
import { redeemEnrollmentGrant } from "../handlers/enrollment.js";
import {
  listDeviceBindings,
  selectDeviceBinding,
} from "../handlers/device-bindings.js";
import {
  issueSessionHandoff,
  redeemSessionHandoff,
  retireSessionHandoff,
} from "../handlers/session-handoff.js";
import {
  cancelStaffGrant,
  createStaffGrant,
  getCurrentStaffGrant,
  listGeneralBindings,
  revokeGeneralBinding,
} from "../handlers/manager-access.js";
import {
  getChecksReport,
  getTaskUpdatesReport,
  getTasksReport,
} from "../handlers/manager-reports.js";
import { requestManagerAccess } from "../handlers/manager-access-requests.js";
import { searchSites } from "../handlers/setup-code-requests.js";
import {
  getSite,
  getSiteAdmin,
  listProviderSites,
  updateSiteAdmin,
} from "../handlers/site.js";
import {
  editAnalysisCondition,
  rejectAnalysisCondition,
} from "../handlers/analysis-amendments.js";
import {
  createCityProgramManager,
  createProvider,
  createSite,
  deactivateProvider,
  deactivateSite,
  getAdminSite,
  getProvider,
  issueAdminSetupCode,
  listCityProgramManagers,
  listDevices,
  listProviders,
  presignComplianceLetter,
  reassignSite,
  revokeDevice,
  updateProvider,
  updateCityProgramManager,
  updateSite,
} from "../handlers/admin.js";
import {
  getAdminSession,
  getMyProfile,
  updateMyProfile,
  inviteAdminUser,
  listAdminUsers,
  reinviteAdminUser,
  reinstateAdminUser,
  resetAdminUserPassword,
  suspendAdminUser,
  updateAdminUserRole,
} from "../handlers/admin-users.js";
import {
  createOversightOption,
  listOversightOptions,
} from "../handlers/admin-oversight.js";
import { suggestAddresses } from "../handlers/admin-addresses.js";
import {
  revokeManagerDevices,
  getPhysicalDeviceRevocationPreview,
  revokeAllSiteDeviceBindings,
  revokePhysicalDeviceEverywhere,
  revokeSelectedDeviceBindings,
  suspendDeviceBinding,
} from "../handlers/admin-device-revocation.js";
import {
  listEmergencyRevocationSites,
  previewEmergencySiteRevocation,
  startEmergencySiteRevocation,
} from "../handlers/admin-multi-site-revocation.js";
import { jsonResponse } from "../http.js";
import {
  assignProgramToProvider,
  createProgramUser,
  createProgram,
  deactivateProgramUser,
  deactivateProgram,
  getProgram,
  listPrograms,
  updateProgramUser,
  updateProgram,
} from "../handlers/admin-programs.js";
import {
  assignSiteUser,
  createSiteTerms,
  endSiteTerms,
  resendSiteLetter,
  getSitePerimeter,
  listSiteTerms,
  putSitePerimeter,
  putSiteDeliberate311,
  replaceSiteComplianceManagers,
  unassignSiteUser,
} from "../handlers/admin-site-config.js";
import {
  createManagerMembership,
  deactivateManagerMembership,
  listManagerMemberships,
  updateManagerMembership,
} from "../handlers/admin-manager-memberships.js";
import {
  cancelManagerGrant,
  createManagerGrant,
  listManagerGrants,
} from "../handlers/admin-manager-grants.js";
import {
  cancelProviderManagerGrant,
  createProviderManager,
  createProviderManagerGrant,
  deactivateProviderManager,
  listProviderManagerGrants,
  listProviderManagers,
  reinstateProviderManager,
  revokeProviderManagerEnrollment,
  updateProviderManager,
  transferProviderManager,
} from "../handlers/admin-provider-managers.js";
import {
  applySiteImport,
  getSiteImport,
  getSiteImportConflicts,
  listSiteImports,
  previewSiteImport,
} from "../handlers/admin-site-imports.js";
import { withServerErrorsLogged } from "../lib/log-server-error.js";
import {
  getTaskDetails,
  recordCustomTaskAction,
  updateTaskAction,
} from "../handlers/task-details.js";

// Route key → handler. Keys are the API Gateway v2 route keys ("<METHOD> <path>").
// The individual handlers carry richer (event, context, callback) signatures; we
// only ever call them with the event, so the map is typed to that call shape.
const routes = /** @type {Record<string, (...args: any[]) => any>} */ ({
  "GET /v1/311-media": get311Media,
  "POST /site-code": siteCodeHandler,
  // Device bootstrap (Option 4 device auth — see docs/adr/0010): open routes,
  // no authorizer. Everything under /v1/* except these + the intakes is gated.
  "POST /v1/devices": registerDevice,
  "POST /v1/devices/token:refresh": refreshDeviceToken,
  "POST /app/v1/enrollment/redeem": redeemEnrollmentGrant,
  "POST /app/v1/manager-access/request": requestManagerAccess,
  "GET /app/v1/device-bindings": listDeviceBindings,
  "POST /app/v1/device-bindings/select": selectDeviceBinding,
  // Home Screen session handoff (notes/pwa-session-handoff-plan.md): issue is
  // authorized, redeem is open — the installed app has no session yet.
  "POST /app/v1/session-handoff": issueSessionHandoff,
  "DELETE /app/v1/session-handoff": retireSessionHandoff,
  "POST /app/v1/session-handoff/redeem": redeemSessionHandoff,
  "POST /app/v1/manager/staff-grants": createStaffGrant,
  "GET /app/v1/manager/staff-grants/current": getCurrentStaffGrant,
  "DELETE /app/v1/manager/staff-grants/{grantId}": cancelStaffGrant,
  "GET /app/v1/manager/device-bindings": listGeneralBindings,
  "POST /app/v1/manager/device-bindings/{bindingId}/revoke":
    revokeGeneralBinding,
  // Site manager reports (AP27, AP28): manager-only, site from the token.
  "GET /app/v1/manager/reports/checks": getChecksReport,
  "GET /app/v1/manager/reports/tasks": getTasksReport,
  "GET /app/v1/manager/reports/task-updates": getTaskUpdatesReport,
  "GET /v1/sites:search": searchSites,
  // Site config
  "GET /v1/site": getSite,
  "GET /v1/site-admin": getSiteAdmin,
  "PATCH /v1/site-admin": updateSiteAdmin,
  "GET /v1/provider-sites": listProviderSites,
  // Perimeter checks (analysis-backend Step C)
  "POST /v1/checks": createCheck,
  "GET /v1/checks": listChecks,
  "GET /v1/checks:capture-guidance": getCaptureGuidance,
  "POST /v1/checks/{checkId}/artifacts:presign": presignUpload,
  "POST /v1/checks/{checkId}/artifacts": registerArtifact,
  "DELETE /v1/checks/{checkId}/artifacts/{artifactId}": deleteArtifact,
  "PATCH /v1/checks/{checkId}/artifacts/{artifactId}/location":
    updateArtifactLocation,
  "POST /v1/checks/{checkId}/complete": completeCheck,
  "GET /v1/checks/{checkId}/artifacts/{artifactId}/media": presignMedia,
  "GET /v1/checks/{checkId}/artifacts/{artifactId}/duplicates":
    getDuplicateResult,
  "GET /v1/checks/{checkId}": getCheck,
  "GET /v1/care-work": listCareWork,
  "POST /v1/care-work": createCareWork,
  "GET /v1/care-work/{workId}": getCareWork,
  "POST /v1/care-work/{workId}/photos:presign": presignCarePhoto,
  "GET /v1/care-work/{workId}/photos/{photoId}/media": getCarePhoto,
  "GET /v1/complaints": listComplaints,
  "POST /v1/complaints": createComplaint,
  "GET /v1/complaints/{complaintId}": getComplaint,
  "DELETE /v1/complaints/{complaintId}": deleteComplaint,
  "POST /v1/complaints/{complaintId}/analysis:retry": retryComplaint,
  "POST /v1/complaints/{complaintId}/artifacts:presign":
    presignComplaintArtifact,
  "POST /v1/complaints/{complaintId}/artifacts": registerComplaintArtifact,
  "DELETE /v1/complaints/{complaintId}/artifacts/{artifactId}":
    deleteComplaintArtifact,
  "GET /v1/complaints/{complaintId}/artifacts/{artifactId}/media":
    presignComplaintMedia,
  // Staff worklist (AP10)
  "GET /v1/tasks": listTasks,
  "POST /v1/duplicates:batch": getDuplicateLinks,
  "POST /v1/tasks/{taskId}/duplicate:separate": separateDuplicate,
  "GET /v1/tasks/{taskId}/details": getTaskDetails,
  "PATCH /v1/tasks/{taskId}/action": updateTaskAction,
  "POST /v1/tasks/{taskId}/custom-action": recordCustomTaskAction,
  "POST /v1/311-requests:batch": get311RequestDetails,
  "GET /v1/tasks/{taskId}/311-requests/{srNum}": get311RequestDetail,
  "POST /v1/tasks/{taskId}/complete": completeTask,
  "GET /v1/tasks/{taskId}/updates": getTaskUpdates,
  "POST /v1/tasks/{taskId}/updates": createTaskUpdate,
  "POST /v1/tasks/{taskId}/updates/{updateId}/document": documentTaskUpdate,
  "POST /v1/tasks/{taskId}/update-media": registerTaskUpdateMedia,
  // Assessment guidance workflow
  "POST /v1/assessments:evaluate": evaluateAssessment,
  "GET /v1/assessments/{assessmentId}/guidance": getGuidance,
  "POST /v1/assessments/{assessmentId}/conditions/{conditionId}/answers":
    submitConditionAnswers,
  "POST /v1/checks/{checkId}/artifacts/{artifactId}/conditions/{conditionId}":
    editAnalysisCondition,
  "POST /v1/checks/{checkId}/artifacts/{artifactId}/conditions/{conditionId}/reject":
    rejectAnalysisCondition,
  // Legacy demo submission loop + health
  "POST /submissions": submissionsHandler,
  "GET /health": healthHandler,
  // The best-effort intakes (client-errors, client-events, feedback) are
  // served by the separate intake Lambda (lambda/intake.js) so a slow PostHog
  // forward can never hold this function's reserved executions.
  "GET /admin/v1/providers": listProviders,
  "GET /admin/v1/system-status": getSystemStatus,
  "GET /admin/v1/system-status/{siteId}/{kind}": getStatusEntries,
  "GET /admin/v1/system-status/{siteId}/media/{checkId}/{artifactId}":
    getStatusMedia,
  "GET /admin/v1/system-status/{siteId}/duplicates/{taskId}":
    getStatusDuplicate,
  "GET /admin/v1/session": getAdminSession,
  "GET /admin/v1/profile": getMyProfile,
  "PUT /admin/v1/profile": updateMyProfile,
  "GET /admin/v1/admin-users": listAdminUsers,
  "POST /admin/v1/admin-users": inviteAdminUser,
  "PUT /admin/v1/admin-users/{username}/role": updateAdminUserRole,
  "POST /admin/v1/admin-users/{username}/suspend": suspendAdminUser,
  "POST /admin/v1/admin-users/{username}/reinstate": reinstateAdminUser,
  "POST /admin/v1/admin-users/{username}/reinvite": reinviteAdminUser,
  "POST /admin/v1/admin-users/{username}/reset-password":
    resetAdminUserPassword,
  "POST /admin/v1/providers": createProvider,
  "GET /admin/v1/providers/{providerId}": getProvider,
  "PATCH /admin/v1/providers/{providerId}": updateProvider,
  "DELETE /admin/v1/providers/{providerId}": deactivateProvider,
  "GET /admin/v1/programs": listPrograms,
  "GET /admin/v1/program-managers": listCityProgramManagers,
  "POST /admin/v1/program-managers": createCityProgramManager,
  "PATCH /admin/v1/program-managers/{userId}": updateCityProgramManager,
  "GET /admin/v1/oversight-options": listOversightOptions,
  "POST /admin/v1/oversight-options": createOversightOption,
  "POST /admin/v1/address-suggestions": suggestAddresses,
  "POST /admin/v1/programs": createProgram,
  "POST /admin/v1/providers/{providerId}/manager-memberships/{membershipId}/transfer":
    transferProviderManager,
  "POST /admin/v1/people/{personId}/devices:revoke": revokeManagerDevices,
  "GET /admin/v1/people": listPeople,
  "POST /admin/v1/people": createPerson,
  "PATCH /admin/v1/people/{personId}": updatePerson,
  "GET /admin/v1/programs/{programId}": getProgram,
  "PATCH /admin/v1/programs/{programId}": updateProgram,
  "DELETE /admin/v1/programs/{programId}": deactivateProgram,
  "POST /admin/v1/programs/{programId}/users": createProgramUser,
  "POST /admin/v1/programs/{programId}/users/{userId}/devices:revoke":
    revokeManagerDevices,
  "PATCH /admin/v1/programs/{programId}/users/{userId}": updateProgramUser,
  "DELETE /admin/v1/programs/{programId}/users/{userId}": deactivateProgramUser,
  "POST /admin/v1/providers/{providerId}/programs": assignProgramToProvider,
  "POST /admin/v1/providers/{providerId}/sites": createSite,
  "GET /admin/v1/sites/{siteId}": getAdminSite,
  "POST /admin/v1/sites/{siteId}/reassign": reassignSite,
  "POST /admin/v1/sites/{siteId}/users": assignSiteUser,
  "DELETE /admin/v1/sites/{siteId}/users/{userId}": unassignSiteUser,
  "PUT /admin/v1/sites/{siteId}/compliance-managers":
    replaceSiteComplianceManagers,
  "GET /admin/v1/sites/{siteId}/terms": listSiteTerms,
  "POST /admin/v1/sites/{siteId}/terms": createSiteTerms,
  "POST /admin/v1/sites/{siteId}/terms:close": endSiteTerms,
  "POST /admin/v1/sites/{siteId}/letter:resend": resendSiteLetter,
  "GET /admin/v1/sites/{siteId}/perimeter": getSitePerimeter,
  "PUT /admin/v1/sites/{siteId}/perimeter": putSitePerimeter,
  "PUT /admin/v1/sites/{siteId}/deliberate-311": putSiteDeliberate311,
  "GET /admin/v1/sites/{siteId}/manager-memberships": listManagerMemberships,
  "POST /admin/v1/sites/{siteId}/manager-memberships": createManagerMembership,
  "PATCH /admin/v1/sites/{siteId}/manager-memberships/{membershipId}":
    updateManagerMembership,
  "DELETE /admin/v1/sites/{siteId}/manager-memberships/{membershipId}":
    deactivateManagerMembership,
  "GET /admin/v1/sites/{siteId}/grants": listManagerGrants,
  "POST /admin/v1/sites/{siteId}/manager-grants": createManagerGrant,
  "DELETE /admin/v1/sites/{siteId}/grants/{grantId}": cancelManagerGrant,
  "GET /admin/v1/providers/{providerId}/manager-memberships":
    listProviderManagers,
  "POST /admin/v1/providers/{providerId}/manager-memberships":
    createProviderManager,
  "PATCH /admin/v1/providers/{providerId}/manager-memberships/{membershipId}":
    updateProviderManager,
  transferProviderManager,
  "DELETE /admin/v1/providers/{providerId}/manager-memberships/{membershipId}":
    deactivateProviderManager,
  "POST /admin/v1/providers/{providerId}/manager-memberships/{membershipId}/reinstate":
    reinstateProviderManager,
  "GET /admin/v1/providers/{providerId}/grants": listProviderManagerGrants,
  "POST /admin/v1/providers/{providerId}/manager-grants":
    createProviderManagerGrant,
  "DELETE /admin/v1/providers/{providerId}/grants/{grantId}":
    cancelProviderManagerGrant,
  "POST /admin/v1/providers/{providerId}/manager-enrollments/{enrollmentId}/revoke":
    revokeProviderManagerEnrollment,
  "POST /admin/v1/site-imports/preview": previewSiteImport,
  "GET /admin/v1/site-imports": listSiteImports,
  "POST /admin/v1/site-imports/{importId}/apply": applySiteImport,
  "GET /admin/v1/site-imports/{importId}": getSiteImport,
  "GET /admin/v1/site-imports/{importId}/conflicts.csv": getSiteImportConflicts,
  "PATCH /admin/v1/sites/{siteId}": updateSite,
  "POST /admin/v1/sites/{siteId}/compliance-letters:presign":
    presignComplianceLetter,
  "DELETE /admin/v1/sites/{siteId}": deactivateSite,
  "POST /admin/v1/sites/{siteId}/setup-codes": issueAdminSetupCode,
  "GET /admin/v1/sites/{siteId}/devices": listDevices,
  "DELETE /admin/v1/sites/{siteId}/devices/{deviceId}": revokeDevice,
  "POST /admin/v1/sites/{siteId}/device-bindings:revoke":
    revokeSelectedDeviceBindings,
  "POST /admin/v1/sites/{siteId}/device-bindings:revoke-all":
    revokeAllSiteDeviceBindings,
  "POST /admin/v1/sites/{siteId}/device-bindings/{bindingId}/suspend":
    suspendDeviceBinding,
  "GET /admin/v1/physical-devices/{physicalDeviceId}":
    getPhysicalDeviceRevocationPreview,
  "POST /admin/v1/physical-devices/{physicalDeviceId}/revoke":
    revokePhysicalDeviceEverywhere,
  "GET /admin/v1/emergency-site-revocations/sites":
    listEmergencyRevocationSites,
  "POST /admin/v1/emergency-site-revocations:preview":
    previewEmergencySiteRevocation,
  "POST /admin/v1/emergency-site-revocations": startEmergencySiteRevocation,
});

/**
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2}
 */
export const handler = async (event) => {
  const routeKey = /** @type {any} */ (event).routeKey;
  const fn = routes[routeKey];
  if (!fn) {
    return jsonResponse(404, { error: "not_found", routeKey });
  }
  // Server-side error convention (logServerError): uncaught handler errors
  // land as one structured JSON line (Logs Insights-groupable, alarmable)
  // before the platform turns them into a 500.
  return withServerErrorsLogged(`api ${routeKey}`, () => fn(event), {
    reqId: /** @type {any} */ (event)?.requestContext?.requestId,
  });
};
