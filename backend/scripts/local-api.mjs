// In-process HTTP router — the local stand-in for API Gateway (HTTP API v2). It
// maps method+path to the SAME exported Lambda handlers we deploy, builds a
// realistic APIGatewayProxyEventV2, injects a stub Cognito `sub`, and writes the
// handler's statusCode/headers/body back to the wire. A thing you can `curl`.
//
// Routes mirror what Terraform's API Gateway will define. Keep this table and the
// Terraform routes in step — the router is a dev tool, Terraform stays the source
// of truth for real infra.

import { createServer } from "node:http";
import { ensureLocalInfra } from "./lib/ensure-infra.mjs";
import { resolveDeviceClaims } from "./lib/local-device-auth.mjs";
import { buildProxyEvent } from "./lib/proxy-event.mjs";
import {
  createCheck,
  completeCheck,
  listChecks,
  getCheck,
} from "../src/handlers/checks.js";
import {
  presignUpload,
  registerArtifact,
  deleteArtifact,
  presignMedia,
} from "../src/handlers/artifacts.js";
import {
  get311RequestDetail,
  get311RequestDetails,
  listTasks,
} from "../src/handlers/tasks.js";
import {
  createTaskUpdate,
  documentTaskUpdate,
  getTaskUpdates,
  registerTaskUpdateMedia,
} from "../src/handlers/task-updates.js";
import {
  cannotDoTask,
  completeTask,
  evaluateAssessment,
  getGuidance,
  submitConditionAnswers,
} from "../src/handlers/guidance.js";
import { handler as submissionsHandler } from "../src/handlers/submissions.js";
import { handler as healthHandler } from "../src/handlers/health.js";
import { handler as siteCodeHandler } from "../src/handlers/site-code.js";
import { registerDevice, refreshDeviceToken } from "../src/handlers/devices.js";
import { redeemEnrollmentGrant } from "../src/handlers/enrollment.js";
import {
  listDeviceBindings,
  selectDeviceBinding,
} from "../src/handlers/device-bindings.js";
import {
  cancelStaffGrant,
  createStaffGrant,
  getCurrentStaffGrant,
  listGeneralBindings,
  revokeGeneralBinding,
} from "../src/handlers/manager-access.js";
import { requestManagerAccess } from "../src/handlers/manager-access-requests.js";
import { searchSites } from "../src/handlers/setup-code-requests.js";
import {
  getSite,
  getSiteAdmin,
  listProviderSites,
  updateSiteAdmin,
} from "../src/handlers/site.js";
import { handler as clientErrorsHandler } from "../src/handlers/client-errors.js";
import { handler as clientEventsHandler } from "../src/handlers/client-events.js";
import { handler as feedbackHandler } from "../src/handlers/feedback.js";
import {
  editAnalysisCondition,
  rejectAnalysisCondition,
} from "../src/handlers/analysis-amendments.js";
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
} from "../src/handlers/admin.js";
import {
  getAdminSession,
  inviteAdminUser,
  listAdminUsers,
  reinviteAdminUser,
  reinstateAdminUser,
  resetAdminUserPassword,
  suspendAdminUser,
  updateAdminUserRole,
} from "../src/handlers/admin-users.js";
import {
  createOversightOption,
  listOversightOptions,
} from "../src/handlers/admin-oversight.js";
import { suggestAddresses } from "../src/handlers/admin-addresses.js";
import {
  getPhysicalDeviceRevocationPreview,
  revokeAllSiteDeviceBindings,
  revokePhysicalDeviceEverywhere,
  revokeSelectedDeviceBindings,
  suspendDeviceBinding,
} from "../src/handlers/admin-device-revocation.js";
import {
  listEmergencyRevocationSites,
  previewEmergencySiteRevocation,
  startEmergencySiteRevocation,
} from "../src/handlers/admin-multi-site-revocation.js";
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
} from "../src/handlers/admin-programs.js";
import {
  assignSiteUser,
  createSiteTerms,
  endSiteTerms,
  getSitePerimeter,
  listSiteTerms,
  putSitePerimeter,
  unassignSiteUser,
} from "../src/handlers/admin-site-config.js";
import {
  createManagerMembership,
  deactivateManagerMembership,
  listManagerMemberships,
  updateManagerMembership,
} from "../src/handlers/admin-manager-memberships.js";
import {
  cancelManagerGrant,
  createManagerGrant,
  listManagerGrants,
} from "../src/handlers/admin-manager-grants.js";
import {
  applySiteImport,
  getSiteImport,
  getSiteImportConflicts,
  listSiteImports,
  previewSiteImport,
} from "../src/handlers/admin-site-imports.js";
import {
  listAnalyticsQueries,
  runAnalyticsCatalogQuery,
  runAnalyticsQuery,
} from "../src/handlers/admin-analytics.js";

const PORT = Number(process.env.LOCAL_API_PORT ?? 3001);
const DEFAULT_SUB = process.env.DEBUG_SUB ?? "local-dev-user";
// Stub-only requests (no Bearer token) always carry a site claim: the
// principal fails closed when an authorizer is present without one.
const DEFAULT_SITE = process.env.DEBUG_SITE || "demo-site";
const LOCAL_CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  "access-control-allow-headers":
    "content-type,idempotency-key,authorization,x-debug-sub,x-debug-site,x-debug-groups,x-debug-access",
};

// Compile a route pattern into a matcher. Patterns use `{name}` for path params
// (e.g. `/v1/checks/{checkId}`) and may carry a literal `:action` suffix on the
// last segment (e.g. `/v1/checks/{checkId}/artifacts:presign`), exactly like the
// API Gateway route keys. Anchored regex, so `/artifacts` and `/artifacts:presign`
// never collide and segment count disambiguates list vs. get.
/**
 * @param {string} method
 * @param {string} pattern
 * @param {(event: any) => Promise<any>} handler
 */
function route(method, pattern, handler) {
  /** @type {string[]} */
  const names = [];
  const regexStr = pattern
    .split(/(\{[^}]+\})/)
    .map((part) => {
      const m = /^\{([^}]+)\}$/.exec(part);
      if (m) {
        names.push(m[1]);
        return "([^/]+)";
      }
      // Escape regex metacharacters in literal chunks (`:` is already literal).
      return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("");
  return {
    method,
    pattern,
    regex: new RegExp(`^${regexStr}$`),
    names,
    handler,
  };
}

/** method+path → handler. Extend alongside Terraform's API Gateway routes. */
const routes = [
  route("POST", "/site-code", siteCodeHandler),
  // Device bootstrap (Option 4 device auth): open routes, no authorizer.
  route("POST", "/v1/devices", registerDevice),
  route("POST", "/v1/devices/token:refresh", refreshDeviceToken),
  route("POST", "/app/v1/enrollment/redeem", redeemEnrollmentGrant),
  route("POST", "/app/v1/manager-access/request", requestManagerAccess),
  route("GET", "/app/v1/device-bindings", listDeviceBindings),
  route("POST", "/app/v1/device-bindings/select", selectDeviceBinding),
  route("POST", "/app/v1/manager/staff-grants", createStaffGrant),
  route("GET", "/app/v1/manager/staff-grants/current", getCurrentStaffGrant),
  route("DELETE", "/app/v1/manager/staff-grants/{grantId}", cancelStaffGrant),
  route("GET", "/app/v1/manager/device-bindings", listGeneralBindings),
  route(
    "POST",
    "/app/v1/manager/device-bindings/{bindingId}/revoke",
    revokeGeneralBinding,
  ),
  route("GET", "/v1/sites:search", searchSites),
  // Site config
  route("GET", "/v1/site", getSite),
  route("GET", "/v1/site-admin", getSiteAdmin),
  route("PATCH", "/v1/site-admin", updateSiteAdmin),
  route("GET", "/v1/provider-sites", listProviderSites),
  // Perimeter checks (analysis-backend Step C)
  route("POST", "/v1/checks", createCheck),
  route("GET", "/v1/checks", listChecks),
  route("POST", "/v1/checks/{checkId}/artifacts:presign", presignUpload),
  route("POST", "/v1/checks/{checkId}/artifacts", registerArtifact),
  route(
    "DELETE",
    "/v1/checks/{checkId}/artifacts/{artifactId}",
    deleteArtifact,
  ),
  route("POST", "/v1/tasks/{taskId}/update-media", registerTaskUpdateMedia),
  route("POST", "/v1/checks/{checkId}/complete", completeCheck),
  route(
    "GET",
    "/v1/checks/{checkId}/artifacts/{artifactId}/media",
    presignMedia,
  ),
  route("GET", "/v1/checks/{checkId}", getCheck),
  // Staff worklist (AP10)
  route("GET", "/v1/tasks", listTasks),
  route("POST", "/v1/311-requests:batch", get311RequestDetails),
  route("GET", "/v1/tasks/{taskId}/311-requests/{srNum}", get311RequestDetail),
  route("POST", "/v1/tasks/{taskId}/complete", completeTask),
  route("POST", "/v1/tasks/{taskId}/cannot-do", cannotDoTask),
  route("GET", "/v1/tasks/{taskId}/updates", getTaskUpdates),
  route("POST", "/v1/tasks/{taskId}/updates", createTaskUpdate),
  route(
    "POST",
    "/v1/tasks/{taskId}/updates/{updateId}/document",
    documentTaskUpdate,
  ),
  // Assessment guidance workflow
  route("POST", "/v1/assessments:evaluate", evaluateAssessment),
  route("GET", "/v1/assessments/{assessmentId}/guidance", getGuidance),
  route(
    "POST",
    "/v1/assessments/{assessmentId}/conditions/{conditionId}/answers",
    submitConditionAnswers,
  ),
  route(
    "POST",
    "/v1/checks/{checkId}/artifacts/{artifactId}/conditions/{conditionId}",
    editAnalysisCondition,
  ),
  route(
    "POST",
    "/v1/checks/{checkId}/artifacts/{artifactId}/conditions/{conditionId}/reject",
    rejectAnalysisCondition,
  ),
  // Legacy demo submission loop + health
  route("POST", "/submissions", submissionsHandler),
  route("GET", "/health", healthHandler),
  // Client error intake (best-effort; handler always 204s)
  route("POST", "/v1/client-errors", clientErrorsHandler),
  // Client analytics intake (page views + app events; always 204s)
  route("POST", "/v1/client-events", clientEventsHandler),
  // User feedback intake (log-based store; handler always 204s)
  route("POST", "/v1/feedback", feedbackHandler),
  route("GET", "/admin/v1/providers", listProviders),
  route("GET", "/admin/v1/session", getAdminSession),
  route("GET", "/admin/v1/admin-users", listAdminUsers),
  route("POST", "/admin/v1/admin-users", inviteAdminUser),
  route("PUT", "/admin/v1/admin-users/{username}/role", updateAdminUserRole),
  route("POST", "/admin/v1/admin-users/{username}/suspend", suspendAdminUser),
  route(
    "POST",
    "/admin/v1/admin-users/{username}/reinstate",
    reinstateAdminUser,
  ),
  route("POST", "/admin/v1/admin-users/{username}/reinvite", reinviteAdminUser),
  route(
    "POST",
    "/admin/v1/admin-users/{username}/reset-password",
    resetAdminUserPassword,
  ),
  route("POST", "/admin/v1/providers", createProvider),
  route("GET", "/admin/v1/providers/{providerId}", getProvider),
  route("PATCH", "/admin/v1/providers/{providerId}", updateProvider),
  route("DELETE", "/admin/v1/providers/{providerId}", deactivateProvider),
  route("GET", "/admin/v1/programs", listPrograms),
  route("GET", "/admin/v1/program-managers", listCityProgramManagers),
  route("POST", "/admin/v1/program-managers", createCityProgramManager),
  route(
    "PATCH",
    "/admin/v1/program-managers/{userId}",
    updateCityProgramManager,
  ),
  route("GET", "/admin/v1/oversight-options", listOversightOptions),
  route("POST", "/admin/v1/oversight-options", createOversightOption),
  route("POST", "/admin/v1/address-suggestions", suggestAddresses),
  route("POST", "/admin/v1/programs", createProgram),
  route("GET", "/admin/v1/programs/{programId}", getProgram),
  route("PATCH", "/admin/v1/programs/{programId}", updateProgram),
  route("DELETE", "/admin/v1/programs/{programId}", deactivateProgram),
  route(
    "POST",
    "/admin/v1/providers/{providerId}/programs",
    assignProgramToProvider,
  ),
  route("POST", "/admin/v1/programs/{programId}/users", createProgramUser),
  route(
    "PATCH",
    "/admin/v1/programs/{programId}/users/{userId}",
    updateProgramUser,
  ),
  route(
    "DELETE",
    "/admin/v1/programs/{programId}/users/{userId}",
    deactivateProgramUser,
  ),
  route("POST", "/admin/v1/providers/{providerId}/sites", createSite),
  route("GET", "/admin/v1/sites/{siteId}", getAdminSite),
  route("POST", "/admin/v1/sites/{siteId}/reassign", reassignSite),
  route("POST", "/admin/v1/sites/{siteId}/users", assignSiteUser),
  route("DELETE", "/admin/v1/sites/{siteId}/users/{userId}", unassignSiteUser),
  route("GET", "/admin/v1/sites/{siteId}/terms", listSiteTerms),
  route("POST", "/admin/v1/sites/{siteId}/terms", createSiteTerms),
  route("POST", "/admin/v1/sites/{siteId}/terms:close", endSiteTerms),
  route("GET", "/admin/v1/sites/{siteId}/perimeter", getSitePerimeter),
  route("PUT", "/admin/v1/sites/{siteId}/perimeter", putSitePerimeter),
  route(
    "GET",
    "/admin/v1/sites/{siteId}/manager-memberships",
    listManagerMemberships,
  ),
  route(
    "POST",
    "/admin/v1/sites/{siteId}/manager-memberships",
    createManagerMembership,
  ),
  route(
    "PATCH",
    "/admin/v1/sites/{siteId}/manager-memberships/{membershipId}",
    updateManagerMembership,
  ),
  route(
    "DELETE",
    "/admin/v1/sites/{siteId}/manager-memberships/{membershipId}",
    deactivateManagerMembership,
  ),
  route("GET", "/admin/v1/sites/{siteId}/grants", listManagerGrants),
  route("POST", "/admin/v1/sites/{siteId}/manager-grants", createManagerGrant),
  route(
    "DELETE",
    "/admin/v1/sites/{siteId}/grants/{grantId}",
    cancelManagerGrant,
  ),
  route("POST", "/admin/v1/site-imports/preview", previewSiteImport),
  route("GET", "/admin/v1/site-imports", listSiteImports),
  route("POST", "/admin/v1/site-imports/{importId}/apply", applySiteImport),
  route("GET", "/admin/v1/site-imports/{importId}", getSiteImport),
  route(
    "GET",
    "/admin/v1/site-imports/{importId}/conflicts.csv",
    getSiteImportConflicts,
  ),
  route("PATCH", "/admin/v1/sites/{siteId}", updateSite),
  route(
    "POST",
    "/admin/v1/sites/{siteId}/compliance-letters:presign",
    presignComplianceLetter,
  ),
  route("DELETE", "/admin/v1/sites/{siteId}", deactivateSite),
  route("POST", "/admin/v1/sites/{siteId}/setup-codes", issueAdminSetupCode),
  route("GET", "/admin/v1/sites/{siteId}/devices", listDevices),
  route("DELETE", "/admin/v1/sites/{siteId}/devices/{deviceId}", revokeDevice),
  route(
    "POST",
    "/admin/v1/sites/{siteId}/device-bindings:revoke",
    revokeSelectedDeviceBindings,
  ),
  route(
    "POST",
    "/admin/v1/sites/{siteId}/device-bindings:revoke-all",
    revokeAllSiteDeviceBindings,
  ),
  route(
    "POST",
    "/admin/v1/sites/{siteId}/device-bindings/{bindingId}/suspend",
    suspendDeviceBinding,
  ),
  route(
    "GET",
    "/admin/v1/physical-devices/{physicalDeviceId}",
    getPhysicalDeviceRevocationPreview,
  ),
  route(
    "POST",
    "/admin/v1/physical-devices/{physicalDeviceId}/revoke",
    revokePhysicalDeviceEverywhere,
  ),
  route(
    "GET",
    "/admin/v1/emergency-site-revocations/sites",
    listEmergencyRevocationSites,
  ),
  route(
    "POST",
    "/admin/v1/emergency-site-revocations:preview",
    previewEmergencySiteRevocation,
  ),
  route(
    "POST",
    "/admin/v1/emergency-site-revocations",
    startEmergencySiteRevocation,
  ),
  route("GET", "/admin/v1/analytics/queries", listAnalyticsQueries),
  route(
    "POST",
    "/admin/v1/analytics/queries/{queryId}",
    runAnalyticsCatalogQuery,
  ),
  route("POST", "/admin/v1/analytics/query", runAnalyticsQuery),
];

/**
 * Find the first route whose method + compiled regex match, returning the route
 * plus the extracted path parameters.
 * @param {string} method
 * @param {string} pathname
 */
function matchRoute(method, pathname) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = r.regex.exec(pathname);
    if (!m) continue;
    /** @type {Record<string, string>} */
    const pathParameters = {};
    r.names.forEach((name, i) => {
      pathParameters[name] = decodeURIComponent(m[i + 1]);
    });
    return { route: r, pathParameters };
  }
  return null;
}

/** @param {import("node:http").IncomingMessage} req */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  if (method === "OPTIONS") {
    res.writeHead(204, {
      ...LOCAL_CORS_HEADERS,
      "access-control-max-age": "86400",
    });
    res.end();
    return;
  }

  const matched = matchRoute(method, path);

  if (!matched) {
    res.writeHead(404, {
      "content-type": "application/json",
      ...LOCAL_CORS_HEADERS,
    });
    res.end(JSON.stringify({ error: "not found", method, path }));
    return;
  }

  try {
    const body = await readBody(req);

    // Flatten the query string to a first-value-wins map (API Gateway v2
    // behavior), omitted entirely when there is none.
    /** @type {Record<string, string>} */
    const queryStringParameters = {};
    for (const [k, v] of url.searchParams) {
      if (!(k in queryStringParameters)) queryStringParameters[k] = v;
    }
    const hasQuery = Object.keys(queryStringParameters).length > 0;

    // Run the production authorizer locally. A Bearer token overrides the
    // X-Debug stubs, and signature, expiry, live binding status/generation,
    // Site state, and Manager membership are all checked before dispatch.
    const flat = {};
    for (const [k, v] of Object.entries(req.headers)) {
      flat[k] = Array.isArray(v) ? v.join(",") : v;
    }
    const claims = await resolveDeviceClaims(flat);
    if (claims?.error) {
      res.writeHead(401, {
        "content-type": "application/json",
        ...LOCAL_CORS_HEADERS,
      });
      res.end(JSON.stringify({ error: "invalid_token", reason: claims.error }));
      console.log(`[api] ${method} ${path} → 401 (invalid token)`);
      return;
    }

    const event = buildProxyEvent({
      method,
      path,
      headers: req.headers,
      body,
      defaultSub: DEFAULT_SUB,
      defaultSite: DEFAULT_SITE,
      // A verified device token reproduces the deployed authorizer shape
      // (authorizer.lambda); without one the X-Debug stubs apply.
      deviceClaims: claims && !claims.error ? claims : undefined,
      pathParameters: matched.route.names.length
        ? matched.pathParameters
        : undefined,
      queryStringParameters: hasQuery ? queryStringParameters : undefined,
      rawQueryString: url.search.replace(/^\?/, ""),
    });

    // The real handler. Second/third args (context/callback) are unused by our
    // async handlers.
    const result = await matched.route.handler(
      /** @type {any} */ (event),
      /** @type {any} */ ({}),
      () => {},
    );

    const { statusCode = 200, headers = {}, body: resBody = "" } = result ?? {};
    res.writeHead(
      statusCode,
      /** @type {any} */ ({
        ...headers,
        ...LOCAL_CORS_HEADERS,
      }),
    );
    res.end(resBody);
    console.log(`[api] ${method} ${path} → ${statusCode}`);
  } catch (err) {
    console.error(`[api] ${method} ${path} threw:`, err);
    res.writeHead(500, {
      "content-type": "application/json",
      ...LOCAL_CORS_HEADERS,
    });
    res.end(JSON.stringify({ error: "internal error" }));
  }
});

async function main() {
  await ensureLocalInfra();
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`[api] listening on http://localhost:${PORT}`);
    console.log(
      `[api] routes:\n${routes.map((r) => `  ${r.method} ${r.pattern}`).join("\n")}`,
    );
  });
}

main().catch((err) => {
  console.error("[api] failed to start:", err);
  process.exit(1);
});
