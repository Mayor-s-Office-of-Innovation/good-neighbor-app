import { registerIconLibrary } from "@awesome.me/webawesome/dist/components/icon/library.js";

// The admin CSP permits same-origin icon requests, not the default CDN.
// Keep every named admin icon in public/icons so Vite publishes it with the app.
registerIconLibrary("default", {
  resolver: (name) => `${import.meta.env.BASE_URL}icons/${name}.svg`,
  mutator: (svg) => svg.setAttribute("fill", "currentColor"),
});
