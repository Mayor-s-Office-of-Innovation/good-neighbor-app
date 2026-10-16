// Dev-server plugin for "frontend-only mode": run the Vite dev server against a
// DEPLOYED API (e.g. https://dev.goodneighborsf.org) instead of the local
// harness, with no backend, JVM, MinIO, or analyzer key on the laptop.
//
// The API calls themselves need nothing beyond `server.proxy` (vite.config.js
// points /v1, /app/v1, /site-code and /health at API_PROXY_TARGET with
// changeOrigin so CloudFront sees the right Host). The one request that does
// NOT go to the API is the presigned media PUT: the backend hands the browser
// an absolute S3 URL and the browser PUTs there directly. From a localhost
// origin that is cross-origin, the browser preflights it, and the bucket's CORS
// (infra/modules/app/main.tf) deliberately lists only the deployed origins.
//
// Rather than widen S3 CORS to localhost (a standing grant to any local web
// page, and permanent AWS config), the browser sends the PUT to THIS server at
// `/__s3/<bucket-host>/<key>?<presigned query>` (services/api.js rewrites the
// URL in dev builds only) and the middleware below forwards it to
// `https://<bucket-host>/<key>?<presigned query>` with the Host header restored.
// SigV4 presigned URLs sign host + path + query + content-type and mark the
// payload unsigned, so the forwarded request validates at S3 unchanged. S3
// still authorizes solely on that signature; this server adds no credentials
// and forwards nothing it didn't receive. Same-origin from the browser's
// view → no preflight at all.
//
// Guardrails: only virtual-hosted S3 hostnames are forwarded (so the dev server
// is not a general open proxy), only PUT/GET/HEAD, and the plugin is only
// installed when API_PROXY_TARGET is an https URL (never for the local harness,
// whose MinIO uploads already have their own proxy entry).

import https from "node:https";

export const S3_UPLOAD_PROXY_PREFIX = "/__s3/";

/** `bucket.s3.<region>.amazonaws.com` — the virtual-hosted form the SDK presigns. */
export const S3_HOST_RE =
  /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]\.s3\.[a-z0-9-]+\.amazonaws\.com$/;

const FORWARDED_METHODS = new Set(["PUT", "GET", "HEAD"]);

/** Hop-by-hop and browser-origin headers that must not be forwarded upstream. */
const STRIP_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
  "origin",
  "referer",
  "cookie",
  "accept-encoding",
]);
const STRIP_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
]);

/**
 * Split `/__s3/<host>/<path>?<query>` into its upstream parts, or null when the
 * URL is not for this middleware or names a host we refuse to forward to.
 * @param {string} url
 * @returns {{ host: string, path: string } | null}
 */
export function parseProxyUrl(url) {
  if (!url.startsWith(S3_UPLOAD_PROXY_PREFIX)) return null;
  const rest = url.slice(S3_UPLOAD_PROXY_PREFIX.length);
  const slash = rest.indexOf("/");
  const host = (slash === -1 ? rest : rest.slice(0, slash)).toLowerCase();
  const path = slash === -1 ? "/" : rest.slice(slash);
  if (!S3_HOST_RE.test(host)) return null;
  return { host, path };
}

/**
 * @param {{ target: string }} options  the https API origin the dev server proxies to
 * @returns {import("vite").Plugin}
 */
export function remoteApiPlugin({ target }) {
  return {
    name: "gnp:remote-api",
    apply: "serve",
    configureServer(server) {
      const { logger } = server.config;
      logger.info(
        `\n  [remote api] proxying /v1, /app/v1, /site-code, /health → ${target}` +
          `\n  [remote api] presigned S3 uploads routed via ${S3_UPLOAD_PROXY_PREFIX}<bucket-host>/… (no CORS change)\n`,
      );

      server.middlewares.use((req, res, next) => {
        const url = req.url ?? "";
        if (!url.startsWith(S3_UPLOAD_PROXY_PREFIX)) return next();

        const parsed = parseProxyUrl(url);
        if (!parsed) {
          res.statusCode = 403;
          res.end("remote api: refusing to forward to a non-S3 host");
          return;
        }
        const method = req.method ?? "GET";
        if (!FORWARDED_METHODS.has(method)) {
          res.statusCode = 405;
          res.end("remote api: only PUT/GET/HEAD are forwarded to S3");
          return;
        }

        /** @type {Record<string, string | string[]>} */
        const headers = {};
        for (const [name, value] of Object.entries(req.headers)) {
          if (value === undefined || STRIP_REQUEST_HEADERS.has(name)) continue;
          headers[name] = value;
        }
        headers.host = parsed.host;

        const upstream = https.request(
          { host: parsed.host, method, path: parsed.path, headers },
          (up) => {
            /** @type {Record<string, string | string[]>} */
            const out = {};
            for (const [name, value] of Object.entries(up.headers)) {
              if (value === undefined || STRIP_RESPONSE_HEADERS.has(name))
                continue;
              out[name] = value;
            }
            res.writeHead(up.statusCode ?? 502, out);
            up.pipe(res);
          },
        );
        upstream.on("error", (err) => {
          logger.error(`[remote api] S3 upload proxy error: ${err.message}`);
          if (!res.headersSent) res.statusCode = 502;
          res.end(`remote api: upstream error: ${err.message}`);
        });
        req.on("aborted", () => upstream.destroy());
        req.pipe(upstream);
      });
    },
  };
}
