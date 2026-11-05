/*
  Mounts the whole <admin-app>. Kept apart from admin-dom.js, so a test file
  that mounts only one page doesn't load main.js and every page it imports.
*/
import { attach, startMount } from "./admin-dom.js";

await import("../src/main.js");
// main.js lazy-loads the /system-status page; Vite's first load of that file
// outlasts settle(), so a test on that page would assert before it draws.
await import("../src/system-status.js");

/**
 * Mount a fresh <admin-app> at `path` against fresh synthetic data.
 * @param {string} path
 * @param {{ role?: "compliance-supervisor" | "compliance-manager", data?: any, setup?: (api: any) => void, fetch?: (url: string, init: any) => Response | undefined }} [options]
 */
export async function mountAdmin(path = "/sites", options = {}) {
  const api = await startMount(path, options);
  options.setup?.(api);
  const app = await attach(document.createElement("admin-app"));
  return { app, api };
}
