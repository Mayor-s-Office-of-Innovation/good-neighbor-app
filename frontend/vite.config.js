import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import { VitePWA } from "vite-plugin-pwa";
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

  PWA: public/manifest.webmanifest (static, linked from index.html) plus the
  icon set that scripts/make-pwa-icons.mjs derives from public/img/gn-logo.png,
  and the Add-to-Home-Screen offer in src/services/install-prompt.js. The
  service worker (see `offlineShell` below) only makes the app open offline.

  A service worker is NOT needed for install (researched 2026-10-20, written
  up in ../notes/pwa-install-plan.md). Chromium's installability evaluator
  (components/webapps/browser/installable/installable_evaluator.cc on main)
  checks only: secure origin, not incognito, a parseable manifest with a
  valid start_url, name or short_name, a supported display, and a suitable
  icon. No worker, fetch-handler, or offline check. Chrome 108 (Android) /
  112 (desktop) dropped the worker requirement for menu install; the
  beforeinstallprompt event followed later (exact version not pinned, but
  Google's criteria page stopped listing it by Sept 2024). iOS Safari never
  required one. The only devices that still need a worker to install are
  stuck on old Chrome: Android 5 (Chrome 95) and 6 (Chrome 106) cannot
  install at all without one; Android 7 (Chrome 119) can from the menu and
  maybe not from the prompt. Under 1% of Play devices combined as of Jan 2026.
  Third-party pages that still say "fetch handler required" are stale.

  What a worker DOES buy is the offline launch: without one, an app opened or
  reloaded with no network gets the browser's generic offline page instead of
  the shell.
*/

/*
  Offline launch (issue #109). A Workbox precache of the built shell so the app
  opens, reloads, and loads its lazy screens with no network. It caches files
  only: API calls are never intercepted, and queuing writes stays in the app
  (services/care-submissions.js) rather than Workbox background sync, which
  iOS does not support.

  - `manifest: false`: the static public/manifest.webmanifest stays the source
    of truth.
  - `injectRegister: false`: src/services/service-worker.js registers it from a
    module, not an inline script — the CSP hash for the inline theme script is
    set in infra (see the script-src note in infra/modules/app/main.tf).
    worker-src falls back to script-src 'self', which already covers /sw.js.
  - Built into every `vite build` bundle, so the deployed dev and prod
    environments both get it; the local Vite dev server (and e2e) never do.
  - The HTML page is network first, so every online launch gets the latest
    release. A navigation waits up to 3 s for the network, then falls back to
    the precached index.html; with no signal at all the fallback is instant.
    It does not keep its own per-URL copies: after a deploy those could point
    at hashed files the precache has already dropped. The precached page always
    matches the precached files. API routes and paths with a file extension
    are never answered with the page, mirroring the CloudFront SPA rewrite
    (infra/modules/app/cloudfront.tf). `directoryIndex: null` keeps the
    precache from answering "/" itself.
  - JS, CSS, and icons are cache first through the precache: their hashed
    names never go stale.
  - skipWaiting + clientsClaim: a new worker takes over as soon as it installs.
    An open page keeps running the code it loaded; a lazy chunk it still needs
    from the previous release falls through to the network, where
    scripts/publish-web-assets.sh keeps old assets.
  - Category artwork (~2 MB, light + dark) is cached as it is shown rather than
    downloaded up front. Source maps are never cached (or published).
  - Manager screens (site admin, access, reports) are left out: they are not
    part of field work and need fresh data anyway, so offline they show the
    route's load error. Other languages (src/i18n/i18n.js catalogs plus their
    Web Awesome translations) are cached only once someone switches to one;
    English is in the main bundle. Both lists match chunk names, so update
    them when those chunks are renamed or new ones are added.
*/
const managerChunks = "{site-admin,site-access-*,reports-view,qr-code}";
const languageChunks = "{es,fil,vi,zh-Hant,zh-tw}";
const offlineShell = VitePWA({
  manifest: false,
  injectRegister: false,
  workbox: {
    globPatterns: [
      "**/*.{js,css,html,svg,ico,webp,webmanifest}",
      "{img,icons}/*.png",
    ],
    globIgnores: [
      `assets/${managerChunks}-*.{js,css}`,
      `assets/${languageChunks}-*.js`,
    ],
    navigateFallback: null,
    directoryIndex: null,
    runtimeCaching: [
      {
        // Serialized into sw.js: keep it self-contained (no outer references).
        urlPattern: ({ request, sameOrigin, url }) =>
          request.mode === "navigate" &&
          sameOrigin &&
          !/^\/(?:v1|app\/v1|site-code|submissions|health)(?:\/|$)/.test(
            url.pathname,
          ) &&
          !/\.[^/]*$/.test(url.pathname),
        handler: "NetworkFirst",
        options: {
          cacheName: "pages",
          networkTimeoutSeconds: 3,
          plugins: [
            {
              // Don't save each page we fetch: after a deploy, an offline
              // launch from a saved copy would ask for the old release's JS
              // files, which the precache has already deleted. When the
              // network fails, serve the precached page, which always matches
              // the precached files.
              cacheWillUpdate: async () => null,
              handlerDidError: async () =>
                (await caches.match("/index.html", { ignoreSearch: true })) ??
                Response.error(),
            },
          ],
        },
      },
      {
        urlPattern: ({ sameOrigin, url }) =>
          sameOrigin && url.pathname.startsWith("/category-icons/"),
        handler: "StaleWhileRevalidate",
        options: {
          cacheName: "category-icons",
          expiration: { maxEntries: 60 },
        },
      },
      {
        // Hashed names, so cache first is safe; the cap drops old releases.
        urlPattern: ({ sameOrigin, url }) =>
          sameOrigin &&
          /^\/assets\/(?:es|fil|vi|zh-Hant|zh-tw)-[^/]+\.js$/.test(
            url.pathname,
          ),
        handler: "CacheFirst",
        options: {
          cacheName: "languages",
          expiration: { maxEntries: 20 },
        },
      },
    ],
    cleanupOutdatedCaches: true,
    skipWaiting: true,
    clientsClaim: true,
    sourcemap: false,
  },
});
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
    plugins: [
      offlineShell,
      ...(remoteApi ? [remoteApiPlugin({ target: apiProxyTarget })] : []),
    ],
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
