import { test, vi } from "vitest";
import assert from "node:assert/strict";
import {
  $,
  click,
  fill,
  focused,
  missing,
  pageError,
  routeTo,
  settle,
  text,
  window,
} from "../test-support/admin-dom.js";
import { mountAdmin, waitFor } from "../test-support/app-mount.js";
import { gate } from "../../e2e/admin-tests/admin-mock.js";
import { t } from "../../frontend/src/i18n/i18n.js";
import { insightsDownload } from "./pages/insights/insights-page.js";
import { matchRoute } from "./router.js";

const manageTab = '#admin-modes a[data-mode="manage"]';
const insightsTab = '#admin-modes a[data-mode="insights"]';
const leaveDialog = "#site-unsaved-dialog";
const siteName = 'admin-app wa-input[name="site-name"]';
const url = () => window.location.pathname + window.location.search;
const heading = () => $("admin-app h1").textContent.trim();
/** @param {string} selector */
const current = (selector) => $(selector).getAttribute("aria-current");

/** Make the Insights download fail, as a dropped connection would. */
function failInsightsLoad() {
  vi.spyOn(insightsDownload, "start").mockImplementation(() =>
    Promise.reject(new Error("chunk failed")),
  );
}

/** Hold the Insights download until released; counts each start. */
function holdInsightsLoad() {
  const load = insightsDownload.start;
  const held = gate();
  const hold = { release: held.release, starts: 0 };
  vi.spyOn(insightsDownload, "start").mockImplementation(async () => {
    hold.starts += 1;
    await held.promise;
    return load();
  });
  return hold;
}

test("with Insights switched off, no tabs show and Insights links open Sites", async () => {
  await mountAdmin("/insights/trends");
  assert.equal(url(), "/sites");
  assert.ok(missing("#admin-modes"));
  assert.equal(heading(), t("admin.breadcrumb.admin"));
});

test("a session without Insights keeps it hidden even when switched on", async () => {
  await mountAdmin("/insights", {
    insights: true,
    role: "compliance-manager",
    setup: (api) =>
      api.on("GET", /^session$/, {
        json: { role: "compliance-manager", capabilities: {} },
      }),
  });
  assert.equal(url(), "/sites");
  assert.ok(missing("#admin-modes"));
});

test("with Insights on, the dashboard still opens on Sites under Manage", async () => {
  await mountAdmin("/sites", { insights: true });
  assert.equal(heading(), t("admin.breadcrumb.admin"));
  assert.equal(current(manageTab), "true");
  assert.equal(current(insightsTab), null);
  assert.equal(text(insightsTab), t("admin.modes.insights"));
});

test("Settings pages mark neither tab", async () => {
  await mountAdmin("/profile", { insights: true });
  assert.equal(current(manageTab), null);
  assert.equal(current(insightsTab), null);
});

test("opening Insights shows Overview with no Manage Site or record reads", async () => {
  const { api } = await mountAdmin("/insights", { insights: true });
  assert.equal(heading(), t("admin.insights.overview"));
  assert.equal(current(insightsTab), "true");
  assert.equal(
    current('#insights-nav a[data-insights-nav="overview"]'),
    "page",
  );
  assert.ok(focused("#insights-title"));
  // Only Manage's shared lists, for filter names; no Site or record reads.
  assert.deepEqual(
    api
      .calls("GET", /^(?!session$|reporting\/)/)
      .map((/** @type {any} */ c) => c.path + c.search)
      .sort(),
    ["oversight-options", "program-managers", "programs", "providers"],
  );
});

test("Insights pages keep the period when moving between them", async () => {
  await mountAdmin("/insights?period=2026-09&sort=name", { insights: true });
  await click('#insights-nav a[data-insights-nav="raw"]');
  assert.equal(url(), "/insights/raw/issues?period=2026-09");
  assert.equal(heading(), t("admin.insights.raw"));
  assert.equal(current('a[data-insights-raw="issues"]'), "page");
  // The row above holds the section, so only one link names this page.
  assert.equal(current('#insights-nav a[data-insights-nav="raw"]'), "true");
  await click('a[data-insights-raw="checks"]');
  assert.equal(url(), "/insights/raw/checks?period=2026-09");
  await click('#insights-nav a[data-insights-nav="trends"]');
  assert.equal(url(), "/insights/trends?period=2026-09");
  assert.equal(heading(), t("admin.insights.trends"));
});

test("record pages name their record", async () => {
  // i1 isn't in the reporting data, so its ID is all there is to name it by.
  await mountAdmin("/insights/raw/issues/i1", { insights: true });
  assert.equal(heading(), t("admin.insights.issue", { id: "i1" }));
  await routeTo("/insights/raw/checks/c1");
  assert.equal(heading(), t("admin.insights.check", { id: "c1" }));
  // A record replaces its list, so only the Raw data tab marks where it sits.
  assert.ok(missing("a[data-insights-raw]"));
  assert.equal(current('#insights-nav a[data-insights-nav="raw"]'), "true");
  await routeTo("/insights/sites/s1");
  assert.equal(heading(), "Example Site");
  assert.equal(
    current('#insights-nav a[data-insights-nav="overview"]'),
    "true",
  );
});

test("Raw data opens Issues, and an unknown Insights page opens Overview", async () => {
  await mountAdmin("/insights/raw?period=2026-09", { insights: true });
  assert.equal(url(), "/insights/raw/issues?period=2026-09");
  await routeTo("/insights/compliance");
  assert.equal(url(), "/insights");
  assert.equal(heading(), t("admin.insights.overview"));
});

test("each tab reopens the last page used in its mode", async () => {
  await mountAdmin("/sites/s1?section=oversight", { insights: true });
  await click(insightsTab);
  assert.equal(url(), "/insights");
  await click('#insights-nav a[data-insights-nav="trends"]');
  await click(manageTab);
  assert.equal(url(), "/sites/s1?section=oversight");
  assert.equal(heading(), "Example Site");
  await click(insightsTab);
  assert.equal(url(), "/insights/trends");
});

test("the tab for the current mode goes to that mode's home", async () => {
  await mountAdmin("/sites/s1", { insights: true });
  await click(insightsTab);
  await click('#insights-nav a[data-insights-nav="trends"]');
  await click(manageTab);
  assert.equal(url(), "/sites/s1");
  assert.equal($(manageTab).getAttribute("href"), "/sites");
  assert.equal($(insightsTab).getAttribute("href"), "/insights/trends");
});

test("switching back to a mode restores where the page was scrolled", async () => {
  await mountAdmin("/insights/trends", { insights: true });
  window.scrollTo(0, 250);
  await click(manageTab);
  window.scrollTo(0, 100);
  await click(insightsTab);
  assert.equal(window.scrollY, 250);
  await click(manageTab);
  assert.equal(window.scrollY, 100);
});

test("browser Back from Insights returns to the Site list", async () => {
  await mountAdmin("/sites", { insights: true });
  await click(insightsTab);
  window.history.back();
  await settle();
  assert.equal(url(), "/sites");
  assert.equal(heading(), t("admin.breadcrumb.admin"));
  assert.equal(current(manageTab), "true");
});

test("unsaved Site edits ask before Insights opens; Keep editing stays", async () => {
  await mountAdmin("/sites/s1", { insights: true });
  await fill(siteName, "Example Site Renamed");
  await click(insightsTab);
  assert.equal($(leaveDialog).open, true);
  await click(`${leaveDialog} button[value="keep"]`);
  assert.equal(url(), "/sites/s1");
  assert.equal($(siteName).value, "Example Site Renamed");
});

test("discarding unsaved Site edits opens Insights", async () => {
  await mountAdmin("/sites/s1", { insights: true });
  await fill(siteName, "Example Site Renamed");
  await click(insightsTab);
  await click(`${leaveDialog} button[value="discard"]`);
  assert.equal(url(), "/insights");
  assert.equal(heading(), t("admin.insights.overview"));
});

test("after discarding edits, the Manage tab reopens the Site just left", async () => {
  await mountAdmin("/sites/s1", { insights: true });
  await fill(siteName, "Example Site Renamed");
  await click(insightsTab);
  await click(`${leaveDialog} button[value="discard"]`);
  await click(manageTab);
  assert.equal(url(), "/sites/s1");
});

test("browser Back into Insights with unsaved Site edits asks first", async () => {
  await mountAdmin("/insights", { insights: true });
  await click(manageTab);
  await click('admin-app a[href="/sites/s1"]');
  await fill(siteName, "Example Site Renamed");
  window.history.go(-2);
  await settle();
  assert.equal($(leaveDialog).open, true);
  assert.equal(url(), "/sites/s1");
});

test("an Insights page that fails to load offers Retry, and Manage still works", async () => {
  const reload = vi
    .spyOn(window.location, "reload")
    .mockImplementation(() => {});
  await mountAdmin("/sites", { insights: true });
  failInsightsLoad();
  await click(insightsTab);
  assert.equal(pageError(), t("admin.insights.loadError"));
  assert.ok(!missing("#retry-page-load"));
  await click(manageTab);
  assert.equal(url(), "/sites");
  assert.equal(pageError(), "");
  assert.equal(heading(), t("admin.breadcrumb.admin"));
  assert.equal(reload.mock.calls.length, 0);
});

test("trying Insights again after a failed download reloads the page", async () => {
  const reload = vi
    .spyOn(window.location, "reload")
    .mockImplementation(() => {});
  await mountAdmin("/sites", { insights: true });
  failInsightsLoad();
  await click(insightsTab);
  await click("#retry-page-load");
  assert.equal(reload.mock.calls.length, 1);
  assert.equal(url(), "/insights");
});

test("a slow Insights load can't replace Manage once the user moves on", async () => {
  await mountAdmin("/sites", { insights: true });
  const held = holdInsightsLoad();
  await click(insightsTab);
  assert.ok(!missing('#main-content > p[role="status"]'));
  await click(manageTab);
  await click('admin-app a[href="/sites/s1"]');
  await fill(siteName, "Example Site Renamed");
  held.release();
  await settle();
  assert.equal(url(), "/sites/s1");
  // A late render would rebuild the form and lose the edit.
  assert.equal($(siteName).value, "Example Site Renamed");
});

test("System Status still opens for a Supervisor with Insights on", async () => {
  await mountAdmin("/system-status", {
    insights: true,
    // The status panel's own reads aren't in the shared mock; an empty one still renders.
    setup: (api) => api.on("GET", /^system-status/, { json: {} }),
  });
  assert.ok(!missing("system-status-view"));
  assert.equal(current(manageTab), null);
});

test("a Manage Site link with a return offers a way back to Insights", async () => {
  await mountAdmin(
    `/sites/s1?return=${encodeURIComponent("/insights/sites/s1?period=2026-09")}`,
    { insights: true },
  );
  assert.equal(heading(), "Example Site");
  assert.equal(
    $("#insights-return").getAttribute("href"),
    "/insights/sites/s1?period=2026-09",
  );
  await click('a[data-route][href^="/sites/s1?section=oversight"]');
  assert.ok(!missing("#site-oversight-form"));
  await click("#insights-return");
  assert.equal(url(), "/insights/sites/s1?period=2026-09");
  assert.ok(focused("#insights-title"));
});

test("Back to Insights stays while the Site's own links drop the return", async () => {
  await mountAdmin(
    `/sites/s1?return=${encodeURIComponent("/insights/sites/s1?period=2026-09")}`,
    { insights: true },
  );
  await routeTo("/sites/s1?section=compliance");
  assert.equal(
    $("#insights-return").getAttribute("href"),
    "/insights/sites/s1?period=2026-09",
  );
  await routeTo("/sites/s2");
  assert.ok(missing("#insights-return"));
  await routeTo("/sites/s1");
  assert.ok(missing("#insights-return"));
});

test("a session that ends on an Insights page hides the page", async () => {
  const { app } = await mountAdmin("/insights", { insights: true });
  const config = /** @type {any} */ (window).GOOD_NEIGHBOR_ADMIN_CONFIG;
  const was = config.localDebugAdmin;
  config.localDebugAdmin = false;
  try {
    app.render();
    assert.ok(!missing("#sign-in"));
    assert.ok(missing("#insights-page"));
  } finally {
    config.localDebugAdmin = was;
  }
});

test("clicking on while Insights downloads starts one download", async () => {
  await mountAdmin("/sites", { insights: true });
  const held = holdInsightsLoad();
  await click(insightsTab);
  await routeTo("/insights/trends");
  held.release();
  await settle();
  assert.equal(held.starts, 1);
  assert.equal(heading(), t("admin.insights.trends"));
});

test("ids that need encoding reach the Site and the page title intact", async () => {
  // A slash, which a URL parser leaves alone, so only encodeURIComponent keeps it in the ID.
  const { api } = await mountAdmin("/insights/sites/a%2Fb", { insights: true });
  assert.equal(api.calls("GET", /^reporting\/sites\/a%2Fb(\?|$)/).length, 1);
  await routeTo("/insights/raw/issues/i%201");
  assert.equal(heading(), t("admin.insights.issue", { id: "i 1" }));
});

test("a very long Insights address still leaves a way back, with its period", async () => {
  const long = `/insights/sites/s1?period=2026-10&q=${"a".repeat(4100)}`;
  await mountAdmin(long, { insights: true });
  const issue = new URL(
    $('[data-issue-row="t2"] a').getAttribute("href"),
    "https://x",
  );
  assert.equal(
    issue.searchParams.get("return"),
    "/insights/sites/s1?period=2026-10",
  );
});

test("leaving Insights before it loads doesn't remember the unseen page", async () => {
  await mountAdmin("/sites", { insights: true });
  const held = holdInsightsLoad();
  await routeTo("/insights/trends");
  await click(manageTab);
  held.release();
  await settle();
  assert.equal($(insightsTab).getAttribute("href"), "/insights");
});

test("the open Insights tab goes to Overview for the same period", async () => {
  await mountAdmin("/insights/trends?period=2026-09&sort=name", {
    insights: true,
  });
  assert.equal($(insightsTab).getAttribute("href"), "/insights?period=2026-09");
});

test("a Site left for Insights comes back without reading it again", async () => {
  const { api } = await mountAdmin("/sites/s1", { insights: true });
  await click(insightsTab);
  const reads = api.calls("GET", /./).length;
  await click(manageTab);
  assert.equal(heading(), "Example Site");
  assert.equal(api.calls("GET", /./).length, reads);
});

test("a way back that isn't an Insights page is not offered", async () => {
  await mountAdmin(`/sites/s1?return=${encodeURIComponent("/sites/s2")}`, {
    insights: true,
  });
  assert.equal(heading(), "Example Site");
  assert.ok(missing("#insights-return"));
});

test("with Insights off, a way back to Insights is not offered", async () => {
  await mountAdmin(`/sites/s1?return=${encodeURIComponent("/insights")}`);
  assert.equal(heading(), "Example Site");
  assert.ok(missing("#insights-return"));
});

test("a new page load, as after signing in again, starts each tab at home", async () => {
  await mountAdmin("/insights/trends?period=2026-09", { insights: true });
  const stored = () => [
    ...Object.keys({ ...window.localStorage }),
    ...Object.keys({ ...window.sessionStorage }),
  ];
  const before = stored();
  await click(manageTab);
  // Storage would outlive a sign-out, so tab memory must not use it.
  assert.deepEqual(stored(), before);
  assert.equal(
    $(insightsTab).getAttribute("href"),
    "/insights/trends?period=2026-09",
  );
  await mountAdmin("/sites", { insights: true });
  assert.equal($(insightsTab).getAttribute("href"), "/insights");
});

test("an old Analytics link opens Insights in its place", async () => {
  await mountAdmin("/sites", { insights: true });
  const entries = window.history.length;
  await routeTo("/analytics");
  assert.equal(url(), "/insights");
  assert.equal(heading(), t("admin.insights.overview"));
  // Replaced, so Back skips the old link instead of bouncing to Insights again.
  assert.equal(window.history.length, entries + 1);
});

test("the old analytics.html sends bookmarks to /analytics/, which the app routes", () => {
  const page = readFileSync(
    join(import.meta.dirname, "../public/analytics.html"),
    "utf8",
  );
  // Without the slash the dev server serves this file again, so it reloads forever.
  assert.match(page, /http-equiv="refresh" content="0; url=\/analytics\/"/);
  assert.match(page, /<a href="\/analytics\/">/);
  assert.equal(matchRoute("/analytics/").name, "analytics");
});

test("with Insights off, an old Analytics link says so and leads to Manage", async () => {
  await mountAdmin("/analytics");
  assert.equal(url(), "/analytics");
  assert.equal(heading(), t("admin.insights.off.title"));
  assert.ok(focused("#insights-title"));
  assert.ok(text("#insights-off").includes(t("admin.insights.off.body")));
  assert.ok(missing("#admin-modes"));
  await click("[data-insights-off-manage]");
  assert.equal(url(), "/sites");
  assert.equal(heading(), t("admin.breadcrumb.admin"));
});

const signInConfig = {
  apiBase: window.location.origin,
  localDebugAdmin: false,
  insightsEnabled: true,
  cognitoDomain: "https://auth.example.org",
  clientId: "example-client",
  redirectUri: "http://localhost/auth/callback",
};

/**
 * Sign in from `path`, then come back from the login page as Cognito would.
 * @param {string} path
 * @param {{ ok?: boolean, insights?: boolean }} [options] insights: the deploy switch
 */
async function signInFrom(path, { ok = true, insights = true } = {}) {
  const assign = vi
    .spyOn(window.location, "assign")
    .mockImplementation(() => {});
  const config = () => {
    /** @type {any} */ (window).GOOD_NEIGHBOR_ADMIN_CONFIG = {
      ...signInConfig,
      insightsEnabled: insights,
    };
  };
  await mountAdmin(path, { insights, setup: config });
  await click("#sign-in");
  // The PKCE digest runs off the event loop, where settle() can't see it.
  await waitFor(() => assign.mock.calls.length > 0);
  await settle();
  const state = new URL(assign.mock.calls[0][0]).searchParams.get("state");
  // The login page is another site; the tab keeps its storage while it's there.
  const kept = { ...window.sessionStorage };
  await mountAdmin(`/auth/callback?code=c1&state=${state}`, {
    insights,
    setup: () => {
      config();
      for (const [key, value] of Object.entries(kept))
        window.sessionStorage.setItem(key, value);
    },
    fetch: (requestUrl) =>
      requestUrl === "https://auth.example.org/oauth2/token"
        ? new Response(
            JSON.stringify(
              ok
                ? { access_token: "token-1", expires_in: 3600 }
                : { error: "invalid_grant" },
            ),
            {
              status: ok ? 200 : 400,
              headers: { "content-type": "application/json" },
            },
          )
        : undefined,
  });
}

test("signing in from an Insights page comes back to it", async () => {
  await signInFrom("/insights/raw/issues?period=2026-09");
  assert.equal(url(), "/insights/raw/issues?period=2026-09");
  assert.equal(heading(), t("admin.insights.raw"));
});

test("signing in from an old Analytics link comes back to Insights", async () => {
  await signInFrom("/analytics");
  assert.equal(url(), "/insights");
  assert.equal(heading(), t("admin.insights.overview"));
});

test("signing in from an old Analytics link with Insights off says why", async () => {
  await signInFrom("/analytics", { insights: false });
  assert.equal(url(), "/analytics");
  assert.equal(heading(), t("admin.insights.off.title"));
});

test("signing in from a page that only redirects comes back to where it leads", async () => {
  await signInFrom("/insights/raw?period=2026-09");
  assert.equal(url(), "/insights/raw/issues?period=2026-09");
});

test("signing in from a Manage page still opens the Site list", async () => {
  await signInFrom("/programs/p1");
  assert.equal(url(), "/auth/callback");
  assert.equal(heading(), t("admin.breadcrumb.admin"));
});

test("a sign-in that fails stays on its error, not the Insights page", async () => {
  await signInFrom("/insights/trends", { ok: false });
  assert.equal(url(), "/auth/callback");
  assert.equal(pageError(), t("admin.errors.loginFailed"));
  assert.ok(!missing("#sign-in"));
});
