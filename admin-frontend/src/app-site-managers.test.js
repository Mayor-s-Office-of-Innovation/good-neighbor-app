import { test } from "vitest";
import assert from "node:assert/strict";
import {
  $,
  $$,
  click,
  fill,
  mountAdmin,
  pageError,
  pageText,
  routeTo,
  settle,
  submit,
  window,
  missing,
} from "../test-support/admin-dom.js";
import { gate } from "../../e2e/admin-tests/admin-mock.js";
import { managerData } from "../../e2e/admin-tests/site-access-helpers.js";
import { t } from "../../frontend/src/i18n/i18n.js";

// main.js has no catalog key for this copy, so tests match its English.

const field = (/** @type {string} */ name) =>
  $(`#site-manager-record-form wa-input[name="${name}"]`);
const saveButton = () => $("#site-manager-record-form [data-save-button]");
const siteBox = (/** @type {string} */ siteId) =>
  $(`wa-checkbox[name="manager-site-id"][value="${siteId}"]`);
const title = () => $("#manager-record-title").textContent.trim();
const saveError = () =>
  document.querySelector("[data-form-save-error]")?.textContent.trim() || "";

/**
 * @param {string} path
 * @param {Parameters<typeof mountAdmin>[1]} [options]
 */
const openManagers = (path, options = {}) =>
  mountAdmin(path, { data: managerData(), ...options });

/** Leave an edited record for `path`, discarding the edit. @param {string} path */
async function discardAndOpen(path) {
  await routeTo(path);
  assert.equal($("#site-unsaved-dialog").open, true);
  await click('#site-unsaved-dialog button[value="discard"]');
}

function overseenData() {
  const data = managerData();
  data.siteItems.s1.push({
    sk: "COMPLIANCE_MANAGER#pm1",
    type: "siteComplianceManagerAssignment",
    managerId: "pm1",
    status: "active",
  });
  return data;
}

const directoryRows = () =>
  $$('[aria-labelledby="managers-title"] li').map((row) =>
    row.textContent.replace(/\s+/g, " ").trim(),
  );

test("the manager directory lists people and legacy staff and filters them", async () => {
  const data = managerData();
  data.people.push({
    personId: "u5",
    firstName: "Sam",
    lastName: "North",
    email: "sam@example.org",
    siteManager: true,
    status: "active",
  });
  data.siteItems.s3 = [
    {
      sk: "MEMBERSHIP#m5",
      type: "managerMembership",
      membershipId: "m5",
      personId: "u5",
      name: "Sam North",
      email: "sam@example.org",
      status: "active",
    },
  ];
  await openManagers("/managers", { data });
  assert.equal(directoryRows().length, 3);
  assert.match(directoryRows()[0], /Alex Example/);
  assert.match(directoryRows()[2], /Sam North/);
  await routeTo("/managers?program=p3");
  assert.match(pageText(), /No site managers match these filters\./);
  await routeTo("/managers?site=s1&program=p1");
  assert.equal(directoryRows().length, 2);
  assert.match(directoryRows()[0], /Alex Example/);
  assert.match(directoryRows()[1], /Morgan Person/);
  await fill('#manager-directory-filters wa-select[name="program"]', "");
  assert.equal(
    window.location.pathname + window.location.search,
    "/managers?site=s1",
  );
  await fill('#manager-directory-filters wa-select[name="site"]', "");
  assert.equal(window.location.pathname + window.location.search, "/managers");
});

test("legacy staff join the directory through an email-only Site membership", async () => {
  const data = managerData();
  data.programUsers.p1.push({
    userId: "u10",
    firstName: "Former",
    lastName: "Staff",
    email: "former@example.org",
    status: "inactive",
    siteManager: true,
  });
  // Older memberships carry only an email; they still match Program staff.
  data.siteItems.s3 = [
    {
      sk: "MEMBERSHIP#m50",
      type: "managerMembership",
      membershipId: "m50",
      name: "Jordan Staff",
      email: "JORDAN@example.org",
      status: "active",
    },
  ];
  await openManagers("/managers", { data });
  // The Site must land on Jordan's own row, not just somewhere in the list.
  assert.match(
    directoryRows().find((row) => row.includes("Jordan Staff")) || "",
    /North Site/,
  );
  assert.ok(!directoryRows().some((row) => row.includes("Former Staff")));
});

test("opening a manager while the directory loads waits for that load", async () => {
  const held = gate();
  const { api } = await openManagers("/managers", {
    setup: (api) =>
      api.on("GET", /^people$/, async () => {
        await held.promise;
        return undefined;
      }),
  });
  assert.equal(api.calls("GET", /^people$/).length, 1);
  // admin-api shares a repeated people read, so a second directory load would
  // show only as an extra programs/p1 read.
  const programReads = api.calls("GET", /^programs\/p1$/).length;
  await routeTo("/managers/u3");
  held.release();
  await settle();
  assert.equal(title(), "Morgan Person");
  assert.equal(api.calls("GET", /^people$/).length, 1);
  assert.equal(api.calls("GET", /^programs\/p1$/).length, programReads);
});

test("an unassigned manager shows a placeholder and a missing manager an error", async () => {
  const data = managerData();
  data.people.push({
    personId: "u5",
    firstName: "Sam",
    lastName: "Unassigned",
    email: "sam@example.org",
    siteManager: true,
    status: "active",
  });
  await openManagers("/managers", { data });
  assert.ok(directoryRows().some((row) => row.includes("No site assigned")));
  await routeTo("/managers/missing");
  assert.equal(pageError(), "Site manager not found.");
});

test("a legacy staff ID opens the person record under its canonical URL", async () => {
  await openManagers("/managers/legacy3?returnSite=s1");
  assert.equal(title(), "Morgan Person");
  assert.equal(
    window.location.pathname + window.location.search,
    "/managers/u3?returnSite=s1",
  );
});

test("saving a person manager updates the record and reconciles Site assignments", async () => {
  const { api } = await openManagers("/managers/u3", {
    setup: (api) => {
      api.on("GET", /^sites\/s3\/manager-memberships$/, {
        json: {
          memberships: [
            {
              membershipId: "m9",
              personId: "u3",
              status: "active",
              siteId: "s3",
            },
          ],
        },
      });
      api.fail(
        "DELETE",
        /^sites\/s1\/manager-memberships\/m3$/,
        404,
        "manager_membership_not_found",
      );
    },
  });
  assert.equal(saveButton().disabled, true);
  await fill(field("manager-first-name"), "Morgana");
  await click(siteBox("s3"));
  await click(siteBox("s1"));
  await click(saveButton());
  assert.equal(title(), "Morgana Person");
  assert.deepEqual(api.calls("POST", /manager-memberships$/), []);
  assert.equal(
    api.calls("DELETE", /^sites\/s1\/manager-memberships\/m3$/).length,
    1,
  );
  assert.equal(siteBox("s3").checked, true);
});

test("a failed assignment removal keeps the new assignment for a safe retry", async () => {
  const { api } = await openManagers("/managers/u3", {
    setup: (api) =>
      api.fail(
        "DELETE",
        /^sites\/s1\/manager-memberships\/m3$/,
        409,
        "manager_membership_conflict",
      ),
  });
  await click(siteBox("s3"));
  await click(siteBox("s1"));
  await click(saveButton());
  assert.equal(saveError(), t("admin.toast.requestFailed"));
  assert.equal(api.calls("POST", /^sites\/s3\/manager-memberships$/).length, 1);
  api.on("DELETE", /^sites\/s1\/manager-memberships\/m3$/, { json: {} });
  await click(saveButton());
  assert.equal(saveError(), "");
  assert.equal(api.calls("POST", /^sites\/s3\/manager-memberships$/).length, 1);
  assert.equal(
    api.calls("DELETE", /^sites\/s1\/manager-memberships\/m3$/).length,
    2,
  );
  assert.equal(siteBox("s1").checked, false);
});

test("an assignment removal fails the save unless the membership is already gone", async () => {
  for (const [status, code] of [
    [404, "site_not_found"],
    [403, "manager_membership_not_found"],
  ]) {
    await openManagers("/managers/u3", {
      setup: (api) =>
        api.fail(
          "DELETE",
          /^sites\/s1\/manager-memberships\/m3$/,
          Number(status),
          String(code),
        ),
    });
    await click(siteBox("s1"));
    await click(saveButton());
    assert.equal(
      saveError(),
      t("admin.toast.requestFailed"),
      `${status} ${code}`,
    );
    assert.equal(siteBox("s1").checked, false);
  }
});

test("a person manager opened from a Site returns there after saving", async () => {
  await openManagers("/managers/u3?returnSite=s1");
  await fill(field("manager-last-name"), "Persona");
  await click(saveButton());
  assert.equal(
    window.location.pathname + window.location.search,
    "/sites/s1?section=details",
  );
});

test("a Site ID with a slash stays one path segment on the way back", async () => {
  const data = managerData();
  data.sites.push({
    siteId: "origin/site",
    name: "Slash Site",
    providerId: "v1",
    leadProgramId: "p1",
    status: "active",
  });
  const { api } = await openManagers("/managers/u3?returnSite=origin%2Fsite", {
    data,
  });
  await fill(field("manager-last-name"), "Persona");
  await click(saveButton());
  assert.equal(
    window.location.pathname + window.location.search,
    "/sites/origin%2Fsite?section=details",
  );
  // Pins a bug: the router keeps the ID encoded and getSite encodes it again,
  // so the Site reads as not found. No issue filed yet.
  assert.deepEqual(
    api.calls("GET", /^sites\/[^/?]*origin/).map((request) => request.path),
    ["sites/origin%252Fsite"],
  );
  assert.match(pageError(), /^not_found/);
});

test("a person save that finishes after navigation leaves the new page alone", async () => {
  const held = gate();
  const { api } = await openManagers("/managers/u3", {
    setup: (api) =>
      api.on("PATCH", /^people\/u3$/, async () => {
        await held.promise;
        return undefined;
      }),
  });
  await fill(field("manager-last-name"), "Later");
  await click(saveButton());
  assert.equal(api.calls("PATCH", /^people\/u3$/).length, 1);
  await discardAndOpen("/providers");
  assert.ok(!missing('a[href="/providers/v1"]'));
  held.release();
  await settle();
  assert.equal(window.location.pathname, "/providers");
  assert.ok(missing("#manager-record-title"));
});

test("adding a manager creates the person and opens the new record", async () => {
  const { api } = await openManagers("/managers/new");
  assert.equal(title(), "Add new manager");
  await fill(field("manager-first-name"), "Riley");
  await fill(field("manager-last-name"), "New");
  await fill(field("manager-phone"), "4155550109");
  await fill(field("manager-email"), "riley@example.org");
  await click(siteBox("s3"));
  await click(saveButton());
  assert.equal(window.location.pathname, "/managers/person-4");
  assert.equal(title(), "Riley New");
  const body = api.calls("POST", /^people$/)[0].body;
  assert.equal(body.firstName, "Riley");
  assert.equal(body.primaryProgramId, "");
});

test("a new manager whose second Site fails retries only that Site, as the same person", async () => {
  let failures = 0;
  const { api } = await openManagers("/managers/new", {
    setup: (api) =>
      api.on("POST", /^sites\/s3\/manager-memberships$/, () =>
        ++failures === 1
          ? { status: 500, json: { error: "assignment_failed" } }
          : undefined,
      ),
  });
  await fill(field("manager-first-name"), "Riley");
  await fill(field("manager-last-name"), "New");
  await fill(field("manager-phone"), "4155550109");
  await fill(field("manager-email"), "riley@example.org");
  await click(siteBox("s1"));
  await click(siteBox("s3"));
  await click(saveButton());
  assert.equal(saveError(), t("admin.toast.requestFailed"));
  await click(saveButton());
  assert.equal(saveError(), "");
  assert.equal(api.calls("POST", /^people$/).length, 1);
  assert.equal(api.calls("GET", /^sites\/s1\/manager-memberships$/).length, 1);
  assert.equal(api.calls("POST", /^sites\/s1\/manager-memberships$/).length, 1);
  assert.equal(api.calls("POST", /^sites\/s3\/manager-memberships$/).length, 2);
});

test("renaming a person manager keeps their Sites without rereading them", async () => {
  const { api } = await openManagers("/managers/u3");
  const programReads = api.calls("GET", /^programs$/).length;
  await fill(field("manager-first-name"), "Morgana");
  await click(saveButton());
  assert.equal(title(), "Morgana Person");
  assert.equal(siteBox("s1").checked, true);
  assert.deepEqual(api.calls("GET", /manager-memberships$/), []);
  assert.equal(api.calls("GET", /^programs$/).length, programReads);
});

test("a manager added from a Site returns to that Site", async () => {
  await openManagers("/managers/new?returnSite=s1");
  assert.equal(
    $('a[data-route]:has(> wa-icon[name="chevron-left"])').getAttribute("href"),
    "/sites/s1?section=details",
  );
  await fill(field("manager-first-name"), "Riley");
  await fill(field("manager-last-name"), "New");
  await fill(field("manager-phone"), "4155550109");
  await fill(field("manager-email"), "riley@example.org");
  await click(saveButton());
  assert.equal(
    window.location.pathname + window.location.search,
    "/sites/s1?section=details",
  );
});

test("saving a legacy manager updates staff and converts its Site assignment", async () => {
  const data = managerData();
  let inFlight = 0;
  let peak = 0;
  const { api } = await openManagers("/managers/u1", {
    data,
    setup: (api) => {
      api.on("PATCH", /^sites\/s1\/manager-memberships\/m-s1$/, (request) => {
        const membership = data.siteItems.s1.find(
          (/** @type {any} */ item) => item.membershipId === "m-s1",
        );
        Object.assign(membership, {
          name: request.body.name,
          email: request.body.email,
        });
        return { json: { membership: { ...membership } } };
      });
      api.on("POST", /^sites\/s\d\/manager-memberships$/, async (request) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        // Held a turn, so a parallel second POST would overlap this one.
        await new Promise((resolve) => setImmediate(resolve));
        inFlight -= 1;
        const siteId = request.path.split("/")[1];
        const membership = {
          type: "managerMembership",
          membershipId: `m-${siteId}`,
          siteId,
          status: "active",
        };
        // Stored, so the later PATCH finds it as the backend would.
        (data.siteItems[siteId] ||= []).push(membership);
        return { json: { membership } };
      });
    },
  });
  assert.ok(!missing("[data-remove-site-manager]"));
  await fill(field("manager-first-name"), "Alexis");
  await click(siteBox("s3"));
  await click(saveButton());
  assert.equal(title(), "Alexis Example");
  assert.deepEqual(
    api.calls("POST", /manager-memberships$/).map((call) => call.path),
    ["sites/s1/manager-memberships", "sites/s3/manager-memberships"],
  );
  // The backend updates a shared staff count per membership, so creates go one at a time.
  assert.equal(peak, 1);
  await click(siteBox("s3"));
  await fill(field("manager-first-name"), "Alex");
  await click(saveButton());
  assert.equal(title(), "Alex Example");
  assert.deepEqual(
    api.calls("PATCH", /manager-memberships\//).map((call) => call.path),
    ["sites/s1/manager-memberships/m-s1"],
  );
  assert.deepEqual(
    api.calls("DELETE", /manager-memberships\//).map((call) => call.path),
    ["sites/s3/manager-memberships/m-s3"],
  );
});

test("unassigning a legacy Site assignment removes the staff link", async () => {
  const { api } = await openManagers("/managers/u1");
  await click(siteBox("s1"));
  await click(saveButton());
  assert.equal(api.calls("DELETE", /^sites\/s1\/users\/u1$/).length, 1);
});

test("moving a legacy manager to another Program asks first, then reuses matching staff", async () => {
  const data = managerData();
  data.programUsers.p3 = [
    { userId: "old", email: "ALEX@example.org", status: "inactive" },
    { userId: "u7", email: "alex@example.org", status: "active" },
  ];
  const { api } = await openManagers("/managers/u1", { data });
  await fill('wa-select[name="manager-program-id"]', "p3");
  assert.equal(saveButton().disabled, false);
  await click(saveButton());
  assert.equal($("#manager-program-change-dialog").open, true);
  await click('#manager-program-change-dialog button[value="cancel"]');
  await click(saveButton());
  await click('#manager-program-change-dialog button[value="confirm"]');
  assert.equal(window.location.pathname, "/managers/u7");
  assert.deepEqual(
    api.calls("PATCH", /users/).map((call) => call.path),
    ["programs/p3/users/u7", "programs/p1/users/u1"],
  );
  assert.equal(
    api.calls("PATCH", /^programs\/p1\/users\/u1$/)[0].body.siteManager,
    false,
  );
});

test("moving a legacy manager to a Program without matching staff creates staff", async () => {
  const { api } = await openManagers("/managers/u1");
  await fill('wa-select[name="manager-program-id"]', "p3");
  await click(saveButton());
  await click('#manager-program-change-dialog button[value="confirm"]');
  assert.equal(window.location.pathname, "/managers/p3-u1");
  const created = api.calls("POST", /^programs\/p3\/users$/)[0].body;
  assert.deepEqual(
    [created.email, created.siteManager],
    ["alex@example.org", true],
  );
  assert.equal(
    api.calls("PATCH", /^programs\/p1\/users\/u1$/)[0].body.siteManager,
    false,
  );
});

test("legacy manager save errors explain the API code", async () => {
  const { api } = await openManagers("/managers/u1");
  await fill(field("manager-first-name"), "Changed");
  for (const [code, message] of [
    ["first_name_required", "Enter the manager's first name."],
    ["last_name_required", "Enter the manager's last name."],
    ["valid_email_required", "Enter a valid contact email."],
    ["invalid_manager_email", "Enter a valid contact email."],
    ["phone_required", "Enter a contact phone number."],
    [
      "manager_membership_exists",
      "This manager is already assigned to one of the selected Sites.",
    ],
    [
      "manager_membership_conflict",
      "A Site assignment changed. Reload the manager and try again.",
    ],
    ["unexpected", "The site manager couldn't be saved. Try again."],
  ]) {
    api.fail("PATCH", /^programs\/p1\/users\/u1$/, 400, code);
    await click(saveButton());
    assert.equal(saveError(), message);
  }
});

test("a legacy manager saved after navigation does not redraw the record", async () => {
  const held = gate();
  const { api } = await openManagers("/managers/u1?returnSite=s1", {
    setup: (api) =>
      api.on("PATCH", /^programs\/p1\/users\/u1$/, async () => {
        await held.promise;
        return undefined;
      }),
  });
  await fill(field("manager-first-name"), "Later");
  await click(saveButton());
  assert.equal(api.calls("PATCH", /users\/u1$/).length, 1);
  await discardAndOpen("/providers");
  held.release();
  await settle();
  assert.equal(window.location.pathname, "/providers");
  assert.ok(missing("#manager-record-title"));
});

test("a legacy manager opened from a Site returns there after saving", async () => {
  await openManagers("/managers/u1?returnSite=s1");
  await fill(field("manager-first-name"), "Back");
  await click(saveButton());
  assert.equal(
    window.location.pathname + window.location.search,
    "/sites/s1?section=details",
  );
});

test("removing a legacy manager returns to the directory or the Site", async () => {
  /** @param {any} api */
  const serveRemoval = (api) =>
    api.on("DELETE", /^programs\/p1\/users\/u1$/, () => {
      const user = api.data.programUsers.p1.find(
        (/** @type {any} */ item) => item.userId === "u1",
      );
      user.status = "inactive";
      return { json: { user: { ...user } } };
    });
  const { api } = await openManagers("/managers/u1", { setup: serveRemoval });
  await click("[data-remove-site-manager]");
  await click('#remove-site-manager-dialog button[value="cancel"]');
  assert.deepEqual(api.calls("DELETE", /users\/u1$/), []);
  await click("[data-remove-site-manager]");
  await click('#remove-site-manager-dialog button[value="confirm"]');
  assert.equal(window.location.pathname, "/managers");
  assert.equal(api.calls("DELETE", /^programs\/p1\/users\/u1$/).length, 1);
  await openManagers("/managers/u1?returnSite=s1", { setup: serveRemoval });
  await click("[data-remove-site-manager]");
  await click('#remove-site-manager-dialog button[value="confirm"]');
  assert.equal(
    window.location.pathname + window.location.search,
    "/sites/s1?section=details",
  );
});

test("a failed manager removal says why", async () => {
  const { api } = await openManagers("/managers/u1");
  for (const [code, message] of [
    [
      "site_primary_contact_in_use",
      t("admin.programs.reassignPrimaryBeforeRemoval"),
    ],
    [
      "manager_removal_conflict",
      "The manager or one of their Site assignments changed. Reload and try again.",
    ],
    ["unexpected", "The manager could not be removed. Try again."],
  ]) {
    api.fail("DELETE", /^programs\/p1\/users\/u1$/, 409, code);
    await click("[data-remove-site-manager]");
    await click('#remove-site-manager-dialog button[value="confirm"]');
    assert.ok(pageText().includes(message), message);
  }
});

test("removing every device for a manager needs their email", async () => {
  const { api } = await openManagers("/managers/u3", {
    setup: (api) =>
      api.on("POST", /^people\/u3\/devices:revoke$/, {
        json: { affectedCount: 2 },
      }),
  });
  const button = () => $("#revoke-manager-devices button");
  assert.equal(button().disabled, true);
  await fill("#revoke-manager-devices wa-input", "MORGAN@example.org ");
  assert.equal(button().disabled, false);
  await click(button());
  assert.equal(
    $("#revoke-manager-devices [data-revocation-status]").textContent.trim(),
    t("admin.devices.managerRevoked", { count: 2 }),
  );
  assert.equal($("#revoke-manager-devices wa-input").value, "");
  await submit("#revoke-manager-devices");
  assert.equal(api.calls("POST", /devices:revoke$/).length, 1);
});

test("legacy manager device removal goes through Program staff and reports failure", async () => {
  const { api } = await openManagers("/managers/u1", {
    setup: (api) =>
      api.fail("POST", /^programs\/p1\/users\/u1\/devices:revoke$/),
  });
  await fill("#revoke-manager-devices wa-input", "alex@example.org");
  await click("#revoke-manager-devices button");
  assert.equal(
    $("#revoke-manager-devices [data-revocation-status]").textContent.trim(),
    t("admin.devices.managerRevokeFailed"),
  );
  assert.equal(api.calls("POST", /devices:revoke$/).length, 1);
});

test("a compliance manager edits a manager only when they oversee every assigned Site", async () => {
  const { api } = await openManagers("/managers/u3", {
    role: "compliance-manager",
    data: overseenData(),
  });
  assert.equal($("#site-manager-record-form").dataset.readOnly, "false");
  await fill(field("manager-phone"), "4155550199");
  await click(saveButton());
  // Pins a bug: the disabled Program select leaves FormData, so an unchanged
  // Program reads as a move and asks for confirmation. No issue filed yet.
  assert.equal($("#manager-program-change-dialog").open, true);
  await click('#manager-program-change-dialog button[value="confirm"]');
  assert.equal(api.calls("PATCH", /^people\/u3$/).length, 1);
  const body = api.calls("PATCH", /^people\/u3$/)[0].body;
  assert.equal(body.email, "morgan@example.org");
  assert.equal("primaryProgramId" in body, false);
  assert.deepEqual(api.calls("DELETE", /manager-memberships/), []);
});

test("a compliance manager editing a manager cannot change their Program, Provider, email or Sites", async () => {
  await openManagers("/managers/u3", {
    role: "compliance-manager",
    data: overseenData(),
  });
  assert.equal($("#site-manager-record-form").dataset.readOnly, "false");
  for (const control of [
    $('#site-manager-record-form wa-select[name="manager-program-id"]'),
    $('#site-manager-record-form wa-select[name="manager-provider-id"]'),
    field("manager-email"),
    siteBox("s1"),
    siteBox("s3"),
  ])
    assert.equal(control.hasAttribute("disabled"), true);
  assert.equal(field("manager-phone").hasAttribute("disabled"), false);
});

test("a compliance manager overseeing only some of a manager's Sites sees it read-only", async () => {
  const data = overseenData();
  data.siteItems.s3 = [
    {
      sk: "MEMBERSHIP#m8",
      type: "managerMembership",
      membershipId: "m8",
      personId: "u3",
      status: "active",
    },
  ];
  await openManagers("/managers/u3", { role: "compliance-manager", data });
  assert.equal($("#site-manager-record-form").dataset.readOnly, "true");
  assert.equal(saveButton().disabled, true);
});

test("a compliance manager with no directory profile sees a read-only manager", async () => {
  const data = overseenData();
  data.profile = { ...data.profile, directoryUserId: undefined };
  await openManagers("/managers/u3", { role: "compliance-manager", data });
  assert.equal($("#site-manager-record-form").dataset.readOnly, "true");
});

test("a compliance manager without oversight sees a read-only manager", async () => {
  await openManagers("/managers/u3", { role: "compliance-manager" });
  assert.equal($("#site-manager-record-form").dataset.readOnly, "true");
  assert.equal(saveButton().disabled, true);
  assert.equal($("#revoke-manager-devices button").disabled, true);
});

test("a compliance manager saves a legacy manager without changing assignments", async () => {
  const { api } = await openManagers("/managers/u1", {
    role: "compliance-manager",
    data: overseenData(),
  });
  await fill(field("manager-first-name"), "Alexa");
  await click(saveButton());
  // Pins the same unchanged-Program confirmation bug as above.
  assert.equal($("#manager-program-change-dialog").open, true);
  await click('#manager-program-change-dialog button[value="confirm"]');
  assert.equal(title(), "Alexa Example");
  assert.deepEqual(api.calls("POST", /manager-memberships/), []);
  assert.equal(
    api.calls("PATCH", /users\/u1$/)[0].body.email,
    "alex@example.org",
  );
});
