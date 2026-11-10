import { test, vi } from "vitest";
import assert from "node:assert/strict";
import {
  $,
  $$,
  click,
  fill,
  missing,
  mountAdmin,
  pageError,
  routeTo,
  settle,
  waitFor,
  window,
} from "../test-support/admin-dom.js";
import { gate } from "../../e2e/admin-tests/admin-mock.js";
import { failTimes } from "../../e2e/admin-tests/directory-helpers.js";
import { t } from "../../frontend/src/i18n/i18n.js";

// main.js and pages/directory/directory.templates.js have no catalog key for this copy, so tests match their English.

const CONFIG_ERROR = "Admin login is not configured for this environment.";
const heading = () => $("admin-app h1").textContent.trim();
const url = () => window.location.pathname + window.location.search;

/** Page loads would leave the test document, so record them instead. */
function stubPageLoads() {
  return {
    assign: vi.spyOn(window.location, "assign").mockImplementation(() => {}),
    reload: vi.spyOn(window.location, "reload").mockImplementation(() => {}),
  };
}

/** Hold GET requests matching `pattern` until released. @param {any} api @param {RegExp} pattern */
function hold(api, pattern) {
  const held = gate();
  api.on("GET", pattern, async () => {
    await held.promise;
    return undefined;
  });
  return held;
}

/** @param {object} config */
const signedOut = (config) => () => {
  /** @type {any} */ (window).GOOD_NEIGHBOR_ADMIN_CONFIG = {
    apiBase: window.location.origin,
    localDebugAdmin: false,
    ...config,
  };
};

test("a failed session read offers a reload", async () => {
  const loads = stubPageLoads();
  await mountAdmin("/sites", {
    setup: (api) => api.on("GET", /^session$/, failTimes(1)),
  });
  assert.equal(pageError(), "Synthetic failure");
  await click("#retry-page-load");
  assert.equal(loads.reload.mock.calls.length, 1);
});

test("a failed route read retries the route once the role is known", async () => {
  const { api } = await mountAdmin("/sites");
  api.on("GET", /^sites\/s1(\?|$)/, failTimes(1, 503, "Site read failed"));
  await click('a[href="/sites/s1"]');
  assert.equal(pageError(), "Site read failed");
  await click("#retry-page-load");
  assert.equal(heading(), "Example Site");
  assert.ok(missing("#retry-page-load"));
});

test("a route read that fails after the user moves on stays silent", async () => {
  const { api } = await mountAdmin("/sites");
  const held = gate();
  api.on("GET", /^programs\/p1$/, async () => {
    await held.promise;
    return { status: 500, json: { error: "Late failure" } };
  });
  await routeTo("/programs/p1");
  await routeTo("/providers");
  held.release();
  await settle();
  assert.equal(pageError(), "");
  assert.ok(!missing('a[href="/providers/v1"]'));
});

test("a sign-in callback error is shown on load", async () => {
  await mountAdmin("/sites?error=access_denied");
  // Pins a bug: the raw API code shows instead of a message. No issue filed yet.
  assert.equal(pageError(), "access_denied");
});

test("a valid sign-in callback exchanges its code and opens the dashboard", async () => {
  /** @type {any[]} */
  const exchanges = [];
  await mountAdmin("/sites?code=c1&state=s1", {
    setup: () => {
      signedOut({
        cognitoDomain: "https://auth.example.org",
        clientId: "example-client",
        redirectUri: "http://localhost/",
      })();
      window.sessionStorage.setItem("good-neighbor-admin-oauth-state", "s1");
      window.sessionStorage.setItem("good-neighbor-admin-pkce-verifier", "v1");
    },
    fetch: (requestUrl, init) => {
      if (requestUrl !== "https://auth.example.org/oauth2/token") return;
      exchanges.push(Object.fromEntries(new URLSearchParams(init.body)));
      return new Response(
        JSON.stringify({ access_token: "token-1", expires_in: 3600 }),
        { headers: { "content-type": "application/json" } },
      );
    },
  });
  assert.deepEqual(
    exchanges.map(({ code, code_verifier }) => [code, code_verifier]),
    [["c1", "v1"]],
  );
  assert.equal(url(), "/sites");
  assert.equal(pageError(), "");
  assert.ok(!missing("#directory-search-input"));
});

test("signed-out visitors without sign-in config see the config error", async () => {
  const { api } = await mountAdmin("/sites", { setup: signedOut({}) });
  assert.ok($("admin-app").textContent.includes(CONFIG_ERROR));
  await click("#sign-in");
  // Pins a bug: the raw API code shows instead of a message. No issue filed yet.
  assert.equal(pageError(), "missing_admin_auth_config");
  assert.equal($("#sign-in").disabled, false);
  assert.deepEqual(api.requests, []);
});

test("a configured sign-in sends the visitor to the login page", async () => {
  const loads = stubPageLoads();
  await mountAdmin("/sites", {
    setup: signedOut({
      cognitoDomain: "https://auth.example.org",
      clientId: "example-client",
    }),
  });
  assert.ok(!$("admin-app").textContent.includes(CONFIG_ERROR));
  await click("#sign-in");
  // The PKCE digest runs off the event loop, where settle() can't see it.
  await waitFor(() => loads.assign.mock.calls.length > 0);
  await settle();
  assert.equal(
    loads.assign.mock.calls.length,
    1,
    "sign-in should leave for the login page once",
  );
  const target = new URL(loads.assign.mock.calls[0][0]);
  assert.equal(
    target.origin + target.pathname,
    "https://auth.example.org/oauth2/authorize",
  );
  assert.equal(target.searchParams.get("client_id"), "example-client");
});

test("a blocked oversight lookup fails the route and offers a retry", async () => {
  await mountAdmin("/sites", {
    setup: (api) => api.fail("GET", /^oversight-options$/, 403, "forbidden"),
  });
  // Pins a bug: the raw API code shows instead of a message. No issue filed yet.
  assert.equal(pageError(), "forbidden");
  assert.ok(!missing("#retry-page-load"));
});

test("a failed oversight lookup still loads and is retried on the next route", async () => {
  const { api } = await mountAdmin("/sites", {
    setup: (api) => api.on("GET", /^oversight-options$/, failTimes(1)),
  });
  assert.ok(!missing("#directory-title"));
  assert.equal(pageError(), "");
  await click('a[href="/providers"]');
  assert.ok(!missing('a[href="/providers/v1"]'));
  assert.equal(api.calls("GET", /^oversight-options$/).length, 2);
});

test("an empty session and empty lists still render the directory", async () => {
  await mountAdmin("/sites", {
    setup: (api) => {
      for (const pattern of [
        /^session$/,
        /^providers/,
        /^programs$/,
        /^program-managers$/,
        /^oversight-options$/,
      ])
        api.on("GET", pattern, { json: {} });
    },
  });
  assert.ok(!missing("#directory-title"));
  assert.ok(
    $("admin-app").textContent.includes("No sites match these filters."),
  );
  assert.ok(missing('a[href="/sites/new"]'));
});

test("directory sites pick up manager names and active assignments", async () => {
  await mountAdmin("/sites?manager=id:pm1", {
    setup: (api) => {
      const site = api.data.sites[0];
      site.oversight = { ...site.oversight, cityProgramManager: "Legacy Name" };
      api.data.programManagers.push({
        userId: "pm2",
        name: "Named Manager",
        status: "active",
      });
      api.data.sites.push({
        siteId: "s3",
        name: "Named Site",
        providerId: "v1",
        leadProgramId: "p1",
        status: "active",
        oversight: { cityProgramManagerId: "pm2", cityProgramManager: "Old" },
      });
      api.data.siteItems.s1.push(
        {
          sk: "COMPLIANCE_MANAGER#pm1",
          type: "siteComplianceManagerAssignment",
          managerId: "pm1",
          status: "active",
        },
        {
          sk: "COMPLIANCE_MANAGER#pm9",
          type: "siteComplianceManagerAssignment",
          managerId: "pm9",
          status: "inactive",
        },
      );
      api.on(
        "GET",
        /^providers\?directory=1$/,
        (/** @type {any} */ request) => {
          const reply = api.reply(request);
          reply.json.sites.push({ items: [{ sk: "ASSIGNED_USER#u9" }] });
          return reply;
        },
      );
    },
  });
  const options = $$('wa-select[name="manager"] wa-option').map((option) =>
    option.textContent.trim(),
  );
  assert.ok(options.includes("Casey Manager"));
  assert.ok(options.includes("Named Manager"));
  assert.ok(!options.includes("Legacy Name"));
  assert.ok(!options.includes("Old"));
  const rows = $$('[aria-labelledby="sites-title"] li');
  assert.equal(rows.length, 1);
  assert.ok(rows[0].textContent.includes("Example Site"));
  await fill('wa-select[name="manager"]', "id:pm9");
  assert.ok(
    $("admin-app").textContent.includes("No sites match these filters."),
  );
});

test("a Compliance manager is sent away from Supervisor-only pages", async () => {
  for (const path of [
    "/administrators",
    "/administrators/new",
    "/system-status",
    "/provider-managers",
    "/provider-managers/v1/m1",
  ]) {
    await mountAdmin(path, { role: "compliance-manager" });
    assert.equal(url(), "/sites", path);
    assert.ok(!missing("#directory-title"));
  }
});

test("a Compliance manager's profile loads at startup and gates creation", async () => {
  const { api } = await mountAdmin("/sites", { role: "compliance-manager" });
  assert.equal(api.calls("GET", /^profile$/).length, 1);
  for (const link of ["/sites/new", "/administrators", "/sites/import"])
    assert.ok(missing(`a[href="${link}"]`), link);
});

test("the settings menu links a Supervisor to every admin page", async () => {
  await mountAdmin("/sites");
  const menu = "#admin-settings-menu";
  for (const link of ["/administrators", "/sites/import", "/system-status"])
    assert.ok(!missing(`${menu} a[href="${link}"]`), link);
  await click(`${menu} a[href="/profile"]`);
  assert.ok(!missing("#profile-title"));
});

test("signing out clears the session and leaves through the logout page", async () => {
  const loads = stubPageLoads();
  await mountAdmin("/sites");
  window.sessionStorage.setItem("good-neighbor-admin-access-token", "stale");
  window.localStorage.setItem("good-neighbor-admin-session", "{}");
  await click("#clear-token");
  assert.equal(
    window.sessionStorage.getItem("good-neighbor-admin-access-token"),
    null,
  );
  assert.equal(
    window.localStorage.getItem("good-neighbor-admin-session"),
    null,
  );
  assert.equal(loads.assign.mock.calls.length, 1);
  assert.equal(loads.assign.mock.calls[0][0], `${window.location.origin}/`);
});

test("the local role switch reloads as the chosen role", async () => {
  const loads = stubPageLoads();
  await mountAdmin("/sites");
  await fill("#local-role-switch", "manager");
  assert.equal(loads.reload.mock.calls.length, 1);
  const stored = { ...window.sessionStorage };
  // The reload keeps session storage; mounting again stands in for it.
  const { api } = await mountAdmin("/sites", {
    setup: () => {
      for (const [key, value] of Object.entries(stored))
        window.sessionStorage.setItem(key, String(value));
    },
  });
  assert.equal($("#local-role-switch").value, "manager");
  assert.equal(
    api.calls("GET", /^session$/).at(-1).headers["x-debug-groups"],
    "compliance-manager",
  );
});

test("the local role switch keeps unsaved edits when the user cancels", async () => {
  const loads = stubPageLoads();
  await mountAdmin("/profile");
  await fill('#my-profile-form wa-input[name="firstName"]', "Changed");
  await fill("#local-role-switch", "manager");
  assert.equal(loads.reload.mock.calls.length, 0);
  assert.equal($("#local-role-switch").value, "supervisor");
  assert.equal(
    $('#my-profile-form wa-input[name="firstName"]').value,
    "Changed",
  );
});

for (const [path, pattern] of [
  ["/administrators", /^admin-users$/],
  ["/profile", /^profile$/],
  ["/administrators/new", /^oversight-options$/],
  ["/provider-managers", /^providers\/v1\/manager-memberships$/],
  ["/sites/import", /^site-imports$/],
  ["/sites/import?importId=i9", /^site-imports\/i9$/],
  ["/managers", /^people$/],
  ["/managers/new", /^people$/],
])
  test(`a read for ${path} abandoned by a newer navigation does not render`, async () => {
    const { api } = await mountAdmin("/sites");
    const held = hold(api, /** @type {RegExp} */ (pattern));
    // Counted first: /sites may already have made the same read.
    const before = api.calls("GET", /** @type {RegExp} */ (pattern)).length;
    await routeTo(/** @type {string} */ (path));
    assert.ok(
      api.calls("GET", /** @type {RegExp} */ (pattern)).length > before,
    );
    await routeTo("/sites/s2");
    held.release();
    await settle();
    assert.equal(url(), "/sites/s2");
    assert.equal(heading(), "Quiet Site");
    assert.equal(pageError(), "");
  });

test("a directory load still in flight is shared with the next route", async () => {
  /** @type {any} */
  let held;
  const { api } = await mountAdmin("/sites", {
    setup: (api) => (held = hold(api, /^programs$/)),
  });
  await routeTo("/providers");
  await routeTo("/managers");
  held.release();
  await settle();
  assert.equal(url(), "/managers");
  assert.ok(!missing("#managers-title"));
  assert.equal(api.calls("GET", /^programs$/).length, 1);
});

test("loading shows a status line while the route reads", async () => {
  const { api } = await mountAdmin("/sites");
  const held = hold(api, /^admin-users$/);
  await routeTo("/administrators");
  assert.equal(
    $("admin-app p[role='status']").textContent.trim(),
    t("admin.status.loading"),
  );
  held.release();
  await settle();
  assert.ok(!missing("#administrators-title"));
});

test("the Site list reloads a directory read that skipped Sites", async () => {
  /** @type {any} */
  let held;
  const { api } = await mountAdmin("/sites/new", {
    setup: (api) => (held = hold(api, /^programs$/)),
  });
  await routeTo("/sites");
  held.release();
  await settle();
  assert.ok(!missing('[aria-labelledby="sites-title"] a[href="/sites/s1"]'));
  assert.equal(api.calls("GET", /^providers\?directory=1$/).length, 1);
});

test("a Compliance manager who may edit a Site keeps its edit controls", async () => {
  await mountAdmin("/sites/s1", {
    role: "compliance-manager",
    setup: (api) =>
      api.on("GET", /^sites\/s1(\?|$)/, () => ({
        json: {
          items: [{ ...api.data.sites[0], sk: "#META" }],
          permissions: { canEdit: true },
        },
      })),
  });
  assert.equal(heading(), "Example Site");
  assert.equal($("#site-details-form wa-input").disabled, false);
  assert.ok(missing("[data-deactivate-site]"));
});
