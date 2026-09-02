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
  presignMedia,
} from "../handlers/artifacts.js";
import { listTasks } from "../handlers/tasks.js";
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
import { handler as descriptionValidationHandler } from "../handlers/description-validation.js";
import { handler as clientErrorsHandler } from "../handlers/client-errors.js";
import { jsonResponse } from "../http.js";
import { withServerErrorsLogged } from "../lib/log-server-error.js";

// Route key → handler. Keys are the API Gateway v2 route keys ("<METHOD> <path>").
// The individual handlers carry richer (event, context, callback) signatures; we
// only ever call them with the event, so the map is typed to that call shape.
const routes = /** @type {Record<string, (...args: any[]) => any>} */ ({
  "POST /site-code": siteCodeHandler,
  "POST /v1/checks/{checkId}/sides/{side}/description:validate":
    descriptionValidationHandler,
  // Perimeter checks (analysis-backend Step C)
  "POST /v1/checks": createCheck,
  "GET /v1/checks": listChecks,
  "POST /v1/checks/{checkId}/artifacts:presign": presignUpload,
  "POST /v1/checks/{checkId}/artifacts": registerArtifact,
  "POST /v1/checks/{checkId}/complete": completeCheck,
  "GET /v1/checks/{checkId}/artifacts/{artifactId}/media": presignMedia,
  "GET /v1/checks/{checkId}": getCheck,
  // Staff worklist (AP10)
  "GET /v1/tasks": listTasks,
  "POST /v1/tasks/{taskId}/complete": completeTask,
  "POST /v1/tasks/{taskId}/cannot-do": cannotDoTask,
  // Assessment guidance workflow
  "POST /v1/assessments:evaluate": evaluateAssessment,
  "GET /v1/assessments/{assessmentId}/guidance": getGuidance,
  "POST /v1/assessments/{assessmentId}/conditions/{conditionId}/answers":
    submitConditionAnswers,
  // Legacy demo submission loop + health
  "POST /submissions": submissionsHandler,
  "GET /health": healthHandler,
  // Client error intake (best-effort; handler always 204s — see handlers/client-errors.js)
  "POST /v1/client-errors": clientErrorsHandler,
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
