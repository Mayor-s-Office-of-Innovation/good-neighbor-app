import { test } from "vitest";
import assert from "node:assert/strict";
import { matchRoute } from "../../router.js";
import {
  carriedQuery,
  returnPathTo,
  routeMode,
  safeReturnPath,
  signInReturnPath,
} from "./insights-routes.js";

test("each Insights page has its own route", () => {
  assert.deepEqual(matchRoute("/insights"), { name: "insights", id: "" });
  assert.deepEqual(matchRoute("/insights/"), { name: "insights", id: "" });
  assert.deepEqual(matchRoute("/insights/sites/s1"), {
    name: "insights-site",
    id: "s1",
  });
  assert.deepEqual(matchRoute("/insights/raw"), {
    name: "insights-raw",
    id: "",
  });
  assert.deepEqual(matchRoute("/insights/raw/issues"), {
    name: "insights-issues",
    id: "",
  });
  assert.deepEqual(matchRoute("/insights/raw/issues/i1"), {
    name: "insights-issue",
    id: "i1",
  });
  assert.deepEqual(matchRoute("/insights/raw/checks"), {
    name: "insights-checks",
    id: "",
  });
  assert.deepEqual(matchRoute("/insights/raw/checks/c1"), {
    name: "insights-check",
    id: "c1",
  });
  assert.deepEqual(matchRoute("/insights/trends"), {
    name: "insights-trends",
    id: "",
  });
});

test("an unknown Insights path is caught, not shown as the Site list", () => {
  assert.equal(matchRoute("/insights/compliance").name, "insights-unknown");
  assert.equal(matchRoute("/insights/sites/s1/extra").name, "insights-unknown");
});

test("a route belongs to Insights, Manage or neither", () => {
  assert.equal(routeMode("insights-trends"), "insights");
  assert.equal(routeMode("sites"), "manage");
  assert.equal(routeMode("site"), "manage");
  assert.equal(routeMode("provider-manager"), "manage");
  for (const name of [
    "system-status",
    "profile",
    "administrators",
    "administrator-new",
    "site-new",
    "site-import",
  ])
    assert.equal(routeMode(name), "", name);
});

test("only the shared period filters carry between Insights pages", () => {
  assert.equal(
    carriedQuery("?period=2026-09&from=2026-09-01&to=2026-10-01&sort=name&q=x"),
    "?period=2026-09&from=2026-09-01&to=2026-10-01",
  );
  assert.equal(carriedQuery("?sort=name"), "");
  assert.equal(carriedQuery(""), "");
});

test("a return path keeps an Insights page and its filters", () => {
  assert.equal(
    safeReturnPath("/insights/sites/s1?period=2026-09&sort=name"),
    "/insights/sites/s1?period=2026-09&sort=name",
  );
  assert.equal(safeReturnPath("/insights"), "/insights");
});

test("a return path outside Insights is refused", () => {
  for (const value of [
    null,
    "",
    "/sites",
    "/system-status",
    "/analytics",
    "https://example.org/insights",
    "//example.org/insights",
    "/\\example.org/insights",
    "javascript:alert(1)",
    "/insights/../sites",
    "/insights/%2e%2e/sites",
    "insights",
    "//[",
    "/\\[",
    "//a b/insights",
    "/\t/[",
    "/\r/a b/insights",
  ])
    assert.equal(safeReturnPath(value), "", String(value));
});

test("a return path with dot segments goes to the page they resolve to", () => {
  assert.equal(
    safeReturnPath("/insights/sites/../trends?period=2026-09"),
    "/insights/trends?period=2026-09",
  );
});

test("a return path to an Insights page that only redirects is refused", () => {
  assert.equal(safeReturnPath("/insights/raw"), "");
  assert.equal(safeReturnPath("/insights/compliance"), "");
});

test("a return path can't carry another return path", () => {
  assert.equal(
    safeReturnPath("/insights?return=%2Finsights%2Ftrends&period=2026-09"),
    "/insights?period=2026-09",
  );
});

test("a return path is refused past 4096 characters", () => {
  const prefix = "/insights?q=";
  const longest = `${prefix}${"a".repeat(4096 - prefix.length)}`;
  assert.equal(safeReturnPath(longest), longest);
  assert.equal(safeReturnPath(`${longest}a`), "");
});

test("a return path keeps every filter key, whatever its name", () => {
  assert.equal(
    safeReturnPath("/insights?Bad-Key=1&site_type=a"),
    "/insights?Bad-Key=1&site_type=a",
  );
});

test("a return path that grows past 4096 characters when encoded is refused", () => {
  assert.equal(safeReturnPath(`/insights?q=${":".repeat(2000)}`), "");
});

test("a return path drops its #fragment", () => {
  assert.equal(safeReturnPath("/insights#top"), "/insights");
});

test("the way back to a page keeps its filters, or only its period past the length cap", () => {
  assert.equal(
    returnPathTo("/insights/raw/issues", "?period=2026-10&severityBand=severe"),
    "/insights/raw/issues?period=2026-10&severityBand=severe",
  );
  const long = `?period=2026-10&siteIds=${"s".repeat(4100)}`;
  assert.equal(
    returnPathTo("/insights/raw/issues", long),
    "/insights/raw/issues?period=2026-10",
  );
});

test("sign-in comes back only to Insights pages and old Analytics links", () => {
  assert.equal(
    signInReturnPath("/insights/sites/s1?period=2026-09"),
    "/insights/sites/s1?period=2026-09",
  );
  // A page that only redirects comes back as where it leads.
  assert.equal(
    signInReturnPath("/insights/raw?period=2026-09"),
    "/insights/raw/issues?period=2026-09",
  );
  assert.equal(signInReturnPath("/insights/nothing-here"), "/insights");
  // Kept, so with Insights off the link still says why.
  assert.equal(signInReturnPath("/analytics/"), "/analytics");
  for (const value of ["/sites", "/programs/p1", "//evil.example", "", null])
    assert.equal(signInReturnPath(value), "", String(value));
});

test("sign-in keeps a record page's way back, and only a safe one", () => {
  const back = encodeURIComponent("/insights/sites/s1?period=2026-09");
  assert.equal(
    signInReturnPath(`/insights/raw/issues/i1?period=2026-09&return=${back}`),
    `/insights/raw/issues/i1?period=2026-09&return=${back}`,
  );
  assert.equal(
    signInReturnPath(
      `/insights/raw/issues/i1?return=${encodeURIComponent("//evil.example/insights")}`,
    ),
    "/insights/raw/issues/i1",
  );
});

test("sign-in past the length cap comes back to the page at its period", () => {
  const sites = Array.from({ length: 600 }, (_, i) => `site-${i}`).join(",");
  assert.equal(
    signInReturnPath(`/insights/trends?period=2026-09&sites=${sites}`),
    "/insights/trends?period=2026-09",
  );
});
