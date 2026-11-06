/** @type {[string, RegExp][]} */
export const INSIGHTS_ROUTES = [
  ["insights", /^\/insights\/?$/],
  ["insights-site", /^\/insights\/sites\/([^/]+)\/?$/],
  ["insights-raw", /^\/insights\/raw\/?$/],
  ["insights-issues", /^\/insights\/raw\/issues\/?$/],
  ["insights-issue", /^\/insights\/raw\/issues\/([^/]+)\/?$/],
  ["insights-checks", /^\/insights\/raw\/checks\/?$/],
  ["insights-check", /^\/insights\/raw\/checks\/([^/]+)\/?$/],
  ["insights-trends", /^\/insights\/trends\/?$/],
  // Without this, an old or mistyped link would show the Site list at an Insights URL.
  ["insights-unknown", /^\/insights\//],
];

// They only redirect, so they are never a place to go back to.
export const REDIRECT_ROUTES = new Set(["insights-raw", "insights-unknown"]);

// Pages a mode tab may reopen; creation, import and Settings pages start over.
const MANAGE_ROUTES = new Set([
  "sites",
  "site",
  "managers",
  "manager",
  "providers",
  "provider",
  "programs",
  "program",
  "provider-managers",
  "provider-manager",
]);

export const MODE_HOME = Object.freeze({
  manage: "/sites",
  insights: "/insights",
});

// Every Insights page reads the same period, so switching pages keeps it.
const CARRIED_KEYS = ["period", "from", "to"];

// Room for a Trends scope of 50 Site IDs, well under CloudFront's 8 KB URL limit.
const MAX_RETURN_LENGTH = 4096;

/** @param {string} name @returns {"insights" | "manage" | ""} */
export function routeMode(name) {
  if (name.startsWith("insights")) return "insights";
  return MANAGE_ROUTES.has(name) ? "manage" : "";
}

/** @param {string} search @returns {string} */
export function carriedQuery(search) {
  const params = new URLSearchParams(search);
  const kept = new URLSearchParams();
  for (const key of CARRIED_KEYS)
    for (const value of params.getAll(key)) kept.append(key, value);
  const query = kept.toString();
  return query ? `?${query}` : "";
}

// Only real Insights pages pass, so a crafted link can't send anyone off-site or loop.
/** @param {string | null | undefined} value @returns {string} */
export function safeReturnPath(value) {
  if (!value || value.length > MAX_RETURN_LENGTH || !value.startsWith("/"))
    return "";
  const base = "http://return.invalid";
  /** @type {URL} */
  let url;
  try {
    // Resolves dot segments, so "/insights/../sites" is checked as "/sites".
    url = new URL(value, base);
  } catch {
    // A crafted host part such as "//[" must not stop the page from opening.
    return "";
  }
  if (url.origin !== base) return "";
  const name = INSIGHTS_ROUTES.find(([, pattern]) =>
    pattern.test(url.pathname),
  )?.[0];
  if (!name || REDIRECT_ROUTES.has(name)) return "";
  const kept = new URLSearchParams();
  for (const [key, entry] of url.searchParams)
    if (key !== "return") kept.append(key, entry);
  const query = kept.toString();
  const path = `${url.pathname}${query ? `?${query}` : ""}`;
  // Re-encoding can lengthen it, and a path this check refuses can't be matched later.
  return path.length > MAX_RETURN_LENGTH ? "" : path;
}

/**
 * A way back to this page; past the length cap, this page at its period.
 * @param {string} pathname
 * @param {string} search
 */
export const returnPathTo = (pathname, search) =>
  safeReturnPath(`${pathname}${search}`) ||
  `${pathname}${carriedQuery(search)}`;
