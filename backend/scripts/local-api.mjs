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
  presignMedia,
} from "../src/handlers/artifacts.js";
import { listTasks } from "../src/handlers/tasks.js";
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
import { handler as descriptionValidationHandler } from "../src/handlers/description-validation.js";
import { handler as clientErrorsHandler } from "../src/handlers/client-errors.js";
import { handler as feedbackHandler } from "../src/handlers/feedback.js";

const PORT = Number(process.env.LOCAL_API_PORT ?? 3001);
const DEFAULT_SUB = process.env.DEBUG_SUB ?? "local-dev-user";
const DEFAULT_SITE = process.env.DEBUG_SITE ?? "";
const LOCAL_CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers":
    "content-type,idempotency-key,authorization,x-debug-sub,x-debug-site",
};

// Local device-token verification (mirrors lambda/authorizer.js): when a
// request carries `Authorization: Bearer <jwt>`, verify it and use its claims
// INSTEAD of the X-Debug stubs — so local dev exercises the production claim
// contract. Unset DEVICE_TOKEN_SECRET disables verification (stub-only mode).
async function resolveClaims(flatHeaders) {
  const bearer = /^(?:authorization)$/i;
  const header = Object.keys(flatHeaders).find((k) => bearer.test(k));
  const value = header ? flatHeaders[header] : "";
  const m = /^Bearer\s+(.+)$/i.exec(value.trim());
  if (m && process.env.DEVICE_TOKEN_SECRET) {
    try {
      const { verifyDeviceToken } = await import("../src/lib/device-token.js");
      const claims = await verifyDeviceToken(m[1]);
      if (claims.typ !== "access") throw new Error("not an access token");
      return {
        sub: claims.sub,
        siteId: claims["custom:siteId"],
      };
    } catch (err) {
      return { error: /** @type {Error} */ (err).message };
    }
  }
  return null;
}

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
  route(
    "POST",
    "/v1/checks/{checkId}/sides/{side}/description:validate",
    descriptionValidationHandler,
  ),
  // Perimeter checks (analysis-backend Step C)
  route("POST", "/v1/checks", createCheck),
  route("GET", "/v1/checks", listChecks),
  route("POST", "/v1/checks/{checkId}/artifacts:presign", presignUpload),
  route("POST", "/v1/checks/{checkId}/artifacts", registerArtifact),
  route("POST", "/v1/checks/{checkId}/complete", completeCheck),
  route(
    "GET",
    "/v1/checks/{checkId}/artifacts/{artifactId}/media",
    presignMedia,
  ),
  route("GET", "/v1/checks/{checkId}", getCheck),
  // Staff worklist (AP10)
  route("GET", "/v1/tasks", listTasks),
  route("POST", "/v1/tasks/{taskId}/complete", completeTask),
  route("POST", "/v1/tasks/{taskId}/cannot-do", cannotDoTask),
  // Assessment guidance workflow
  route("POST", "/v1/assessments:evaluate", evaluateAssessment),
  route("GET", "/v1/assessments/{assessmentId}/guidance", getGuidance),
  route(
    "POST",
    "/v1/assessments/{assessmentId}/conditions/{conditionId}/answers",
    submitConditionAnswers,
  ),
  // Legacy demo submission loop + health
  route("POST", "/submissions", submissionsHandler),
  route("GET", "/health", healthHandler),
  // Client error intake (best-effort; handler always 204s)
  route("POST", "/v1/client-errors", clientErrorsHandler),
  // User feedback intake (log-based store; handler always 204s)
  route("POST", "/v1/feedback", feedbackHandler),
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

    // Local token verification (production claim contract): a Bearer token
    // overrides the X-Debug stubs; a BAD token 401s like the real authorizer.
    const flat = {};
    for (const [k, v] of Object.entries(req.headers)) {
      flat[k] = Array.isArray(v) ? v.join(",") : v;
    }
    const claims = await resolveClaims(flat);
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
      defaultSub: claims?.sub ?? DEFAULT_SUB,
      defaultSite: claims?.siteId ?? DEFAULT_SITE,
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
