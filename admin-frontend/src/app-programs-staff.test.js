import { test } from "vitest";
import assert from "node:assert/strict";
import {
  $,
  $$,
  adminData,
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
  focused,
} from "../test-support/admin-dom.js";
import { gate } from "../../e2e/admin-tests/admin-mock.js";
import { t } from "../../frontend/src/i18n/i18n.js";

// main.js has no catalog key for this copy, so tests match its English.

const staffRows = () => $$('[aria-labelledby="program-staff-title"] li');
/** @param {string} name */
const staffRow = (name) =>
  staffRows().find((row) => row.textContent.includes(name));
const heading = () => $("admin-app h1").textContent.trim();
// The status badge has no role, label, id or catalog key, so read the English text of the h1's header.
const programHeader = () =>
  $("admin-app h1")
    .parentElement.parentElement.textContent.replace(/\s+/g, " ")
    .trim();

function programData() {
  const data = /** @type {any} */ (adminData());
  data.programs[0].primaryContactUserId = "u1";
  data.sites.push({ siteId: "s3", providerId: "v1", leadProgramId: "p1" });
  data.programUsers.p1 = [
    {
      userId: "u1",
      personId: "u1",
      firstName: "Alex",
      lastName: "Example",
      email: "alex@example.org",
      phone: "4155550101",
      status: "active",
      siteManager: true,
    },
    {
      userId: "u2",
      firstName: "Blair",
      lastName: "Sample",
      email: "blair@example.org",
      phone: "4155550102",
      phoneExtension: "12",
      status: "active",
    },
    {
      userId: "u4",
      firstName: "Gone",
      lastName: "Staff",
      email: "gone@example.org",
      status: "inactive",
    },
  ];
  return data;
}

/**
 * The Program page with one Site whose roster can't be read.
 * @param {string} path
 * @param {Parameters<typeof mountAdmin>[1]} [options]
 */
function openProgram(path, options = {}) {
  return mountAdmin(path, {
    data: programData(),
    ...options,
    setup: (api) => {
      api.fail("GET", /^sites\/s3\?roster=1$/, 500, "site_unavailable");
      options.setup?.(api);
    },
  });
}

/** @param {string} id */
const editForm = (id) => `#edit-program-staff-${id} form`;

test("a Program lists its Sites and active staff with their assignments", async () => {
  await openProgram("/programs/p1");
  assert.equal(heading(), "Example Program");
  assert.equal(programHeader(), "Example Program Active");
  const sites = $$('[aria-labelledby="program-sites-title"] a');
  assert.equal(sites.length, 2);
  assert.match(sites[0].textContent, /Example Site/);
  assert.match(sites[1].textContent, /s3/);
  assert.match(sites[1].textContent, /Active/);
  const staff = staffRows();
  assert.equal(staff.length, 2);
  assert.ok(
    staff[0].textContent.includes(t("admin.programs.primaryContactInline")),
  );
  assert.ok(staff[0].querySelector("a[href='/sites/s1']"));
  assert.ok(
    staff[0].textContent.includes(t("admin.programs.assignmentsUnavailable")),
  );
  assert.match(staff[1].textContent, /4155550102 ext\. 12/);
  assert.ok(!missing("#add-program-staff"));
});

test("a Program under review with no Sites or staff shows empty states", async () => {
  const data = programData();
  data.programs[0].needsReview = true;
  data.programUsers.p1 = [];
  data.sites = data.sites.filter(
    (/** @type {any} */ site) => site.leadProgramId !== "p1",
  );
  await openProgram("/programs/p1", { role: "compliance-manager", data });
  assert.equal(programHeader(), "Example Program Needs review");
  assert.match(pageText(), /No sites are assigned to this program\./);
  assert.ok(pageText().includes(t("admin.programs.noStaff")));
  assert.ok(missing("#add-program-staff"));
});

test("staff with no Sites anywhere say so", async () => {
  const data = programData();
  data.sites = data.sites.filter(
    (/** @type {any} */ site) => site.siteId !== "s3",
  );
  await mountAdmin("/programs/p1", {
    data,
    setup: (api) =>
      api.on("GET", /^programs\/p1$/, () => ({
        json: {
          program: {
            programId: "p1",
            name: "Example Program",
            contact: { email: "BLAIR@example.org" },
          },
          users: [
            { userId: "u9", status: "active" },
            ...api.data.programUsers.p1,
          ],
          sites: api.data.sites.filter(
            (/** @type {any} */ site) => site.leadProgramId === "p1",
          ),
        },
      })),
  });
  const blair = staffRow("Blair");
  assert.ok(blair.textContent.includes(t("admin.programs.noAssignedSites")));
  assert.ok(
    blair.textContent.includes(t("admin.programs.primaryContactInline")),
  );
  // Pins a bug: staff with no name get the label "Edit undefined undefined". No issue filed yet.
  assert.equal(
    $("[data-edit-program-staff='u9']").getAttribute("aria-label"),
    t("admin.programs.editStaffNamed", { name: "undefined undefined" }),
  );
});

test("a supervisor edits a staff member and the list refreshes", async () => {
  const { api } = await openProgram("/programs/p1", {
    setup: (api) =>
      api.on("PATCH", /^programs\/p1\/users\/u2$/, (request) => {
        if (request.body.isPrimaryContact)
          api.data.programs[0].primaryContactUserId = "u2";
        return undefined;
      }),
  });
  await click("[data-edit-program-staff='u2']");
  assert.equal($("#edit-program-staff-u2").open, true);
  await fill(`${editForm("u2")} wa-input[name='staff-first-name']`, "Bailey");
  await click(`${editForm("u2")} wa-checkbox[name='staff-primary-contact']`);
  await click(`${editForm("u2")} button[type='submit']`);
  assert.equal($("#edit-program-staff-u2").open, false);
  assert.ok(staffRow("Bailey Sample"));
  assert.ok(focused("[data-edit-program-staff='u2']"));
  assert.ok(
    staffRow("Bailey").textContent.includes(
      t("admin.programs.primaryContactInline"),
    ),
  );
  assert.ok(
    !staffRow("Alex").textContent.includes(
      t("admin.programs.primaryContactInline"),
    ),
  );
  assert.deepEqual(api.calls("PATCH", /users\/u2$/)[0].body, {
    firstName: "Bailey",
    lastName: "Sample",
    phone: "4155550102",
    phoneExtension: "12",
    email: "blair@example.org",
    siteManager: false,
    isPrimaryContact: true,
  });
});

test("inactive staff stay hidden after a staff edit refreshes the list", async () => {
  await openProgram("/programs/p1");
  await click("[data-edit-program-staff='u2']");
  await fill(`${editForm("u2")} wa-input[name='staff-first-name']`, "Bailey");
  await click(`${editForm("u2")} button[type='submit']`);
  assert.ok(staffRow("Bailey Sample"));
  assert.equal(staffRows().length, 2);
});

test("a staff member's Site link keeps a slash in the Site ID inside one path segment", async () => {
  const data = programData();
  data.sites.push({
    siteId: "s/9",
    name: "Slash Site",
    providerId: "v1",
    leadProgramId: "p1",
    status: "active",
  });
  data.siteItems["s/9"] = [
    {
      sk: "ASSIGNED_USER#u2",
      type: "siteUserAssignment",
      userId: "u2",
      status: "active",
    },
  ];
  await openProgram("/programs/p1", { data });
  assert.ok(staffRow("Blair").querySelector("a[href='/sites/s%2F9']"));
});

test("a compliance manager edits staff without changing email or primary contact", async () => {
  const { api } = await openProgram("/programs/p1", {
    role: "compliance-manager",
  });
  await click("[data-edit-program-staff='u1']");
  assert.equal(
    $(`${editForm("u1")} wa-input[name='staff-email']`).hasAttribute(
      "disabled",
    ),
    true,
  );
  await fill(`${editForm("u1")} wa-input[name='staff-last-name']`, "Examples");
  await click(`${editForm("u1")} button[type='submit']`);
  assert.equal($("#edit-program-staff-u1").open, false);
  assert.deepEqual(api.calls("PATCH", /users\/u1$/)[0].body, {
    firstName: "Alex",
    lastName: "Examples",
    phone: "4155550101",
    phoneExtension: "",
    email: "alex@example.org",
    siteManager: true,
  });
});

test("a failed staff edit keeps the dialog open with an error, and cancel closes it", async () => {
  await openProgram("/programs/p1", {
    setup: (api) =>
      api.fail("PATCH", /^programs\/p1\/users\/u1$/, 409, "person_not_found"),
  });
  await click("[data-edit-program-staff='u1']");
  await click(`${editForm("u1")} button[type='submit']`);
  assert.equal(
    $(`${editForm("u1")} [data-form-save-error]`).textContent.trim(),
    t("admin.programs.staffEditError"),
  );
  assert.equal($("#edit-program-staff-u1").open, true);
  assert.equal($(`${editForm("u1")} button[type='submit']`).disabled, false);
  await click(`${editForm("u1")} [data-cancel-program-staff-edit]`);
  assert.equal($("#edit-program-staff-u1").open, false);
});

test("a second staff edit submit while the first runs is dropped", async () => {
  const held = gate();
  const { api } = await openProgram("/programs/p1", {
    setup: (api) =>
      api.on("PATCH", /^programs\/p1\/users\/u1$/, async () => {
        await held.promise;
        return undefined;
      }),
  });
  await click("[data-edit-program-staff='u1']");
  await click(`${editForm("u1")} button[type='submit']`);
  assert.equal($(editForm("u1")).dataset.saving, "true");
  await submit(editForm("u1"));
  held.release();
  await settle();
  assert.ok(missing("#edit-program-staff-u1[open]"));
  assert.equal(api.calls("PATCH", /users\/u1$/).length, 1);
});

test("a staff edit whose refresh fails shows the error", async () => {
  await openProgram("/programs/p1", {
    setup: (api) =>
      api.on("PATCH", /^programs\/p1\/users\/u1$/, () => {
        api.fail("GET", /^programs\/p1$/, 503, "program_read_failed");
        return undefined;
      }),
  });
  await click("[data-edit-program-staff='u1']");
  await click(`${editForm("u1")} button[type='submit']`);
  // Pins a bug: the raw API code shows instead of a message. No issue filed yet.
  assert.equal(pageError(), "program_read_failed");
});

test("a staff refresh that lands after leaving the Program is dropped", async () => {
  const held = gate();
  await openProgram("/programs/p1", {
    setup: (api) =>
      api.on("PATCH", /^programs\/p1\/users\/u1$/, () => {
        api.on("GET", /^programs\/p1$/, async () => {
          await held.promise;
          return undefined;
        });
        return undefined;
      }),
  });
  await click("[data-edit-program-staff='u1']");
  await click(`${editForm("u1")} button[type='submit']`);
  await routeTo("/programs/p2");
  assert.equal(heading(), "Closed Program");
  held.release();
  await settle();
  assert.equal(heading(), "Closed Program");
  assert.ok(!staffRow("Alex"));
});

test("?addStaff=1 opens the add-staff dialog and the new staff member appears", async () => {
  const { api } = await openProgram("/programs/p1?addStaff=1&tab=staff");
  assert.equal($("#add-program-staff-dialog").open, true);
  assert.equal(
    window.location.pathname + window.location.search,
    "/programs/p1?tab=staff",
  );
  for (const [name, value] of [
    ["staff-first-name", "Riley"],
    ["staff-last-name", "New"],
    ["staff-phone", "4155550103"],
    ["staff-email", "riley@example.org"],
  ])
    await fill(`#program-staff-form wa-input[name='${name}']`, value);
  await click("#program-staff-form button[type='submit']");
  assert.equal($("#add-program-staff-dialog").open, false);
  assert.ok(staffRow("Riley New"));
  assert.ok(focused("#add-program-staff"));
  assert.deepEqual(api.calls("POST", /users$/)[0].body, {
    firstName: "Riley",
    lastName: "New",
    phone: "4155550103",
    phoneExtension: "",
    email: "riley@example.org",
    siteManager: false,
  });
});

test("adding staff explains known and unknown failures and guards double submits", async () => {
  const held = gate();
  let calls = 0;
  await openProgram("/programs/p1?addStaff=1", {
    setup: (api) =>
      api.on("POST", /^programs\/p1\/users$/, async () => {
        calls += 1;
        if (calls === 1) {
          await held.promise;
          return { status: 400, json: { error: "valid_email_required" } };
        }
        return { status: 500, json: { error: "staff_store_down" } };
      }),
  });
  for (const [name, value] of [
    ["staff-first-name", "Riley"],
    ["staff-last-name", "New"],
    ["staff-phone", "4155550103"],
    ["staff-email", "riley@example.org"],
  ])
    await fill(`#program-staff-form wa-input[name='${name}']`, value);
  await click("#program-staff-form button[type='submit']");
  assert.equal($("#program-staff-form").dataset.saving, "true");
  await submit("#program-staff-form");
  held.release();
  await settle();
  const error = () =>
    $("#program-staff-form [data-form-save-error]").textContent.trim();
  assert.equal(error(), t("admin.errors.emailRequired"));
  await click("#program-staff-form button[type='submit']");
  assert.equal(error(), t("admin.programs.staffSaveError"));
  assert.equal(calls, 2);
  await click("#cancel-program-staff");
  assert.equal($("#add-program-staff-dialog").open, false);
  await click("#add-program-staff");
  assert.equal($("#add-program-staff-dialog").open, true);
});

test("a compliance manager's ?addStaff=1 just opens the Program", async () => {
  await openProgram("/programs/p1?addStaff=1", { role: "compliance-manager" });
  assert.ok(focused("admin-app h1"));
  // The add-staff branch strips ?addStaff=1, so a kept query means it never ran.
  assert.equal(
    window.location.pathname + window.location.search,
    "/programs/p1?addStaff=1",
  );
});

test("a Program read that finishes after leaving is not shown", async () => {
  const held = gate();
  const { api } = await mountAdmin("/programs/p1", {
    data: programData(),
    setup: (api) =>
      api.on("GET", /^programs\/p1$/, async (request) => {
        await held.promise;
        return { json: { ...api.reply(request).json, sites: [] } };
      }),
  });
  assert.equal(api.calls("GET", /^programs\/p1$/).length, 1);
  await routeTo("/programs/p2");
  assert.equal(heading(), "Closed Program");
  held.release();
  await settle();
  assert.equal(heading(), "Closed Program");
});

test("a Program reply without Sites or staff lists still renders", async () => {
  await mountAdmin("/programs/p1", {
    data: programData(),
    setup: (api) =>
      api.on("GET", /^programs\/p1$/, {
        json: { program: { programId: "p1", name: "Example Program" } },
      }),
  });
  assert.match(pageText(), /No sites are assigned to this program\./);
  assert.ok(pageText().includes(t("admin.programs.noStaff")));
});

test("a staff refresh reply without staff clears the list", async () => {
  await openProgram("/programs/p1", {
    setup: (api) =>
      api.on("PATCH", /^programs\/p1\/users\/u1$/, () => {
        api.on("GET", /^programs\/p1$/, {
          json: { program: { programId: "p1", name: "Example Program" } },
        });
        return undefined;
      }),
  });
  await click("[data-edit-program-staff='u1']");
  await click(`${editForm("u1")} button[type='submit']`);
  assert.ok(pageText().includes(t("admin.programs.noStaff")));
});

test("renaming a Program saves it and makes the manager directory reload", async () => {
  const { api } = await mountAdmin("/managers", {
    data: programData(),
    setup: (api) =>
      api.on("PATCH", /^programs\/p1$/, (request) => {
        const program = api.data.programs.find(
          (/** @type {any} */ item) => item.programId === "p1",
        );
        Object.assign(program, {
          name: request.body.name,
          contact: request.body.contact,
        });
        return { json: { program: { ...program } } };
      }),
  });
  const reads = api.calls("GET", /^people$/).length;
  await routeTo("/programs/p1");
  const form = "#program-details-form";
  assert.equal($(`${form} [data-save-button]`).disabled, true);
  await fill(`${form} wa-input[name="program-name"]`, "Renamed Program");
  await click(`${form} [data-save-button]`);
  assert.equal(
    api.calls("PATCH", /^programs\/p1$/)[0].body.name,
    "Renamed Program",
  );
  assert.equal(heading(), "Renamed Program");
  // Manager rows carry the Program name, so the cached directory is stale.
  await routeTo("/managers");
  assert.equal(api.calls("GET", /^people$/).length, reads + 1);
});
