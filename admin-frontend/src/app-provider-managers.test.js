import { test } from "vitest";
import assert from "node:assert/strict";
import {
  $,
  $$,
  click,
  fill,
  mountPage,
  pageError,
  pageText,
  routeTo,
  settle,
  submit,
  toastText,
  window,
  missing,
} from "../test-support/admin-dom.js";
import { gate } from "../../e2e/admin-tests/admin-mock.js";
import { providerData } from "../../e2e/admin-tests/providers-helpers.js";
import { t } from "../../frontend/src/i18n/i18n.js";
import "./pages/directory/directory-page.js";
import "./pages/provider/provider-page.js";

const managers = /^providers\/v1\/manager-memberships$/;

/** The Provider page's reads and its manager writes; any other request fails a page test. */
const providerCalls = [
  /^GET providers\/[^/]+$/,
  /^GET providers\/[^/]+\/(manager-memberships|grants)$/,
  /^GET people$/,
  /^(POST|PATCH|DELETE) providers\/[^/]+\/manager-memberships(\/[^/]+){0,2}$/,
  /^POST providers\/[^/]+\/manager-enrollments\/[^/]+\/revoke$/,
];

/**
 * <admin-provider-page> alone, without <admin-app>, following the provider routes.
 * Its errors show through pageError(), as <admin-app>'s error line would show them.
 * @param {string} path
 * @param {Partial<Parameters<typeof mountPage>[2]>} [options]
 */
const openProviderPage = (path, options = {}) =>
  mountPage("admin-provider-page", path, {
    calls: providerCalls,
    follow: ["provider", "provider-new", "provider-manager"],
    recordErrors: true,
    data: providerData(),
    ...options,
  });

/**
 * <admin-directory-page> on the Provider managers list, which reads each provider's managers.
 * @param {string} path
 * @param {Partial<Parameters<typeof mountPage>[2]>} [options]
 */
const openManagerDirectory = (path, options = {}) =>
  mountPage("admin-directory-page", path, {
    calls: [
      /^GET providers\/[^/]+\/manager-memberships$/,
      // A search in the URL reads the manager directory, which makes these calls.
      /^GET programs\/[^/]+$/,
      /^GET sites\/[^/]+\/manager-memberships$/,
      /^GET sites\/[^/]+\?roster=1$/,
      /^GET people$/,
    ],
    follow: ["provider-managers"],
    sites: true,
    data: providerData(),
    ...options,
  });

const rows = () => $$("[data-provider-manager-row]");
const heading = () => $("admin-provider-page h1").textContent.trim();
const url = () => window.location.pathname + window.location.search;
const dialogForm = "#add-provider-manager-dialog form";

/** @param {string} scope @param {string} name @param {string} value */
const fillIn = (scope, name, value) =>
  fill(`${scope} wa-input[name='${name}']`, value);

async function fillNewManager() {
  await click("#add-provider-manager");
  await fillIn(dialogForm, "provider-manager-first-name", "Jordan");
  await fillIn(dialogForm, "provider-manager-last-name", "Sample");
  await fillIn(dialogForm, "provider-manager-email", "jordan@example.org");
  await fillIn(dialogForm, "provider-manager-phone", "4155550199");
}

/** Press Escape on a dialog; returns whether the dialog refused to close. @param {string} selector */
function escape(selector) {
  const cancel = new window.Event("cancel", { cancelable: true });
  $(selector).dispatchEvent(cancel);
  if (!cancel.defaultPrevented) $(selector).close();
  return cancel.defaultPrevented;
}

test("a supervisor adds a provider manager from the dialog", async () => {
  const data = providerData();
  const { api } = await openProviderPage("/providers/v1", {
    data,
    setup: (api) =>
      api.on("POST", managers, (request) => {
        const manager = {
          ...request.body,
          membershipId: "m9",
          providerId: "v1",
          name: `${request.body.firstName} ${request.body.lastName}`,
          status: "active",
        };
        data.providerManagers.push(manager);
        return { json: { manager } };
      }),
  });
  assert.equal(rows().length, 1);
  assert.ok(
    rows()[0].textContent.includes(
      t("admin.providerManagers.deviceCount", { count: 1 }),
    ),
  );
  await fillNewManager();
  assert.equal($("#add-provider-manager-dialog").open, true);
  await click(`${dialogForm} button[type='submit']`);
  assert.equal(rows().length, 2);
  assert.deepEqual(api.calls("POST", managers)[0].body, {
    firstName: "Jordan",
    lastName: "Sample",
    email: "jordan@example.org",
    phone: "4155550199",
    phoneExtension: "",
  });
});

test("a failed manager save keeps the dialog draft and a closed dialog resets it", async () => {
  await openProviderPage("/providers/v1", {
    setup: (api) =>
      api.fail("POST", managers, 409, "provider_manager_already_assigned"),
  });
  await fillNewManager();
  await click(`${dialogForm} button[type='submit']`);
  assert.equal(
    $(`${dialogForm} [data-form-save-error]`).textContent.trim(),
    t("admin.errors.staffAssigned"),
  );
  const field = (/** @type {string} */ name) =>
    $(`${dialogForm} wa-input[name='${name}']`).value;
  assert.equal(field("provider-manager-first-name"), "Jordan");
  assert.equal(field("provider-manager-email"), "jordan@example.org");
  await click(`${dialogForm} [data-close-dialog]`);
  assert.equal($("#add-provider-manager-dialog").open, false);
  assert.ok(missing(`${dialogForm} [data-form-save-error]`));
  assert.equal(field("provider-manager-first-name"), "");
});

test("Escape cannot close the manager dialog while a save is running", async () => {
  const held = gate();
  await openProviderPage("/providers/v1", {
    setup: (api) =>
      api.on("POST", managers, {
        delay: held.promise,
        json: {
          manager: { membershipId: "m9", name: "Jordan", status: "active" },
        },
      }),
  });
  await fillNewManager();
  await click(`${dialogForm} button[type='submit']`);
  assert.equal($(dialogForm).dataset.saving, "true");
  assert.equal(escape("#add-provider-manager-dialog"), true);
  assert.equal($("#add-provider-manager-dialog").open, true);
  held.release();
  await settle();
  assert.equal(rows().length, 2);
});

test("an idle manager dialog may be dismissed", async () => {
  await openProviderPage("/providers/v1");
  await click("#add-provider-manager");
  assert.equal(escape("#add-provider-manager-dialog"), false);
  assert.equal($("#add-provider-manager-dialog").open, false);
});

test("a supervisor assigns an existing person as provider manager", async () => {
  const data = providerData();
  const { api } = await openProviderPage("/providers/v1", {
    data,
    setup: (api) =>
      api.on("POST", managers, (request) => {
        data.providerManagers.push({
          ...request.body,
          membershipId: "m9",
          providerId: "v1",
          status: "active",
        });
        return { json: { manager: { membershipId: "m9" } } };
      }),
  });
  const form = "[data-assign-existing-provider-person]";
  assert.equal($$(`${form} wa-option`).length, 1);
  await fill(`${form} wa-select[name='person-id']`, "u2");
  await click(`${form} button[type='submit']`);
  assert.equal(rows().length, 2);
  const body = api.calls("POST", managers)[0].body;
  assert.deepEqual([body.personId, body.email], ["u2", "blair@example.org"]);
});

test("assigning without a person asks the user to choose one", async () => {
  const { api } = await openProviderPage("/providers/v1");
  await submit("[data-assign-existing-provider-person]");
  assert.equal(
    $(
      "[data-assign-existing-provider-person] [data-form-save-error]",
    ).textContent.trim(),
    t("admin.relationships.choosePerson"),
  );
  assert.deepEqual(api.calls("POST", managers), []);
});

test("an assignment that finishes after leaving the provider does not redraw it", async () => {
  const held = gate();
  const { api } = await openProviderPage("/providers/v1", {
    setup: (api) => {
      // Stored, so the held reread lists a manager the old page must not draw.
      api.on("POST", managers, (request) => {
        const manager = {
          ...request.body,
          membershipId: "v1-pm3",
          providerId: "v1",
          status: "active",
        };
        api.data.providerManagers.push(manager);
        return { status: 201, json: { manager } };
      });
      api.on("GET", managers, async () => {
        if (api.calls("POST", managers).length) await held.promise;
        return undefined;
      });
      api.on("GET", /^providers\/v2\/(manager-memberships|grants)$/, {
        json: { managers: [], enrollments: [], grants: [] },
      });
    },
  });
  await fill(
    "[data-assign-existing-provider-person] wa-select[name='person-id']",
    "u2",
  );
  await click("[data-assign-existing-provider-person] button[type='submit']");
  assert.equal(api.calls("POST", managers).length, 1);
  await routeTo("/providers/v2");
  assert.equal($("#provider-title").textContent.trim(), "Second Provider");
  held.release();
  await settle();
  assert.equal($("#provider-title").textContent.trim(), "Second Provider");
  assert.equal(rows().length, 0);
});

test("a manager reread that finishes after leave() isn't drawn, even at the same address", async () => {
  const held = gate();
  const { api, page } = await openProviderPage("/providers/v1", {
    setup: (api) => {
      // Stored, so the held reread lists a manager the left page must not draw.
      api.on("POST", managers, (request) => {
        const manager = {
          ...request.body,
          membershipId: "v1-pm3",
          providerId: "v1",
          status: "active",
        };
        api.data.providerManagers.push(manager);
        return { status: 201, json: { manager } };
      });
      api.on("GET", managers, async () => {
        if (api.calls("POST", managers).length) await held.promise;
        return undefined;
      });
    },
  });
  const before = rows().length;
  await fill(
    "[data-assign-existing-provider-person] wa-select[name='person-id']",
    "u2",
  );
  await click("[data-assign-existing-provider-person] button[type='submit']");
  assert.equal(api.calls("POST", managers).length, 1);
  // <admin-app> calls leave() as the user goes; the page mustn't wait for the URL to change.
  page.leave();
  held.release();
  await settle();
  assert.equal(rows().length, before);
});

test("removing a manager deactivates the membership and revokes their devices", async () => {
  const data = providerData();
  const { api } = await openProviderPage("/providers/v1", {
    data,
    setup: (api) => {
      api.on("DELETE", /^providers\/v1\/manager-memberships\/m1$/, () => {
        data.providerManagers[0].status = "inactive";
        return { json: {} };
      });
      api.on("POST", /manager-enrollments\/e1\/revoke$/, () => {
        data.providerEnrollments[0].status = "revoked";
        return { json: {} };
      });
    },
  });
  await click("[data-provider-manager-status='m1']");
  assert.equal(rows().length, 0);
  assert.equal(api.calls("POST", /manager-enrollments\/e1\/revoke$/).length, 1);
  assert.deepEqual(
    api.calls("POST", /manager-enrollments\/e[23]\/revoke$/),
    [],
  );
  assert.ok(toastText().includes(t("admin.toast.accessUpdated")));
});

test("a failed manager removal shows the error", async () => {
  await openProviderPage("/providers/v1", {
    setup: (api) =>
      api.fail("DELETE", /manager-memberships\/m1$/, 500, "membership_locked"),
  });
  await click("[data-provider-manager-status='m1']");
  assert.equal(pageError(), t("admin.toast.requestFailed"));
});

test("the manager record saves edits and reinstates a former manager", async () => {
  const data = providerData();
  const { api } = await openProviderPage("/provider-managers/v1/m1", {
    data,
    setup: (api) =>
      api.on("PATCH", /manager-memberships\/m1$/, (request) => ({
        json: {
          manager: {
            ...request.body,
            membershipId: "m1",
            name: `${request.body.firstName} ${request.body.lastName}`,
            status: "active",
          },
        },
      })),
  });
  const save = () => $("#provider-manager-record-form [data-save-button]");
  assert.equal(save().disabled, true);
  await fillIn(
    "#provider-manager-record-form",
    "provider-manager-first-name",
    "Alexis",
  );
  assert.equal(save().disabled, false);
  await click(save());
  assert.equal(heading(), "Alexis Example");
  assert.deepEqual(api.calls("PATCH", /manager-memberships\/m1$/)[0].body, {
    firstName: "Alexis",
    lastName: "Example",
    email: "alex@example.org",
    phone: "4155550101",
    phoneExtension: "",
  });
  api.on("POST", /manager-memberships\/m2\/reinstate$/, () => {
    data.providerManagers[1].status = "active";
    return { json: {} };
  });
  await routeTo("/provider-managers/v1/m2");
  assert.ok(
    pageText().includes(t("admin.providerManagers.noAssignedProvider")),
  );
  assert.ok(missing("[data-transfer-provider-manager]"));
  await click("[data-provider-manager-status='m2']");
  assert.ok(!missing("[data-transfer-provider-manager]"));
  assert.equal(api.calls("POST", /m2\/reinstate$/).length, 1);
});

test("a manager record that was removed elsewhere says so", async () => {
  await openProviderPage("/provider-managers/v1/missing");
  assert.ok(
    $$("admin-provider-page [role='alert']").some(
      (alert) =>
        alert.textContent.trim() === t("admin.providerManagers.notFound"),
    ),
  );
});

test("a manager save that lands after switching providers is dropped", async () => {
  const held = gate();
  const { api } = await openProviderPage("/provider-managers/v1/m1", {
    setup: (api) =>
      api.on("PATCH", /manager-memberships\/m1$/, {
        delay: held.promise,
        json: { manager: { membershipId: "m1", name: "Late Name" } },
      }),
  });
  await fillIn(
    "#provider-manager-record-form",
    "provider-manager-first-name",
    "Late",
  );
  await click("#provider-manager-record-form [data-save-button]");
  assert.equal(api.calls("PATCH", /m1$/).length, 1);
  await routeTo("/providers/v2");
  assert.equal($("#provider-title").textContent.trim(), "Second Provider");
  held.release();
  await settle();
  assert.equal($("#provider-title").textContent.trim(), "Second Provider");
  assert.doesNotMatch(pageText(), /Late Name/);
});

test("transferring a manager needs their email, then opens the new record", async () => {
  const data = providerData();
  data.providers[1].status = "active";
  const { api } = await openProviderPage("/provider-managers/v1/m1", {
    data,
    setup: (api) =>
      api.on("POST", /manager-memberships\/m1\/transfer$/, () => {
        data.providerManagers = [
          { ...data.providerManagers[0], membershipId: "m5", providerId: "v2" },
        ];
        return { json: { manager: { providerId: "v2", membershipId: "m5" } } };
      }),
  });
  const form = "[data-transfer-provider-manager='m1']";
  await fill(`${form} wa-select[name='target-provider']`, "v2");
  await fillIn(form, "confirmation", "someone@example.org");
  await click(`${form} button[type='submit']`);
  assert.equal(
    $(`${form} [data-form-save-error]`).textContent.trim(),
    t("admin.relationships.confirmationMismatch"),
  );
  await fillIn(form, "confirmation", "ALEX@example.org ");
  await click(`${form} button[type='submit']`);
  assert.equal(url(), "/provider-managers/v2/m5");
  assert.equal(heading(), "Alex Example");
  assert.deepEqual(
    api.calls("POST", /transfer$/).map((call) => call.body),
    [{ providerId: "v2" }],
  );
});

test("removing one manager's access from their record needs their email", async () => {
  const data = providerData();
  const { api } = await openProviderPage("/provider-managers/v1/m1", {
    data,
    setup: (api) =>
      api.on("DELETE", /manager-memberships\/m1$/, () => {
        data.providerManagers[0].status = "inactive";
        return { json: {} };
      }),
  });
  const button = () =>
    $("[data-revoke-provider-devices] button[type='submit']");
  assert.equal(button().disabled, true);
  await fillIn(
    "[data-revoke-provider-devices]",
    "confirmation",
    "alex@example.org",
  );
  assert.equal(button().disabled, false);
  await click(button());
  assert.ok(
    pageText().includes(t("admin.providerManagers.noAssignedProvider")),
  );
  assert.equal(api.calls("DELETE", /m1$/).length, 1);
  assert.equal(api.calls("POST", /e1\/revoke$/).length, 1);
});

test("a confirmation edited away after enabling submit is not sent", async () => {
  const { api } = await openProviderPage("/provider-managers/v1/m1");
  const button = () =>
    $("[data-revoke-provider-devices] button[type='submit']");
  await fillIn(
    "[data-revoke-provider-devices]",
    "confirmation",
    "alex@example.org",
  );
  assert.equal(button().disabled, false);
  await fillIn(
    "[data-revoke-provider-devices]",
    "confirmation",
    "nobody@example.org",
  );
  assert.equal(button().disabled, true);
  await submit("[data-revoke-provider-devices]");
  assert.deepEqual(api.calls("DELETE", /m1$/), []);
});

test("the provider manager directory lists, searches and links managers", async () => {
  const data = providerData();
  data.providerManagers.push(
    {
      membershipId: "m3",
      providerId: "v1",
      personId: "u1",
      name: "Alex Example",
      status: "inactive",
    },
    {
      membershipId: "m4",
      providerId: "v1",
      name: "Only Name",
      status: "active",
    },
  );
  const { api } = await openManagerDirectory("/provider-managers", {
    data,
    setup: (api) =>
      api.on("GET", /^providers(\?|$)/, (request) => ({
        json: { ...api.reply(request).json, providers: data.providers },
      })),
  });
  const listed = () =>
    $$('[aria-labelledby="provider-manager-directory-title"] li');
  assert.equal(listed().length, 3);
  assert.ok(
    pageText().includes(t("admin.providerManagers.count.other", { count: 3 })),
  );
  assert.ok(listed().some((row) => row.textContent.includes("Only Name")));
  assert.ok(
    pageText().includes(
      t("admin.providerManagers.previousProvider", {
        name: "Example Provider",
      }),
    ),
  );
  assert.deepEqual(api.calls("GET", /providers\/v2\/manager-memberships/), []);
  await routeTo("/provider-managers?q=former");
  assert.equal(listed().length, 1);
  assert.ok(
    pageText().includes(t("admin.providerManagers.count.one", { count: 1 })),
  );
  await routeTo("/provider-managers?q=zzz");
  assert.ok(pageText().includes(t("admin.providerManagers.none")));
});

test("a compliance manager cannot open the provider manager list", async () => {
  await openManagerDirectory("/provider-managers", {
    role: "compliance-manager",
  });
  assert.equal(url(), "/sites");
});

test("a directory of one manager counts one, and a sparse reply adds none", async () => {
  const data = providerData();
  data.providerManagers = [data.providerManagers[0]];
  data.providers.push({
    providerId: "v3",
    name: "Third Provider",
    status: "active",
  });
  await openManagerDirectory("/provider-managers", {
    data,
    setup: (api) => {
      api.on("GET", /^providers\/v3\/manager-memberships$/, { json: {} });
      api.on("GET", /^providers\/v1\/manager-memberships$/, {
        json: { managers: data.providerManagers },
      });
    },
  });
  assert.ok(
    pageText().includes(t("admin.providerManagers.count.one", { count: 1 })),
  );
});

test("a provider read that finishes after leaving is not shown", async () => {
  const held = gate();
  // Opened on another provider first, since mountPage() waits for the first read.
  const { api } = await openProviderPage("/providers/v2", {
    setup: (api) =>
      api.on("GET", /^providers\/v1$/, async () => {
        await held.promise;
        return undefined;
      }),
  });
  await routeTo("/providers/v1");
  assert.equal(api.calls("GET", /^providers\/v1$/).length, 1);
  await routeTo("/providers/v2");
  assert.equal($("#provider-title").textContent.trim(), "Second Provider");
  held.release();
  await settle();
  assert.equal($("#provider-title").textContent.trim(), "Second Provider");
});

/**
 * Call after the redraws, since each render() replaces the dialog element.
 * @param {any} page
 */
function countManagerDialogOpens(page) {
  const opens = { count: 0 };
  page.querySelector("#add-provider-manager-dialog").showModal = () =>
    (opens.count += 1);
  return opens;
}

test("the add-manager button still opens its dialog after the page redraws", async () => {
  const { page } = await openProviderPage("/providers/v1");
  page.render();
  page.render();
  page.render();
  await click("#add-provider-manager");
  assert.equal($("#add-provider-manager-dialog").open, true);
});

test("after several redraws one click opens the add-manager dialog once", async () => {
  const { page } = await openProviderPage("/providers/v1");
  page.render();
  page.render();
  const opens = countManagerDialogOpens(page);
  await click("#add-provider-manager");
  assert.equal(opens.count, 1);
});

test("a removed Provider page no longer answers its controls", async () => {
  const { page } = await openProviderPage("/providers/v1");
  const opens = countManagerDialogOpens(page);
  const button = $("#add-provider-manager");
  page.remove();
  await click(button);
  assert.equal(opens.count, 0);
});

test("a Provider page left for another route draws nothing", async () => {
  const { page } = await openProviderPage("/providers/v1");
  await routeTo("/sites");
  page.render();
  assert.equal(page.innerHTML, "");
});
