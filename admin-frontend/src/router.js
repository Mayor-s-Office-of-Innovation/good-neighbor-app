const ROUTES = [
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
  const path = window.location.pathname;
  for (const [name, pattern] of ROUTES) {
    const match = pattern.exec(path);
    if (match) return { name, id: match[1] || "" };
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
