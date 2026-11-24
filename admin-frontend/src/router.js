import {
  ANALYTICS_ROUTE,
  INSIGHTS_ROUTES,
} from "./pages/insights/insights-routes.js";

const ROUTES = [
  ...INSIGHTS_ROUTES,
  ANALYTICS_ROUTE,
  [
    "system-status",
    /^\/system-status(?:\/(network|analysis|submissions|checks|issues|actions|deletions|duplicates))?\/?$/,
  ],
  ["provider-manager", /^\/provider-managers\/([^/]+)\/([^/]+)\/?$/],
  ["provider-managers", /^\/provider-managers\/?$/],
  ["profile", /^\/profile\/?$/],
  ["administrator-new", /^\/administrators\/new\/?$/],
  ["administrators", /^\/administrators\/?$/],
  ["manager-new", /^\/managers\/new\/?$/],
  ["manager", /^\/managers\/([^/]+)\/?$/],
  ["managers", /^\/managers\/?$/],
  ["site-new", /^\/sites\/new\/?$/],
  ["site-import", /^\/sites\/import\/?$/],
  ["site", /^\/sites\/([^/]+)\/?$/],
  ["sites", /^\/sites\/?$/],
  ["program-new", /^\/programs\/new\/?$/],
  ["program", /^\/programs\/([^/]+)\/?$/],
  ["programs", /^\/programs\/?$/],
  ["provider-new", /^\/providers\/new\/?$/],
  ["provider", /^\/providers\/([^/]+)\/?$/],
  ["providers", /^\/providers\/?$/],
];

export function currentRoute() {
  return matchRoute(window.location.pathname);
}

/** @param {string} path a pathname, without its query */
export function matchRoute(path) {
  for (const [name, pattern] of ROUTES) {
    const match = pattern.exec(path);
    if (match)
      return {
        name,
        id: match[1] || "",
        ...(match[2] ? { membershipId: match[2] } : {}),
      };
  }
  return { name: "sites", id: "" };
}

export function navigate(path, { replace = false } = {}) {
  if (replace) window.history.replaceState({}, "", path);
  else window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function directoryPath(kind, search = "") {
  const params = new URLSearchParams();
  if (search.trim()) params.set("q", search.trim());
  const query = params.toString();
  return `/${kind}${query ? `?${query}` : ""}`;
}
