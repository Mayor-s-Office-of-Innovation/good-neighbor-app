import { test } from "vitest";
import assert from "node:assert/strict";
import {
  $,
  $$,
  click,
  fill,
  leavePage,
  mountPage,
  pageError,
  pageText,
  routeTo,
  settle,
  submit,
  toastText,
  window,
  missing,
  adminData,
} from "../test-support/admin-dom.js";
import { gate } from "../../e2e/admin-tests/admin-mock.js";
import { t } from "../../frontend/src/i18n/i18n.js";
import { adminSession } from "./admin-session.js";
import "./pages/admin-user/admin-users-page.js";

// pages/admin-user/admin-user.templates.js has no catalog key for this copy, so tests match its English.

const users = [
  {
    username: "active1",
    name: "Dana Admin",
    email: "dana@example.org",
    role: "compliance-supervisor",
    lifecycleStatus: "active",
    canResetPassword: true,
  },
  {
    username: "invited1",
    email: "eli@example.org",
    role: "compliance-manager",
    status: "FORCE_CHANGE_PASSWORD",
  },
  {
    username: "off1",
    name: "Fran Off",
    email: "fran@example.org",
    role: "compliance-manager",
    enabled: false,
  },
  {
    username: "plain1",
    name: "Gale Plain",
    email: "gale@example.org",
    role: "compliance-manager",
    status: "CONFIRMED",
  },
  {
    username: "odd1",
    name: "Hal Odd",
    email: "hal@example.org",
    role: "compliance-manager",
    lifecycleStatus: "archived",
  },
];

/**
 * <admin-users-page> alone, without <admin-app>, following its own routes; a request
 * outside its own calls fails the test. Its errors show through pageError().
 * @param {string} path
 * @param {Partial<Parameters<typeof mountPage>[2]>} [options]
 */
const openAdminUsersPage = (path, options = {}) =>
  mountPage("admin-users-page", path, {
    calls: [
      /^(GET|POST|PUT) admin-users(\/|$)/,
      /^(GET|PUT) profile$/,
      /^GET oversight-options$/,
    ],
    follow: ["administrators", "administrator-new", "profile"],
    recordErrors: true,
    sites: true,
    ...options,
  });

function openUsers() {
  const data = adminData();
  // The mock answers user actions from its own records, as the backend does.
  data.adminUsers = structuredClone(users);
  return openAdminUsersPage("/administrators", {
    data,
    setup: (api) => {
      // Read from the records each action changes, so a reload shows the change.
      api.on("GET", /^admin-users$/, () => ({
        json: { users: api.data.adminUsers, directoryMode: "local" },
      }));
      api.on(
        "POST",
        /^admin-users\/([^/]+)\/(suspend|reinstate|reinvite|reset-password)$/,
        (_request, [, username, action]) => {
          const user = api.data.adminUsers.find(
            (/** @type {any} */ item) => item.username === username,
          );
          if (action === "suspend") user.enabled = false;
          if (action === "reinstate") user.enabled = true;
          return { json: { user: { ...user } } };
        },
      );
      api.on("PUT", /^admin-users\/([^/]+)\/role$/, (request, [, username]) => {
        const user = api.data.adminUsers.find(
          (/** @type {any} */ item) => item.username === username,
        );
        user.role = request.body.role;
        return { json: { user: { ...user } } };
      });
    },
  });
}

const openUsersPage = openUsers;

const rows = () => $$("table tbody tr");

/** @param {string} action @param {string} username */
const actionButton = (action, username) =>
  $(`[data-admin-user-action="${action}"][data-username="${username}"]`);

async function fillInvite() {
  await fill('#admin-user-form wa-input[name="firstName"]', "Ivy");
  await fill('#admin-user-form wa-input[name="lastName"]', "Invitee");
  await fill('#admin-user-form wa-input[name="email"]', "ivy@example.org");
  await fill('#admin-user-form wa-input[name="phone"]', "4155550120");
  await fill('#admin-user-form wa-select[name="departmentId"]', "d1");
}

test("the user list shows each lifecycle status and its actions", async () => {
  await openUsersPage();
  assert.equal(rows().length, 5);
  assert.ok(rows()[0].querySelector('[data-admin-user-action="reset"]'));
  assert.match(rows()[1].textContent, /—/);
  assert.ok(rows()[1].querySelector('[data-admin-user-action="reinvite"]'));
  assert.ok(rows()[2].querySelector('[data-admin-user-action="reinstate"]'));
  assert.equal(
    rows()[3].querySelector('[data-admin-user-action="reset"]'),
    null,
  );
  assert.match(rows()[4].textContent, /archived/);
});

test("the status filter narrows the list and clearing it shows everyone", async () => {
  await openUsersPage();
  await fill("#admin-user-status-filter", "suspended");
  assert.deepEqual(
    rows().map((row) => row.cells[1].textContent),
    ["fran@example.org"],
  );
  await fill("#admin-user-status-filter", "invited");
  assert.deepEqual(
    rows().map((row) => row.cells[1].textContent),
    ["eli@example.org"],
  );
  await fill("#admin-user-status-filter", "");
  assert.equal(rows().length, 5);
});

test("an empty user list shows the empty state", async () => {
  await openAdminUsersPage("/administrators", {
    setup: (api) => api.on("GET", /^admin-users$/, { json: {} }),
  });
  assert.match(pageText(), /No administrators match this status\./);
});

// The last column is the action the reloaded row offers for its new status.
for (const [action, path, toast, next] of [
  ["suspend", "plain1/suspend", "admin.toast.adminSuspended", "reinstate"],
  ["reinstate", "off1/reinstate", "admin.toast.adminReinstated", "suspend"],
  ["reinvite", "invited1/reinvite", "admin.toast.invitationSent", "reinvite"],
  ["reset", "active1/reset-password", "admin.toast.passwordReset", "reset"],
]) {
  test(`${action} calls the API, reloads the list and confirms`, async () => {
    const { api } = await openUsersPage();
    const username = path.split("/")[0];
    const before = api.calls("GET", /^admin-users$/).length;
    await click(actionButton(action, username));
    assert.match(toastText(), new RegExp(t(toast)));
    assert.equal(
      api.calls("POST", new RegExp(`^admin-users/${path}$`)).length,
      1,
    );
    assert.ok(api.calls("GET", /^admin-users$/).length > before);
    assert.equal(actionButton(next, username).disabled, false);
  });
}

test("a failed user action shows the API's error", async () => {
  const { api } = await openUsers();
  api.fail(
    "POST",
    /^admin-users\/plain1\/suspend$/,
    409,
    "last_active_supervisor",
  );
  await click(actionButton("suspend", "plain1"));
  // Pins a bug: the raw API code shows instead of a message. No issue filed yet.
  assert.equal(pageError(), "last_active_supervisor");
});

test("a failed user action makes its button usable again", async () => {
  const { api } = await openUsers();
  api.fail("POST", /^admin-users\/plain1\/suspend$/, 409, "busy");
  await click(actionButton("suspend", "plain1"));
  const button = actionButton("suspend", "plain1");
  assert.equal(button.disabled, false);
  assert.equal(button.getAttribute("aria-busy"), null);
});

test("a user action that finishes after the user leaves doesn't reread the list", async () => {
  const held = gate();
  const { api, page } = await openUsers();
  api.on("POST", /^admin-users\/plain1\/suspend$/, async () => {
    await held.promise;
    return { json: {} };
  });
  const reads = api.calls("GET", /^admin-users$/).length;
  await click(actionButton("suspend", "plain1"));
  page.leave();
  held.release();
  await settle();
  assert.equal(api.calls("GET", /^admin-users$/).length, reads);
});

test("an unknown user action sends nothing", async () => {
  const { api } = await openUsersPage();
  const button = actionButton("suspend", "plain1");
  button.setAttribute("data-admin-user-action", "archive");
  await click(button);
  assert.equal(button.disabled, false);
  assert.deepEqual(
    api.requests.filter((request) => request.method !== "GET"),
    [],
  );
});

test("changing a role saves it, and a failure shows the API's error", async () => {
  const { api } = await openUsers();
  await fill(
    '[data-admin-role][data-username="plain1"]',
    "compliance-supervisor",
  );
  assert.match(toastText(), new RegExp(t("admin.toast.roleUpdated")));
  assert.deepEqual(api.calls("PUT", /^admin-users\/plain1\/role$/)[0].body, {
    role: "compliance-supervisor",
  });
  api.fail("PUT", /^admin-users\/plain1\/role$/, 400, "invalid_role");
  await fill('[data-admin-role][data-username="plain1"]', "compliance-manager");
  // Pins a bug: the raw API code shows instead of a message. No issue filed yet.
  assert.equal(pageError(), "invalid_role");
  // The select goes back to the role that was saved.
  assert.equal(
    $('[data-admin-role][data-username="plain1"]').value,
    "compliance-supervisor",
  );
});

test("inviting a user returns to the list with the new account", async () => {
  const { api } = await openAdminUsersPage("/administrators", {
    setup: (api) =>
      api.on("POST", /^admin-users$/, (request) => ({
        json: {
          user: {
            username: "ivy",
            name: "Ivy Invitee",
            email: request.body.email,
            role: request.body.role,
            lifecycleStatus: "active",
          },
          invitationStatus: "active",
        },
      })),
  });
  // A filter that would hide the new account is reset by the invite.
  await fill("#admin-user-status-filter", "suspended");
  // <admin-app> follows the button's data-navigate; routeTo() stands in for it.
  await routeTo($('[data-navigate="/administrators/new"]').dataset.navigate);
  assert.ok(!missing("#new-admin-user-title"));
  await click("#show-admin-role-help");
  assert.equal($("#admin-role-help-dialog").open, true);
  await fillInvite();
  await submit("#admin-user-form");
  assert.equal(window.location.pathname, "/administrators");
  assert.match($("table").textContent, /ivy@example\.org/);
  assert.match(toastText(), new RegExp(t("admin.toast.accountActive")));
  assert.deepEqual(
    {
      firstName: api.calls("POST", /^admin-users$/)[0].body.firstName,
      departmentId: api.calls("POST", /^admin-users$/)[0].body.departmentId,
      role: api.calls("POST", /^admin-users$/)[0].body.role,
    },
    { firstName: "Ivy", departmentId: "d1", role: "compliance-manager" },
  );
  // The new list came from the cache, not a second read.
  assert.equal(api.calls("GET", /^admin-users$/).length, 1);
});

test("a failed invite keeps the list's status filter", async () => {
  await openAdminUsersPage("/administrators", {
    setup: (api) => api.fail("POST", /^admin-users$/, 400, "admin_user_exists"),
  });
  await fill("#admin-user-status-filter", "suspended");
  await routeTo("/administrators/new");
  await fillInvite();
  await submit("#admin-user-form");
  await routeTo("/administrators");
  assert.equal($("#admin-user-status-filter").value, "suspended");
});

test("leaving the invite form for Sites reads the users again on return", async () => {
  const { api } = await openUsers();
  await routeTo("/administrators/new");
  await routeTo("/sites");
  await routeTo("/administrators");
  assert.equal(api.calls("GET", /^admin-users$/).length, 2);
  assert.ok(!missing("#administrators-title"));
});

test("opening the invite form from Sites reads the users again on return", async () => {
  const { api } = await openUsers();
  await routeTo("/sites");
  await routeTo("/administrators/new");
  await routeTo("/administrators");
  assert.equal(api.calls("GET", /^admin-users$/).length, 2);
});

/** Open the invite form with its POST held until `held` is released. @param {ReturnType<typeof gate>} held */
async function holdInvite(held) {
  const opened = await openAdminUsersPage("/administrators/new", {
    setup: (api) =>
      api.on("POST", /^admin-users$/, async () => {
        await held.promise;
        return {
          json: {
            user: { username: "ivy", email: "ivy@example.org" },
            invitationStatus: "invited",
          },
        };
      }),
  });
  await fillInvite();
  await submit("#admin-user-form");
  return opened;
}

test("an invite that finishes after the user left stays where they went", async () => {
  const held = gate();
  await holdInvite(held);
  await leavePage("/sites");
  held.release();
  await settle();
  assert.equal(window.location.pathname, "/sites");
});

test("an invite that finishes after leave() doesn't navigate, even at the same address", async () => {
  const held = gate();
  const { page } = await holdInvite(held);
  // <admin-app> calls leave() as the user goes; the page mustn't wait for the URL to change.
  page.leave();
  held.release();
  await settle();
  assert.equal(window.location.pathname, "/administrators/new");
});

test("opening Manage users again after an invite reads the list again", async () => {
  const { api } = await openAdminUsersPage("/administrators/new", {
    setup: (api) =>
      api.on("POST", /^admin-users$/, {
        json: {
          user: { username: "ivy", email: "ivy@example.org" },
          invitationStatus: "invited",
        },
      }),
  });
  await routeTo("/administrators");
  await routeTo("/administrators/new");
  await fillInvite();
  await submit("#admin-user-form");
  const reads = api.calls("GET", /^admin-users$/).length;
  await routeTo("/administrators");
  assert.equal(api.calls("GET", /^admin-users$/).length, reads + 1);
});

for (const [code, key] of [
  ["admin_user_exists", "admin.users.exists"],
  ["valid_email_required", "admin.users.invalidEmail"],
  ["something_else", "admin.users.failed"],
]) {
  test(`a rejected invitation explains ${code}`, async () => {
    await openAdminUsersPage("/administrators/new", {
      setup: (api) => api.fail("POST", /^admin-users$/, 400, code),
    });
    await fillInvite();
    await submit("#admin-user-form");
    assert.equal(
      $("#admin-user-form [data-form-save-error]").textContent.trim(),
      t(key),
    );
  });
}

test("Manage users is hidden from a Compliance manager", async () => {
  const { api } = await openAdminUsersPage("/administrators", {
    role: "compliance-manager",
  });
  assert.ok(missing("#administrators-title"));
  // The mock's 403 would draw an error page here, so check where the user went.
  assert.equal(window.location.pathname, "/sites");
  assert.deepEqual(api.calls("GET", /^admin-users$/), []);
});

test("a Compliance manager who opens the invite form lands on Sites", async () => {
  await openAdminUsersPage("/administrators/new", {
    role: "compliance-manager",
  });
  assert.equal(window.location.pathname, "/sites");
  assert.ok(missing("#admin-user-form"));
});

const profileField = (/** @type {string} */ name) =>
  `#my-profile-form wa-input[name="${name}"]`;
const profileSaveError = () =>
  document
    .querySelector("#my-profile-form [data-form-save-error]")
    ?.textContent.trim() || "";

/** Profile data for a Compliance manager, with no Site assigned yet. */
function managerProfileData() {
  const data = adminData();
  data.profile = /** @type {any} */ ({
    ...data.profile,
    role: "compliance-manager",
  });
  return data;
}

test("a profile without a directory link still saves", async () => {
  const data = adminData();
  data.profile = { ...data.profile, directoryUserId: "" };
  const { api } = await openAdminUsersPage("/profile", { data });
  await fill(profileField("phone"), "4155550199");
  await submit("#my-profile-form");
  assert.equal(api.calls("PUT", /^profile$/)[0].body.phone, "4155550199");
  // Profile saves are quiet: success shows as a clean form, not a toast.
  assert.equal(profileSaveError(), "");
  assert.equal($("#my-profile-form [data-save-button]").disabled, true);
});

test("a rejected profile phone shows the phone error", async () => {
  const { api } = await openAdminUsersPage("/profile", {
    setup: (api) => api.fail("PUT", /^profile$/, 400, "valid_phone_required"),
  });
  await fill(profileField("phone"), "4155550199");
  await submit("#my-profile-form");
  assert.equal(profileSaveError(), t("admin.profile.invalidPhone"));
  api.fail("PUT", /^profile$/, 500, "server_error");
  await submit("#my-profile-form");
  assert.equal(profileSaveError(), t("admin.profile.saveError"));
});

test("a Compliance manager's profile lists their Sites", async () => {
  const data = managerProfileData();
  data.siteItems.s1.push({
    sk: "COMPLIANCE_MANAGER#pm1",
    type: "siteComplianceManagerAssignment",
    managerId: "pm1",
    status: "active",
  });
  await openAdminUsersPage("/profile", { role: "compliance-manager", data });
  assert.equal($('a[href="/sites/s1"]').textContent, "Example Site");
});

test("a Compliance manager's profile says when they have no Sites", async () => {
  await openAdminUsersPage("/profile", {
    role: "compliance-manager",
    data: managerProfileData(),
  });
  assert.ok(pageText().includes(t("admin.profile.noSites")));
});

test("a profile read with no profile renders nothing", async () => {
  await openAdminUsersPage("/profile", {
    setup: (api) => api.on("GET", /^profile$/, { json: {} }),
  });
  // Loading has finished, with no error, yet no profile is drawn.
  assert.ok(missing("admin-users-page p[role='status']"));
  assert.equal(pageError(), "");
  assert.ok(missing("#profile-title"));
});

test("a Supervisor's profile names the role and hides the Site list", async () => {
  const data = adminData();
  data.profile = /** @type {any} */ ({
    ...data.profile,
    role: "compliance-supervisor",
  });
  await openAdminUsersPage("/profile", { data });
  assert.equal(
    $("#profile-title + p").textContent,
    t("admin.profile.supervisor"),
  );
  assert.ok(!pageText().includes(t("admin.profile.sites")));
});

test("a manager's profile labels unnamed Sites by their record", async () => {
  const data = managerProfileData();
  for (const site of [
    { siteId: "s6", siteName: "Record Name", status: "active" },
    { siteId: "s7", status: "active" },
  ]) {
    data.sites.push(/** @type {any} */ (site));
    data.siteItems[site.siteId] = [
      {
        sk: "COMPLIANCE_MANAGER#pm1",
        type: "siteComplianceManagerAssignment",
        managerId: "pm1",
        status: "active",
      },
    ];
  }
  await openAdminUsersPage("/profile", { role: "compliance-manager", data });
  assert.equal($('a[href="/sites/s6"]').textContent, "Record Name");
  assert.equal($('a[href="/sites/s7"]').textContent, "s7");
});

test("the mounted users page saves a profile to its own session, not adminSession", async () => {
  const { session } = await openAdminUsersPage("/profile");
  await fill(profileField("phone"), "4155550199");
  await submit("#my-profile-form");
  assert.equal(session.profile?.phone, "4155550199");
  assert.equal(adminSession.profile, null);
});

test("a redraw after the URL moves on still draws the route open() was given", async () => {
  const { page } = await openAdminUsersPage("/administrators");
  window.history.replaceState({}, "", "/not-a-page");
  page.render();
  assert.ok(!missing("admin-users-page h1"));
});
