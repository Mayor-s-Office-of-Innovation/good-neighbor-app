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
  getCheck,
} from "../handlers/checks.js";
import {
  presignUpload,
  registerArtifact,
  deleteArtifact,
  presignMedia,
} from "../handlers/artifacts.js";
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
  cannotDoTask,
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
  cancelStaffGrant,
  createStaffGrant,
  getCurrentStaffGrant,
  listGeneralBindings,
  revokeGeneralBinding,
} from "../handlers/manager-access.js";
import { requestManagerAccess } from "../handlers/manager-access-requests.js";
import {
  requestSetupCode,
  searchSites,
} from "../handlers/setup-code-requests.js";
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
  createCodeContact,
  createCityProgramManager,
  createMasterContact,
  createProvider,
  createSite,
  deactivateCodeContact,
  deactivateMasterContact,
  deactivateProvider,
  deactivateSite,
  getAdminSite,
  getProvider,
  issueAdminSetupCode,
  listCodeContacts,
  listCityProgramManagers,
  listDevices,
  listMasterContacts,
  listProviders,
  presignComplianceLetter,
  reassignSite,
  revokeDevice,
  updateProvider,
  updateSite,
} from "../handlers/admin.js";
import {
  createOversightOption,
  listOversightOptions,
} from "../handlers/admin-oversight.js";
import { suggestAddresses } from "../handlers/admin-addresses.js";
import {
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
  getSitePerimeter,
  listSiteTerms,
  putSitePerimeter,
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
  applySiteImport,
  getSiteImport,
  getSiteImportConflicts,
  listSiteImports,
  previewSiteImport,
} from "../handlers/admin-site-imports.js";
import { withServerErrorsLogged } from "../lib/log-server-error.js";

// Route key → handler. Keys are the API Gateway v2 route keys ("<METHOD> <path>").
// The individual handlers carry richer (event, context, callback) signatures; we
// only ever call them with the event, so the map is typed to that call shape.
const routes = /** @type {Record<string, (...args: any[]) => any>} */ ({
  "POST /site-code": siteCodeHandler,
  // Device bootstrap (Option 4 device auth — see docs/adr/0010): open routes,
  // no authorizer. Everything under /v1/* except these + the intakes is gated.
  "POST /v1/devices": registerDevice,
  "POST /v1/devices/token:refresh": refreshDeviceToken,
  "POST /app/v1/enrollment/redeem": redeemEnrollmentGrant,
  "POST /app/v1/manager-access/request": requestManagerAccess,
  "GET /app/v1/device-bindings": listDeviceBindings,
  "POST /app/v1/device-bindings/select": selectDeviceBinding,
  "POST /app/v1/manager/staff-grants": createStaffGrant,
  "GET /app/v1/manager/staff-grants/current": getCurrentStaffGrant,
  "DELETE /app/v1/manager/staff-grants/{grantId}": cancelStaffGrant,
  "GET /app/v1/manager/device-bindings": listGeneralBindings,
  "POST /app/v1/manager/device-bindings/{bindingId}/revoke":
    revokeGeneralBinding,
  "GET /v1/sites:search": searchSites,
  "POST /v1/setup-codes:request": requestSetupCode,
  // Site config
  "GET /v1/site": getSite,
  "GET /v1/site-admin": getSiteAdmin,
  "PATCH /v1/site-admin": updateSiteAdmin,
  "GET /v1/provider-sites": listProviderSites,
  // Perimeter checks (analysis-backend Step C)
  "POST /v1/checks": createCheck,
  "GET /v1/checks": listChecks,
  "POST /v1/checks/{checkId}/artifacts:presign": presignUpload,
  "POST /v1/checks/{checkId}/artifacts": registerArtifact,
  "DELETE /v1/checks/{checkId}/artifacts/{artifactId}": deleteArtifact,
  "POST /v1/checks/{checkId}/complete": completeCheck,
  "GET /v1/checks/{checkId}/artifacts/{artifactId}/media": presignMedia,
  "GET /v1/checks/{checkId}": getCheck,
  // Staff worklist (AP10)
  "GET /v1/tasks": listTasks,
  "POST /v1/311-requests:batch": get311RequestDetails,
  "GET /v1/tasks/{taskId}/311-requests/{srNum}": get311RequestDetail,
  "POST /v1/tasks/{taskId}/complete": completeTask,
  "POST /v1/tasks/{taskId}/cannot-do": cannotDoTask,
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
  "POST /admin/v1/providers": createProvider,
  "GET /admin/v1/providers/{providerId}": getProvider,
  "PATCH /admin/v1/providers/{providerId}": updateProvider,
  "DELETE /admin/v1/providers/{providerId}": deactivateProvider,
  "GET /admin/v1/programs": listPrograms,
  "GET /admin/v1/program-managers": listCityProgramManagers,
  "POST /admin/v1/program-managers": createCityProgramManager,
  "GET /admin/v1/oversight-options": listOversightOptions,
  "POST /admin/v1/oversight-options": createOversightOption,
  "POST /admin/v1/address-suggestions": suggestAddresses,
  "POST /admin/v1/programs": createProgram,
  "GET /admin/v1/programs/{programId}": getProgram,
  "PATCH /admin/v1/programs/{programId}": updateProgram,
  "DELETE /admin/v1/programs/{programId}": deactivateProgram,
  "POST /admin/v1/programs/{programId}/users": createProgramUser,
  "PATCH /admin/v1/programs/{programId}/users/{userId}": updateProgramUser,
  "DELETE /admin/v1/programs/{programId}/users/{userId}": deactivateProgramUser,
  "POST /admin/v1/providers/{providerId}/programs": assignProgramToProvider,
  "POST /admin/v1/providers/{providerId}/sites": createSite,
  "GET /admin/v1/sites/{siteId}": getAdminSite,
  "POST /admin/v1/sites/{siteId}/reassign": reassignSite,
  "POST /admin/v1/sites/{siteId}/users": assignSiteUser,
  "DELETE /admin/v1/sites/{siteId}/users/{userId}": unassignSiteUser,
  "GET /admin/v1/sites/{siteId}/terms": listSiteTerms,
  "POST /admin/v1/sites/{siteId}/terms": createSiteTerms,
  "GET /admin/v1/sites/{siteId}/perimeter": getSitePerimeter,
  "PUT /admin/v1/sites/{siteId}/perimeter": putSitePerimeter,
  "GET /admin/v1/sites/{siteId}/manager-memberships": listManagerMemberships,
  "POST /admin/v1/sites/{siteId}/manager-memberships": createManagerMembership,
  "PATCH /admin/v1/sites/{siteId}/manager-memberships/{membershipId}":
    updateManagerMembership,
  "DELETE /admin/v1/sites/{siteId}/manager-memberships/{membershipId}":
    deactivateManagerMembership,
  "GET /admin/v1/sites/{siteId}/grants": listManagerGrants,
  "POST /admin/v1/sites/{siteId}/manager-grants": createManagerGrant,
  "DELETE /admin/v1/sites/{siteId}/grants/{grantId}": cancelManagerGrant,
  "POST /admin/v1/site-imports/preview": previewSiteImport,
  "GET /admin/v1/site-imports": listSiteImports,
  "POST /admin/v1/site-imports/{importId}/apply": applySiteImport,
  "GET /admin/v1/site-imports/{importId}": getSiteImport,
  "GET /admin/v1/site-imports/{importId}/conflicts.csv": getSiteImportConflicts,
  "PATCH /admin/v1/sites/{siteId}": updateSite,
  "POST /admin/v1/sites/{siteId}/compliance-letters:presign":
    presignComplianceLetter,
  "DELETE /admin/v1/sites/{siteId}": deactivateSite,
  "GET /admin/v1/sites/{siteId}/master-contacts": listMasterContacts,
  "POST /admin/v1/sites/{siteId}/master-contacts": createMasterContact,
  "DELETE /admin/v1/sites/{siteId}/master-contacts/{emailHash}":
    deactivateMasterContact,
  "GET /admin/v1/sites/{siteId}/code-contacts": listCodeContacts,
  "POST /admin/v1/sites/{siteId}/code-contacts": createCodeContact,
  "DELETE /admin/v1/sites/{siteId}/code-contacts/{emailHash}":
    deactivateCodeContact,
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
