/// <reference types="vite/client" />
/*
  Registers the offline-launch service worker that vite-plugin-pwa generates at
  build time (see `offlineShell` in vite.config.js). It ships in every `vite
  build` bundle, so both deployed environments (dev and prod) get it. The local
  Vite dev server (`npm run dev`, `dev:remote`, e2e) never builds /sw.js and
  stays network-only; `npm run dev:offline` builds and previews to try it.

  Registration waits for `load` so the worker's precache download does not
  compete with the first paint. A failed registration only costs offline
  launch; the app keeps working online.

  No update prompt or reload: the worker fetches the HTML page network first,
  so every online launch already opens on the latest release.
*/

export function registerServiceWorker() {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  window.addEventListener(
    "load",
    () => {
      navigator.serviceWorker.register("/sw.js").catch((error) => {
        console.error("Service worker registration failed", error);
      });
    },
    { once: true },
  );
}
