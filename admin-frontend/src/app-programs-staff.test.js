import { test } from "vitest";
import assert from "node:assert/strict";
import {
  $,
  $$,
  adminData,
  click,
  fill,
  leavePage,
  mountPage,
  pageText,
  settle,
  submit,
  window,
  missing,
  focused,
} from "../test-support/admin-dom.js";
import { gate } from "../../e2e/admin-tests/admin-mock.js";
import { t } from "../../frontend/src/i18n/i18n.js";
import { currentRoute } from "./router.js";
import "./pages/program/program-page.js";

// pages/program/program.templates.js has no catalog key for this copy, so tests match its English.

const staffRows = () => $$('[aria-labelledby="program-staff-title"] li');
/** @param {string} name */
const staffRow = (name) =>
  staffRows().find((row) => row.textContent.includes(name));
const heading = () => $("admin-program-page h1").textContent.trim();
// The status badge has no role, label, id or catalog key, so read the English text of the h1's header.
const programHeader = () =>
  $("admin-program-page h1")
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

/** The Program page's own reads and saves; any other request fails a page test. */
const programCalls = [
  /^GET programs\/[^/]+$/,
  /^GET sites\/[^/?]+\?roster=1$/,
  /^PATCH programs\/[^/]+$/,
  /^(POST|PATCH) programs\/[^/]+\/users(\/[^/]+)?$/,
];

/** @typedef {Omit<Parameters<typeof mountPage>[2], "calls">} PageOptions */

/**
 * The Program page alone, with one Site whose roster can't be read.
 * @param {string} path
 * @param {Partial<PageOptions>} [options]
 */
function openProgramPage(path, options = {}) {
  return mountPage("admin-program-page", path, {
    calls: programCalls,
    data: programData(),
    ...options,
    setup: (/** @type {any} */ api) => {
      api.fail("GET", /^sites\/s3\?roster=1$/, 500, "site_unavailable");
      options.setup?.(api);
    },
  });
}

/**
 * What <admin-app> does when the user moves to `path` and keeps this page on screen.
 * @param {any} page
 * @param {string} path
 */
async function revisit(page, path) {
  window.history.pushState({}, "", path);
  if (await page.open(currentRoute())) {
    page.render();
    page.focusOnOpen();
  }
  await settle();
}

/** @param {string} id */
const editForm = (id) => `#edit-program-staff-${id} form`;

test("a Program lists its Sites and active staff with their assignments", async () => {
  await openProgramPage("/programs/p1");
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
  await openProgramPage("/programs/p1", { role: "compliance-manager", data });
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
  await mountPage("admin-program-page", "/programs/p1", {
    calls: programCalls,
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
  const { api } = await openProgramPage("/programs/p1", {
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
  await openProgramPage("/programs/p1");
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
  await openProgramPage("/programs/p1", { data });
  assert.ok(staffRow("Blair").querySelector("a[href='/sites/s%2F9']"));
});

test("a compliance manager edits staff without changing email or primary contact", async () => {
  const { api } = await openProgramPage("/programs/p1", {
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
  await openProgramPage("/programs/p1", {
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
  const { api } = await openProgramPage("/programs/p1", {
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

test("a staff edit whose refresh fails reports the error", async () => {
  const { errors } = await openProgramPage("/programs/p1", {
    recordErrors: true,
    setup: (api) =>
      api.on("PATCH", /^programs\/p1\/users\/u1$/, () => {
        api.fail("GET", /^programs\/p1$/, 503, "program_read_failed");
        return undefined;
      }),
  });
  await click("[data-edit-program-staff='u1']");
  await click(`${editForm("u1")} button[type='submit']`);
  // The Program page passes the API code on; <admin-app> shows a sentence for it.
  assert.deepEqual(errors, ["program_read_failed"]);
});

test("a staff refresh that lands after leaving the Program is dropped", async () => {
  const held = gate();
  const { page } = await openProgramPage("/programs/p1", {
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
  await revisit(page, "/programs/p2");
  assert.equal(heading(), "Closed Program");
  held.release();
  await settle();
  assert.equal(heading(), "Closed Program");
  assert.ok(!staffRow("Alex"));
});

test("a staff refresh that fails after leaving the Program still reports the error", async () => {
  const held = gate();
  const { errors } = await openProgramPage("/programs/p1", {
    recordErrors: true,
    setup: (api) =>
      api.on("PATCH", /^programs\/p1\/users\/u1$/, () => {
        api.on("GET", /^programs\/p1$/, {
          delay: held.promise,
          status: 503,
          json: {
            error: "program_read_failed",
            message: "program_read_failed",
          },
        });
        return undefined;
      }),
  });
  await click("[data-edit-program-staff='u1']");
  await click(`${editForm("u1")} button[type='submit']`);
  await leavePage("/sites");
  held.release();
  await settle();
  // The page reports the raw error; <admin-app>'s error line shows it as a plain message.
  assert.deepEqual(errors, ["program_read_failed"]);
});

test("?addStaff=1 opens the add-staff dialog and the new staff member appears", async () => {
  const { api } = await openProgramPage("/programs/p1?addStaff=1&tab=staff");
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
  await openProgramPage("/programs/p1?addStaff=1", {
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
  await openProgramPage("/programs/p1?addStaff=1", {
    role: "compliance-manager",
  });
  assert.ok(focused("admin-program-page h1"));
  // The add-staff branch strips ?addStaff=1, so a kept query means it never ran.
  assert.equal(
    window.location.pathname + window.location.search,
    "/programs/p1?addStaff=1",
  );
});

test("a Program read that finishes after leaving is not shown", async () => {
  const held = gate();
  const { api, page } = await openProgramPage("/programs/p2", {
    setup: (api) =>
      api.on("GET", /^programs\/p1$/, async (request) => {
        await held.promise;
        return { json: { ...api.reply(request).json, sites: [] } };
      }),
  });
  window.history.pushState({}, "", "/programs/p1");
  const late = page.open(currentRoute());
  await settle();
  assert.equal(api.calls("GET", /^programs\/p1$/).length, 1);
  await revisit(page, "/programs/p2");
  assert.equal(heading(), "Closed Program");
  held.release();
  assert.equal(await late, false);
  await settle();
  assert.equal(heading(), "Closed Program");
});

test("a Program reply without Sites or staff lists still renders", async () => {
  await mountPage("admin-program-page", "/programs/p1", {
    calls: programCalls,
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
  await openProgramPage("/programs/p1", {
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
  const { api, catalog } = await openProgramPage("/programs/p1", {
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
  catalog.markManagersLoaded(catalog.managersVersion);
  const form = "#program-details-form";
  assert.equal($(`${form} [data-save-button]`).disabled, true);
  await fill(`${form} wa-input[name="program-name"]`, "Renamed Program");
  await click(`${form} [data-save-button]`);
  assert.equal(
    api.calls("PATCH", /^programs\/p1$/)[0].body.name,
    "Renamed Program",
  );
  assert.equal(heading(), "Renamed Program");
  // Manager rows carry the Program name, so the loaded directory is stale.
  assert.equal(catalog.managersLoaded, false);
});

test("leaving a renamed Program after a staff edit asks first, and Discard leaves", async () => {
  const { page } = await openProgramPage("/programs/p1");
  // The staff edit redraws only the Program page, so its leave dialog is new markup.
  await click("[data-edit-program-staff='u2']");
  await click(`${editForm("u2")} button[type='submit']`);
  await fill('#program-details-form wa-input[name="program-name"]', "Draft");
  assert.equal(page.hasUnsavedChanges(), true);
  const leave = page.confirmLeave();
  await settle();
  assert.equal($("#site-unsaved-dialog").open, true);
  await click('#site-unsaved-dialog button[value="discard"]');
  assert.equal(await leave, true);
});

test("Keep editing on the Program page's leave dialog stays", async () => {
  const { page } = await openProgramPage("/programs/p1");
  await fill('#program-details-form wa-input[name="program-name"]', "Draft");
  const leave = page.confirmLeave();
  await settle();
  await click('#site-unsaved-dialog button[value="keep"]');
  assert.equal(await leave, false);
  assert.equal(page.hasUnsavedChanges(), true);
});

test("a Program page redraw while the leave dialog is open keeps the user on the page", async () => {
  const { page } = await openProgramPage("/programs/p1");
  await fill('#program-details-form wa-input[name="program-name"]', "Draft");
  const leave = page.confirmLeave();
  await settle();
  assert.equal(page.confirmLeave(), leave);
  page.render();
  assert.equal(await leave, false);
});

test("resetting the Program name form clears its unsaved edit", async () => {
  const { page } = await openProgramPage("/programs/p1");
  const form = "#program-details-form";
  await fill(`${form} wa-input[name="program-name"]`, "Draft");
  assert.equal(page.hasUnsavedChanges(), true);
  $(form).reset();
  await settle();
  assert.equal(page.hasUnsavedChanges(), false);
  assert.equal($(`${form} [data-save-button]`).disabled, true);
});

test("the Program page reports an edited name as unsaved, with no app around it", async () => {
  const { page } = await openProgramPage("/programs/p1");
  assert.equal(page.hasUnsavedChanges(), false);
  await fill('#program-details-form wa-input[name="program-name"]', "Draft");
  assert.equal(page.hasUnsavedChanges(), true);
});

/**
 * Whether the manager directory must read again after the save.
 * @param {() => Promise<void>} save
 */
async function managersStaleAfter(save) {
  const { catalog } = await openProgramPage("/programs/p1");
  catalog.markManagersLoaded(catalog.managersVersion);
  await save();
  return !catalog.managersLoaded;
}

test("editing Program staff makes the manager directory reload", async () => {
  const stale = await managersStaleAfter(async () => {
    await click("[data-edit-program-staff='u2']");
    await fill(`${editForm("u2")} wa-input[name='staff-first-name']`, "Bo");
    await click(`${editForm("u2")} button[type='submit']`);
  });
  assert.equal(stale, true);
});

test("adding Program staff makes the manager directory reload", async () => {
  const stale = await managersStaleAfter(async () => {
    await click("#add-program-staff");
    for (const [name, value] of [
      ["staff-first-name", "Riley"],
      ["staff-last-name", "New"],
      ["staff-phone", "4155550103"],
      ["staff-email", "riley@example.org"],
    ])
      await fill(`#program-staff-form wa-input[name='${name}']`, value);
    await click("#program-staff-form button[type='submit']");
  });
  assert.equal(stale, true);
});

test("a failed read of another Program doesn't leave the last one showing", async () => {
  const { api, page } = await openProgramPage("/programs/p1");
  api.fail("GET", /^programs\/p2$/, 500, "program_read_failed");
  await assert.rejects(revisit(page, "/programs/p2"), /program_read_failed/);
  page.render();
  assert.ok(missing("[aria-labelledby='program-staff-title']"));
});

test("a Program read shared with an earlier visit doesn't cancel the add-staff dialog", async () => {
  const read = gate();
  const { page } = await openProgramPage("/programs/p2", {
    setup: (api) =>
      api.on("GET", /^programs\/p1$/, async () => {
        await read.promise;
        return undefined;
      }),
  });
  window.history.pushState({}, "", "/programs/p1?addStaff=1");
  const earlier = page.open(currentRoute());
  page.leave();
  const later = revisit(page, "/programs/p1?addStaff=1");
  read.release();
  await later;
  assert.equal(await earlier, false);
  assert.equal($("#add-program-staff-dialog").open, true);
});

/**
 * Stubbed after the redraws, since each render replaces the dialog.
 * @param {any} page
 */
function countStaffDialogOpens(page) {
  const opens = { count: 0 };
  page.querySelector("#add-program-staff-dialog").showModal = () =>
    (opens.count += 1);
  return opens;
}

test("the add-staff button still opens its dialog after the page redraws", async () => {
  const { page } = await openProgramPage("/programs/p1");
  page.render();
  page.render();
  page.render();
  await click("#add-program-staff");
  assert.equal($("#add-program-staff-dialog").open, true);
});

test("after several redraws one click opens the add-staff dialog once", async () => {
  const { page } = await openProgramPage("/programs/p1");
  page.render();
  page.render();
  const opens = countStaffDialogOpens(page);
  await click("#add-program-staff");
  assert.equal(opens.count, 1);
});

test("a removed Program page no longer answers its controls", async () => {
  const { page } = await openProgramPage("/programs/p1");
  const opens = countStaffDialogOpens(page);
  const button = $("#add-program-staff");
  page.remove();
  await click(button);
  assert.equal(opens.count, 0);
});

test("a staff member's phone extension can be added and removed in the edit dialog", async () => {
  await openProgramPage("/programs/p1");
  const field = `${editForm("u1")} [data-phone-extension]`;
  const add = `${editForm("u1")} [data-add-extension]`;
  assert.equal($(field).hidden, true);
  await click(add);
  assert.equal($(field).hidden, false);
  await fill(`${field} wa-input`, "34");
  await click(`${field} [data-remove-extension]`);
  assert.equal($(field).hidden, true);
  assert.equal($(`${field} wa-input`).value, "");
  assert.equal($(add).hidden, false);
});

test("a Program page draws nothing after leave(), even at its own address", async () => {
  const { page } = await openProgramPage("/programs/p1");
  page.leave();
  page.render();
  assert.equal(page.innerHTML, "");
});

test("a Program page redrawn after the address changes still draws its own visit", async () => {
  const { page } = await openProgramPage("/programs/p1");
  window.history.pushState({}, "", "/sites");
  page.render();
  assert.equal(heading(), "Example Program");
});

const crumbs = `nav[aria-label="${t("admin.breadcrumb.label")}"]`;

test("a program page's breadcrumb names the program as the current page", async () => {
  await openProgramPage("/programs/p1");
  assert.equal(
    $(`${crumbs} [aria-current="page"]`).textContent,
    t("admin.breadcrumb.program"),
  );
});
