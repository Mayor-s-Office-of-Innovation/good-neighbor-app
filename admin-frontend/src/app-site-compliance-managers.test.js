import { test } from "vitest";
import assert from "node:assert/strict";
import {
  $,
  $$,
  click,
  fill,
  missing,
  toastText,
  unhandledRejection,
} from "../test-support/admin-dom.js";
import { mountAdmin } from "../test-support/app-mount.js";
import {
  complianceData,
  oversightPath,
} from "../../e2e/admin-tests/site-compliance-helpers.js";
import { t } from "../../frontend/src/i18n/i18n.js";

// pages/site/oversight.templates.js and oversight.bindings.js have no catalog key for this copy, so tests match their English.

const list = "[data-compliance-manager-list]";
const picker = "#choose-compliance-manager-dialog";
const inviteDialog = "#new-city-program-manager-dialog";
const search = "#compliance-manager-search";
const status = "[data-manager-search-status]";
const managers = () => $$(`${list} > li`);
const row = (/** @type {string} */ id) => `${list} li[data-manager-id='${id}']`;

function managersData() {
  const data = complianceData();
  data.programManagers = [
    {
      userId: "pm1",
      name: "Casey Manager",
      firstName: "Casey",
      lastName: "Manager",
      email: "casey@example.org",
      accountStatus: "not-invited",
      status: "active",
    },
    {
      userId: "pm2",
      name: "Jordan Lead",
      email: "jordan@example.org",
      departmentName: "Example Department",
      accountStatus: "active",
      status: "active",
    },
    {
      userId: "pm3",
      name: "Riley Pending",
      email: "riley@example.org",
      accountStatus: "invited",
      status: "active",
    },
  ];
  data.siteItems.s1.push({
    sk: "COMPLIANCE_MANAGER#pm1",
    type: "siteComplianceManagerAssignment",
    managerId: "pm1",
    status: "active",
  });
  return data;
}

/** @param {string} email */
async function fillInvite(email) {
  await fill("wa-input[name='manager-first-name']", "Sam");
  await fill("wa-input[name='manager-last-name']", "Example");
  await fill("wa-input[name='manager-email']", email);
  await fill("wa-input[name='manager-phone']", "4155550199");
  await fill("wa-select[name='manager-department']", "d1");
  await click(`${inviteDialog} [data-save-button]`);
}

/** @param {string} email */
async function inviteNew(email) {
  await click("#add-compliance-manager");
  await click("#invite-new-compliance-manager");
  assert.equal($(inviteDialog).open, true);
  await fillInvite(email);
}

test("an assigned manager with no name or email still lists", async () => {
  const data = managersData();
  data.programManagers.push({
    userId: "pm9",
    accountStatus: "active",
    status: "active",
  });
  data.siteItems.s1.push({
    sk: "COMPLIANCE_MANAGER#pm9",
    type: "siteComplianceManagerAssignment",
    managerId: "pm9",
    status: "active",
  });
  await mountAdmin(oversightPath, { data });
  assert.deepEqual(
    [
      // CSS class: the identity block has no role, id or data attribute.
      ...$(row("pm9")).querySelectorAll(
        ".compliance-manager-assignment__identity > *",
      ),
    ].map((part) => part.textContent),
    ["Program manager", t("admin.users.statusActive")],
  );
});

test("an assigned manager without an account can be invited from the Site", async () => {
  const { api } = await mountAdmin(oversightPath, {
    data: managersData(),
    setup: (api) =>
      api.on("POST", /^admin-users$/, {
        json: {
          invitationStatus: "invited",
          user: { lifecycleStatus: "invited" },
        },
      }),
  });
  assert.ok(
    $(row("pm1")).textContent.includes(
      t("admin.oversight.invitationNeeded", { name: "Casey Manager" }),
    ),
  );
  await click(`${row("pm1")} [data-invite-compliance-manager]`);
  assert.equal(
    $(`${row("pm1")} [data-invite-status]`).textContent.trim(),
    t("admin.users.statusInvited"),
  );
  const { body } = api.calls("POST", /^admin-users$/)[0];
  assert.deepEqual(
    [body.email, body.role],
    ["casey@example.org", "compliance-manager"],
  );
  assert.match(toastText(), new RegExp(t("admin.toast.invitationSent")));
});

test("a failed invite for an assigned manager can be retried", async () => {
  const { api } = await mountAdmin(oversightPath, {
    data: managersData(),
    setup: (api) =>
      api.fail("POST", /^admin-users$/, 409, "site_update_conflict"),
  });
  const invite = `${row("pm1")} [data-invite-compliance-manager]`;
  await click(invite);
  assert.ok(!missing(`${row("pm1")} [data-invite-status][role='alert']`));
  assert.equal($(invite).disabled, false);
  assert.equal($(invite).textContent.trim(), "Send invite");
  api.on("POST", /^admin-users$/, {
    json: { invitationStatus: "active", user: { lifecycleStatus: "active" } },
  });
  await click(invite);
  assert.equal(
    $(`${row("pm1")} [data-invite-status][role='status']`).textContent.trim(),
    t("admin.users.statusActive"),
  );
  assert.match(toastText(), new RegExp(t("admin.toast.accountActive")));
});

test("the manager search reports how many match", async () => {
  await mountAdmin(oversightPath, { data: managersData() });
  await click("#add-compliance-manager");
  assert.equal($(picker).open, true);
  for (const [query, shown] of [
    ["nobody", "No matching program managers. You can invite a new one."],
    ["example", "2 program managers found."],
    ["jordan", "1 program manager found."],
  ]) {
    await fill(search, query);
    assert.equal($(status).textContent, shown);
  }
  await fill(search, "");
  assert.equal($("[data-manager-results-heading]").hidden, true);
});

test("managers are added up to the limit and removed", async () => {
  await mountAdmin(oversightPath, { data: managersData() });
  await click("#add-compliance-manager");
  await fill(search, "jordan");
  await click("[data-select-compliance-manager][data-manager-id='pm2']");
  assert.equal($(picker).open, false);
  assert.equal(managers().length, 2);
  assert.equal($("#add-compliance-manager").disabled, true);
  const limit = () => $("[data-compliance-manager-limit]").hidden;
  assert.equal(limit(), false);
  assert.equal($("#site-oversight-form").dataset.isDirty, "true");
  await click(`${row("pm2")} [data-remove-compliance-manager]`);
  assert.equal(limit(), true);
  await click(`${row("pm1")} [data-remove-compliance-manager]`);
  assert.equal(managers().length, 0);
  assert.equal($("#add-compliance-manager").disabled, false);
  await click("#add-compliance-manager");
  assert.equal(
    $(status).textContent,
    "Search by name, email, or department to find a program manager.",
  );
});

test("a new manager is invited and selected, within the two-manager limit", async () => {
  const data = managersData();
  const statuses = ["active", "invited", "resent", "invited"];
  const { api } = await mountAdmin(oversightPath, {
    data,
    setup: (api) =>
      api.on("POST", /^admin-users$/, (/** @type {any} */ request) => {
        const next = statuses.shift();
        data.programManagers.push({
          userId: `new-${statuses.length}`,
          name: `${request.body.firstName} ${request.body.lastName}`,
          email: request.body.email,
          accountStatus: next === "active" ? "active" : "invited",
          status: "active",
        });
        return { json: { invitationStatus: next, user: {} } };
      }),
  });
  await click(`${row("pm1")} [data-remove-compliance-manager]`);
  await inviteNew("SAM.ONE@example.org");
  assert.equal($(inviteDialog).open, false);
  assert.match(toastText(), new RegExp(t("admin.toast.accountActive")));
  assert.equal(managers().length, 1);
  const { body } = api.calls("POST", /^admin-users$/)[0];
  assert.deepEqual(
    [body.email, body.departmentId, body.departmentName],
    ["sam.one@example.org", "d1", "Example Department"],
  );
  await inviteNew("sam.two@example.org");
  assert.equal(managers().length, 2);
  await click(`${list} > li [data-remove-compliance-manager]`);
  await inviteNew("sam.resent@example.org");
  assert.equal(managers().length, 2);
  // The Add button is disabled at the limit; a stale open dialog can still submit.
  $(inviteDialog).showModal();
  const failure = await unhandledRejection(() =>
    fillInvite("sam.three@example.org"),
  );
  // Pins a bug: the catch reads event.currentTarget after an await, so it's null. No issue filed yet.
  assert.equal(failure?.message, "Expected form event target");
  assert.ok(
    $(`${inviteDialog} [data-operation-error]`).textContent.includes(
      t("admin.toast.refreshFailed"),
    ),
  );
  assert.ok(missing(`${inviteDialog} [data-form-save-error]`));
  assert.equal(managers().length, 2);
});

test("an invited manager missing from the directory reports the sync failure", async () => {
  await mountAdmin(oversightPath, {
    data: managersData(),
    setup: (api) =>
      api.on("POST", /^admin-users$/, {
        json: { invitationStatus: "invited", user: {} },
      }),
  });
  const failure = await unhandledRejection(() => inviteNew("lost@example.org"));
  // Pins the same event.currentTarget bug as above. No issue filed yet.
  assert.equal(failure?.message, "Expected form event target");
  assert.ok(
    $(`${inviteDialog} [data-operation-error]`).textContent.includes(
      t("admin.toast.refreshFailed"),
    ),
  );
  assert.ok(missing(`${inviteDialog} [data-form-save-error]`));
  assert.equal(managers().length, 1);
});

test("a Compliance manager sees assignments without manage controls", async () => {
  const data = managersData();
  data.programManagers[0].accountStatus = "suspended";
  await mountAdmin(oversightPath, { data, role: "compliance-manager" });
  assert.ok(
    $(row("pm1")).textContent.includes(t("admin.users.statusSuspended")),
  );
  assert.ok(missing(`${row("pm1")} [data-remove-compliance-manager]`));
  assert.ok(missing("#add-compliance-manager"));
});

test("the managers list survives a visit to the App settings tab", async () => {
  await mountAdmin(oversightPath, {
    data: managersData(),
    setup: (api) =>
      // admin.js getSite returns only the Site record for the settings view (admin.test.js:1848).
      api.on(
        "GET",
        /^sites\/s1\?view=settings$/,
        (/** @type {any} */ request) => {
          const reply = api.reply(request);
          reply.json.items = reply.json.items.filter(
            (/** @type {any} */ item) => item.sk === "#META",
          );
          return reply;
        },
      ),
  });
  assert.equal(managers().length, 1);
  await click('a[href="/sites/s1?section=settings"]');
  await click('a[href="/sites/s1?section=oversight"]');
  assert.ok(!missing(row("pm1")));
});

test("a manager whose account is only linked shows no account status", async () => {
  const data = managersData();
  data.programManagers[0].accountStatus = "linked";
  await mountAdmin(oversightPath, { data });
  const text = $(row("pm1")).textContent;
  assert.match(text, /Casey Manager/);
  for (const key of [
    "admin.users.statusInvited",
    "admin.users.statusActive",
    "admin.users.statusSuspended",
  ])
    assert.ok(!text.includes(t(key)), key);
  assert.ok(
    !text.includes(
      t("admin.oversight.invitationNeeded", { name: "Casey Manager" }),
    ),
  );
  assert.ok(missing(`${row("pm1")} [data-invite-compliance-manager]`));
});

test("a Site with no assigned managers says so until one is added", async () => {
  const data = complianceData();
  data.programManagers = [
    { userId: "pm9", name: "Unknown Status", email: "", status: "active" },
  ];
  await mountAdmin(oversightPath, { data });
  assert.ok(!missing("[data-no-compliance-managers]"));
  await click("#add-compliance-manager");
  await fill(search, "unknown");
  await click("[data-select-compliance-manager]");
  assert.ok(!missing(row("pm9")));
  assert.equal($("[data-no-compliance-managers]").hidden, true);
});
