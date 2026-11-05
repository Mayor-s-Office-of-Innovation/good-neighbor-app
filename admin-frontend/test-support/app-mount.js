/*
  Mounts the whole <admin-app>. Kept apart from admin-dom.js, so a test file
  that mounts only one page doesn't load main.js and every page it imports.
*/
import { $$, attach, startMount } from "./admin-dom.js";

await import("../src/main.js");
// src/admin-app.js lazy-loads the /system-status page; Vite's first load of that file
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
  const element = /** @type {any} */ (document.createElement("admin-app"));
  // Catches a page pushing to or splicing a catalog list instead of calling a catalog method.
  element.catalog.freezeLists();
  const app = await attach(element);
  return { app, api };
}

// CSS class: back links share the brand link's href and data-route.
export const brandLink = "a.brand";

/** Text of every alert on the page, such as a failed action's notice. */
export function alertText() {
  return $$('[role="alert"]')
    .map((alert) => alert.textContent.replace(/\s+/g, " ").trim())
    .join(" ");
}

/**
 * Wait for work settle() can't see, such as a digest off the event loop.
 * The deadline is wall-clock time, since the fake clock doesn't move it.
 * @param {() => unknown} predicate
 * @param {{ timeout?: number }} [options] milliseconds
 */
export async function waitFor(predicate, { timeout = 1000 } = {}) {
  const deadline = performance.now() + timeout;
  while (!predicate()) {
    if (performance.now() > deadline)
      throw new Error(`waitFor(): condition still false after ${timeout} ms`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}
