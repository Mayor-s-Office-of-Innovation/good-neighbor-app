import { defineConfig } from "vite";

/*
  Served from the site root (S3/CloudFront), so base is "/" — paired with the
  History-API router (src/router.js). Deep-link/refresh 404s are handled by a
  CloudFront custom-error-response → index.html fallback provisioned with the
  deploy stage (infra I1); Vite's dev/preview server already serves that SPA
  fallback locally.

  TODO(offline pass): the PWA is intentionally OFF for the MVP — no service
  worker is generated or registered while we finalize screens. When we do the
  dedicated offline pass, re-wire vite-plugin-pwa here (it's already in
  devDependencies) with a workbox precache of the shell + the write-queue/sync.
  (The CSP hash for the inline theme script is now set in infra — see the
  script-src note in infra/modules/app/main.tf; regenerate it there if that
  script changes.) Reference manifest:
    name "Good Neighbor App", short_name "Good Neighbor", display "standalone",
    theme/background "#0f172a", icons icon-192.png / icon-512.png (+ maskable),
    workbox precache of the built js, css, html, woff2, png, and svg assets.
*/
export default defineConfig({
  base: "/",
  plugins: [],
  define: {
    // Release stamp for error reports (services/error-report.js reads
    // __RELEASE__) and the key for the CI sourcemap upload. CI sets RELEASE_SHA
    // (deploy.yml); local builds get "dev". Guarded for non-Node contexts.
    __RELEASE__: JSON.stringify(
      typeof process !== "undefined" && process.env.RELEASE_SHA
        ? process.env.RELEASE_SHA
        : "dev",
    ),
  },
  build: {
    // Source maps for the error tracker's symbolication (Phase 3 of the
    // error-tracking plan). deploy.yml uploads them to PostHog and EXCLUDES
    // them from the public S3 sync — public maps would leak full source.
    sourcemap: true,
  },
  server: {
    // Dev-only: proxy the backend API to the local harness (npm run dev -w
    // backend, :3001) so the app calls same-origin paths — no CORS, and the
    // router needs no CORS headers. Because the proxy runs on the dev machine
    // and forwards to 127.0.0.1, this also works when the app is opened from a
    // phone on the LAN (e.g. `npm run dev:lan`): the browser only ever talks to
    // this origin. Keep this route list in step with the local-api.mjs routes.
    // In production the SPA and API share one CloudFront distribution, so the
    // app uses a same-origin base and calls these same relative paths (see
    // services/api.js + services/onboarding.js); presigned S3 PUTs go straight
    // to their own origin and never touch this proxy.
    proxy: {
      "/v1": "http://localhost:3001",
      "/site-code": "http://localhost:3001",
      "/health": "http://localhost:3001",
    },
  },
});
