import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import { remoteApiPlugin } from "./scripts/vite-remote-api.mjs";

const releaseSha =
  /** @type {{ process?: { env?: { RELEASE_SHA?: string } } }} */ (globalThis)
    .process?.env?.RELEASE_SHA ?? "dev";

/*
  Served from the site root (S3/CloudFront), so base is "/" — paired with the
  History-API router (src/router.js). Deep-link/refresh 404s are handled by the
  frontend_spa_rewrite viewer-request CloudFront Function rewriting non-asset
  paths to /index.html before the S3 origin (infra/modules/app/cloudfront.tf);
  Vite's dev/preview server serves the same SPA fallback locally.

  TODO(offline pass): the service worker is intentionally OFF for the MVP —
  none is generated or registered while we finalize screens. The installable
  half of the PWA does ship: public/manifest.webmanifest (static, linked from
  index.html) plus the icon set that scripts/make-pwa-icons.mjs derives from
  public/img/gn-logo.png, and the Add-to-Home-Screen offer in
  src/services/install-prompt.js. When we do the dedicated offline pass,
  re-wire vite-plugin-pwa here (it's already in devDependencies) with
  `manifest: false` so the static manifest stays the source of truth, and a
  workbox precache of the built js, css, html, woff2, png, and svg assets +
  the write-queue/sync. (The CSP hash for the inline theme script is set in
  infra — see the script-src note in infra/modules/app/main.tf; regenerate it
  there if that script changes.)
*/
export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const localMinioApiPort = env.LOCAL_MINIO_API_PORT || "9000";

  // Where the dev server forwards API paths. Default: the Docker-free local
  // harness (npm run dev -w backend). Set API_PROXY_TARGET to a deployed origin
  // (npm run dev:remote → https://dev.goodneighborsf.org) for "frontend-only
  // mode": no local backend, JVM, MinIO, or analyzer key. Not VITE_-prefixed, so
  // it never reaches the client bundle. An https target also installs the
  // remote-api plugin that carries presigned S3 uploads through this server
  // (see scripts/vite-remote-api.mjs for why that beats widening S3 CORS).
  const apiProxyTarget = env.API_PROXY_TARGET || "http://localhost:3001";
  const remoteApi = /^https:\/\//i.test(apiProxyTarget);
  // CloudFront routes by Host, so a deployed target needs the browser's
  // `127.0.0.1:5173` Host rewritten to the target's; the local harness doesn't.
  const apiProxy = { target: apiProxyTarget, changeOrigin: remoteApi };

  return {
    base: "/",
    resolve: {
      alias: [
        // Web Awesome's built-in "system" icon library is ~40 kB of inlined
        // Font Awesome SVGs registered at import time and looked up by name,
        // so it cannot be tree-shaken. None of the components we load (icon,
        // otp-input, textarea, spinner) draw a system icon. The replacement
        // resolves system icon names to the same self-hosted set as our
        // `default` library instead — see src/lib/wa-system-icons.js for the
        // rule when adding a Web Awesome component that does use one.
        // The regex must match the WHOLE specifier (hence the leading ^.*):
        // a regex alias replaces only the matched part, so a bare filename
        // match would leave a broken "../../chunks/<abs path>". Keyed on the
        // vendor chunk's hashed filename; if a Web Awesome upgrade renames
        // it, the build still succeeds and size-limit reports the ~8 kB
        // brotli regression.
        {
          find: /^.*chunk\.LDM2MW63\.js$/,
          // import.meta.url (not import.meta.dirname): Vite rewrites it to
          // the real config path when it bundles this file to a temp dir.
          replacement: fileURLToPath(
            new URL("./src/lib/wa-system-icons.js", import.meta.url),
          ),
        },
      ],
    },
    plugins: remoteApi ? [remoteApiPlugin({ target: apiProxyTarget })] : [],
    define: {
      // Release stamp for error reports (services/error-report.js reads
      // __RELEASE__) and the key for the CI sourcemap upload. CI sets RELEASE_SHA
      // (deploy.yml); local builds get "dev". Guarded for non-Node contexts.
      __RELEASE__: JSON.stringify(releaseSha),
      // Dev-server-only switch read by services/api.js: route presigned S3 PUTs
      // through this server's /__s3/ middleware. `false` in every build, so the
      // rewrite is dead code in production bundles.
      __S3_UPLOAD_PROXY__: JSON.stringify(command === "serve" && remoteApi),
    },
    build: {
      // Source maps for the error tracker's symbolication (Phase 3 of the
      // error-tracking plan). deploy.yml uploads them to PostHog and EXCLUDES
      // them from the public S3 sync — public maps would leak full source.
      sourcemap: true,
      rollupOptions: {
        output: {
          // Keep shared localization/escaping separate from the application
          // entry as lazy card controls and dialogs are added to the graph.
          manualChunks(id) {
            if (
              /\/src\/(i18n\/(i18n|locale)\.js|i18n\/catalogs\/en\.json|lib\/html\.js)$/.test(
                id,
              )
            )
              return "shared-ui";
          },
        },
      },
    },
    server: {
      // HTTPS tunnel used for camera/location testing on physical devices. The
      // leading dot permits generated ngrok subdomains without allowing arbitrary
      // Host headers through Vite's DNS-rebinding protection.
      allowedHosts: [
        ".ngrok-free.dev",
        "randi-nonstereotypical-alfredo.ngrok-free.dev",
      ],
      // Dev-only: proxy the backend API (local harness on :3001 by default, or
      // API_PROXY_TARGET) so the app calls same-origin paths — no CORS, and the
      // router needs no CORS headers. Because the proxy runs on the dev machine,
      // this also works when the app is opened from a phone on the LAN (e.g.
      // `npm run dev:lan`): the browser only ever talks to this origin. Keep
      // this route list in step with the local-api.mjs routes and the CloudFront
      // API behaviors (infra/modules/app/cloudfront.tf). In production the SPA
      // and API share one CloudFront distribution, so the app uses a same-origin
      // base and calls these same relative paths (see services/api.js +
      // services/onboarding.js); presigned S3 PUTs go straight to their own
      // origin and never touch this proxy (except in remote mode — see above).
      proxy: {
        "/v1": apiProxy,
        "/app/v1": apiProxy,
        "/site-code": apiProxy,
        "/health": apiProxy,
        // DynamoDB/SQS stay behind the API, but presigned media uploads go
        // directly to S3. Proxy the local bucket path so a phone using the HTTPS
        // ngrok origin can reach MinIO without receiving an unusable localhost
        // upload URL. Set S3_PUBLIC_PRESIGN_ENDPOINT to the tunnel origin when
        // exercising this path; private storage operations continue using the
        // local AWS_ENDPOINT_URL_S3 value.
        "/gnp-local-uploads": {
          target: `http://localhost:${localMinioApiPort}`,
          changeOrigin: false,
        },
      },
    },
  };
});
