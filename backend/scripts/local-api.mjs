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
import { handler as submissionsHandler } from "../src/handlers/submissions.js";
import { handler as healthHandler } from "../src/handlers/health.js";

const PORT = 3000;
const DEFAULT_SUB = process.env.DEBUG_SUB ?? "local-dev-user";

/** method+path → handler. Extend alongside Terraform's API Gateway routes. */
const routes = [
  { method: "POST", path: "/submissions", handler: submissionsHandler },
  { method: "GET", path: "/health", handler: healthHandler },
];

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
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  const route = routes.find((r) => r.method === method && r.path === path);

  if (!route) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found", method, path }));
    return;
  }

  try {
    const body = await readBody(req);
    const event = buildProxyEvent({
      method,
      path,
      headers: req.headers,
      body,
      defaultSub: DEFAULT_SUB,
    });

    // The real handler. Second/third args (context/callback) are unused by our
    // async handlers.
    const result = await route.handler(
      /** @type {any} */ (event),
      /** @type {any} */ ({}),
      () => {},
    );

    const { statusCode = 200, headers = {}, body: resBody = "" } = result ?? {};
    res.writeHead(statusCode, /** @type {any} */ (headers));
    res.end(resBody);
    console.log(`[api] ${method} ${path} → ${statusCode}`);
  } catch (err) {
    console.error(`[api] ${method} ${path} threw:`, err);
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "internal error" }));
  }
});

async function main() {
  await ensureLocalInfra();
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`[api] listening on http://localhost:${PORT}`);
    console.log(
      `[api] routes: ${routes.map((r) => `${r.method} ${r.path}`).join(", ")}`,
    );
  });
}

main().catch((err) => {
  console.error("[api] failed to start:", err);
  process.exit(1);
});
