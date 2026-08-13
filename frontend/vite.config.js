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
  devDependencies) with a workbox precache of the shell + the write-queue/sync,
  and add the CSP hash for the inline theme script (infra I3). Reference manifest:
    name "Good Neighbor App", short_name "Good Neighbor", display "standalone",
    theme/background "#0f172a", icons icon-192.png / icon-512.png (+ maskable),
    workbox precache of the built js, css, html, woff2, png, and svg assets.
*/
export default defineConfig({
  base: "/",
  plugins: [],
});
