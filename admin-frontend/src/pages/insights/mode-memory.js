import { matchRoute } from "../../router.js";
import {
  MODE_HOME,
  REDIRECT_ROUTES,
  routeMode,
  safeReturnPath,
} from "./insights-routes.js";

/** @typedef {{ path: string, scrollY: number, focus: string }} ModePlace focus is an element id, since re-rendering replaces elements */

// Off unless the deployed config switches it on, so the code can ship hidden.
/** @param {{ insightsEnabled?: unknown }} config @param {{ viewInsights?: unknown }} capabilities */
export function insightsAvailable(config, capabilities) {
  return config.insightsEnabled === true && capabilities.viewInsights === true;
}

/** @param {string} path @returns {"insights" | "manage" | ""} */
function placeMode(path) {
  const pathname = path.split("?")[0];
  const { name } = matchRoute(pathname);
  // matchRoute falls back to the Site list for any path it doesn't know.
  if (name === "sites" && !/^\/sites\/?$/.test(pathname)) return "";
  // These only redirect, so leaving one says nothing about where the user was.
  if (REDIRECT_ROUTES.has(name)) return "";
  return routeMode(name);
}

// Insights paths are compared as safeReturnPath writes them, since it re-encodes the query.
/** @param {"insights" | "manage" | ""} mode @param {string} path */
function placePath(mode, path) {
  if (mode === "insights") return safeReturnPath(path);
  // Split at the first "?" only; an unencoded "?" can sit inside a value.
  const cut = path.indexOf("?");
  const pathname = cut < 0 ? path : path.slice(0, cut);
  const params = new URLSearchParams(cut < 0 ? "" : path.slice(cut));
  // Re-encoded without the return, so a reopened Site matches itself and drops an old Insights link.
  params.delete("return");
  const query = params.toString();
  return `${pathname}${query ? `?${query}` : ""}`;
}

// Memory only, so a new sign-in, which always reloads, can't open the last account's pages.
export function modeMemory() {
  /** @type {Partial<Record<"insights" | "manage", ModePlace>>} */
  const places = {};
  return {
    /** @param {string} path @param {number} scrollY @param {string} focus */
    leave(path, scrollY, focus) {
      const mode = placeMode(path);
      if (!mode) return;
      const kept = placePath(mode, path);
      // An unsafe page clears the old one, so the tab never reopens a stale page.
      if (kept) places[mode] = { path: kept, scrollY, focus };
      else delete places[mode];
    },
    /** @param {string} path @returns {{ scrollY: number, focus: string } | null} */
    arrive(path) {
      const mode = placeMode(path);
      const place = mode ? places[mode] : undefined;
      if (!place || place.path !== placePath(mode, path)) return null;
      return { scrollY: place.scrollY, focus: place.focus };
    },
    /** @param {"insights" | "manage"} mode */
    href(mode) {
      return places[mode]?.path || MODE_HOME[mode];
    },
  };
}
