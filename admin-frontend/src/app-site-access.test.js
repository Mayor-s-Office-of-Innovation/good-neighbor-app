import { test, vi } from "vitest";
import assert from "node:assert/strict";
import {
  $,
  alertText,
  $$,
  click,
  fill,
  focused,
  pageError,
  pageText,
  routeTo,
  settle,
  submit,
  tick,
  toastCount,
  toastText,
  window,
  missing,
} from "../test-support/admin-dom.js";
import { mountAdmin } from "../test-support/app-mount.js";
import { gate } from "../../e2e/admin-tests/admin-mock.js";
import {
  accessData,
  managerData,
} from "../../e2e/admin-tests/site-access-helpers.js";
import { t } from "../../frontend/src/i18n/i18n.js";

// pages/site/access.templates.js, access.actions.js and manager.actions.js have
// no catalog key for this copy, so tests match their English.

const ACCESS = "/sites/s1?section=access";

/**
 * @param {string} path
 * @param {Parameters<typeof mountAdmin>[1]} [options]
 */
const openSite = (path, options = {}) =>
  mountAdmin(path, { data: managerData(), ...options });

const access = () => $('section[aria-label="App access"]');
const accessStatus = () =>
  access().querySelector('[role="status"]')?.textContent.trim() || "";
const heading = () => $("admin-app h1").textContent.trim();
const historyRows = () => $$("details tbody tr");
const actions = () => $("[data-manager-membership-actions]");

const managerSearch = "#manager-membership-form [data-manager-search]";
/** @param {string} userId */
const managerOption = (userId) => `[data-manager-option="${userId}"]`;

/** Search by the person's first name, as a user would, then pick them. @param {string} userId */
async function chooseManager(userId) {
  const option = $(managerOption(userId));
  await fill(managerSearch, option.dataset.managerSearchText.split(" ")[0]);
  // The search waits 250 ms after the last keystroke.
  await tick(250);
  assert.equal(option.closest("li").hidden, false);
  await click(option);
}

const openNewManager = () => click("#create-site-manager");

async function fillNewManager() {
  for (const [name, value] of [
    ["new-manager-first-name", "Riley"],
    ["new-manager-last-name", "New"],
    ["new-manager-phone", "4155550109"],
    ["new-manager-email", "riley@example.org"],
  ])
    await fill(`#new-site-manager-form wa-input[name="${name}"]`, value);
}

test("assigning a person or Program staff adds a membership", async () => {
  const { api } = await openSite("/sites/s1");
  assert.equal(actions().hidden, true);
  // A current manager is not offered again.
  assert.ok(missing(managerOption("u3")));
  await fill(managerSearch, "nobody-matches");
  await tick(250);
  assert.equal(
    $("[data-manager-search-status]").textContent,
    t("admin.siteManagers.searchNone"),
  );
  await chooseManager("u2");
  assert.equal(actions().hidden, false);
  await click("[data-cancel-manager-assignment]");
  assert.equal(actions().hidden, true);
  assert.equal($(managerSearch).value, "");
  await chooseManager("u2");
  await click('[data-manager-membership-actions] button[type="submit"]');
  const bodies = () =>
    api
      .calls("POST", /^sites\/s1\/manager-memberships$/)
      .map((request) => request.body);
  // The backend refuses personId sent with program staff fields.
  assert.deepEqual(bodies()[0], {
    personId: "u2",
    email: "blair@example.org",
  });
  await chooseManager("u4");
  await click('[data-manager-membership-actions] button[type="submit"]');
  assert.deepEqual(bodies()[1], {
    name: "Jordan Staff",
    email: "jordan@example.org",
    programId: "p1",
    userId: "u4",
  });
});

test("a person without an email cannot be assigned", async () => {
  const data = managerData();
  data.people.push({
    personId: "u6",
    firstName: "Nomail",
    lastName: "Person",
    status: "active",
  });
  const { api } = await openSite("/sites/s1", { data });
  await chooseManager("u6");
  await click('[data-manager-membership-actions] button[type="submit"]');
  assert.ok(pageText().includes(t("admin.relationships.chooseManager")));
  assert.deepEqual(api.calls("POST", /manager-memberships$/), []);
});

test("creating a new manager from the Site saves the person and assigns them", async () => {
  const { api } = await openSite("/sites/s1");
  await openNewManager();
  assert.equal($("#new-site-manager-dialog").open, true);
  await fillNewManager();
  await click('#new-site-manager-dialog button[type="submit"]');
  assert.equal($("#new-site-manager-dialog").open, false);
  const person = api.calls("POST", /^people$/)[0].body;
  assert.deepEqual([person.firstName, person.siteId], ["Riley", "s1"]);
  const membership = api.calls("POST", /^sites\/s1\/manager-memberships$/)[0]
    .body;
  assert.deepEqual(
    [membership.personId, membership.name],
    ["person-4", "Riley New"],
  );
});

test("a manager created from a Site appears in the manager directory", async () => {
  await openSite("/managers");
  await routeTo("/sites/s1");
  await openNewManager();
  await fillNewManager();
  await click('#new-site-manager-dialog button[type="submit"]');
  await routeTo("/managers");
  assert.match(
    $('[aria-labelledby="managers-title"]').textContent,
    /Riley New/,
  );
});

test("a failed person create shows the staff error and keeps the dialog", async () => {
  await openSite("/sites/s1", {
    setup: (api) => api.fail("POST", /^people$/, 500, "unexpected"),
  });
  await openNewManager();
  await fillNewManager();
  await click('#new-site-manager-dialog button[type="submit"]');
  assert.equal(
    $("#new-site-manager-dialog [data-form-save-error]").textContent.trim(),
    t("admin.programs.staffSaveError"),
  );
  assert.equal(
    $('#new-site-manager-dialog button[type="submit"]').disabled,
    false,
  );
  await click("[data-cancel-new-site-manager]");
  assert.equal($("#new-site-manager-dialog").open, false);
});

test("a failed assignment after create retries without a second person", async () => {
  const { api } = await openSite("/sites/s1", {
    setup: (api) =>
      api.fail("POST", /^sites\/s1\/manager-memberships$/, 409, "conflict"),
  });
  await openNewManager();
  await fillNewManager();
  await click('#new-site-manager-dialog button[type="submit"]');
  assert.equal(
    $("#new-site-manager-dialog [data-form-save-error]").textContent.trim(),
    t("admin.siteManagers.assignmentError"),
  );
  api.on("POST", /^sites\/s1\/manager-memberships$/, {
    json: { membership: { membershipId: "m30" } },
  });
  await click('#new-site-manager-dialog button[type="submit"]');
  assert.equal($("#new-site-manager-dialog").open, false);
  assert.equal(api.calls("POST", /^people$/).length, 1);
  const assignments = api.calls("POST", /^sites\/s1\/manager-memberships$/);
  assert.equal(assignments.length, 2);
  assert.equal(assignments[1].body.personId, "person-4");
});

test("the new manager dialog cannot be dismissed while saving", async () => {
  const held = gate();
  const { api } = await openSite("/sites/s1", {
    setup: (api) =>
      api.on("POST", /^people$/, async () => {
        await held.promise;
        return undefined;
      }),
  });
  await openNewManager();
  await fillNewManager();
  await click('#new-site-manager-dialog button[type="submit"]');
  await submit("#new-site-manager-form");
  const cancel = new window.Event("cancel", { cancelable: true });
  $("#new-site-manager-dialog").dispatchEvent(cancel);
  assert.equal(cancel.defaultPrevented, true);
  assert.equal($("#new-site-manager-dialog").open, true);
  held.release();
  await settle();
  assert.equal($("#new-site-manager-dialog").open, false);
  assert.equal(api.calls("POST", /^people$/).length, 1);
});

test("a Site reload failure after creating a manager shows the error", async () => {
  const { api } = await openSite("/sites/s1");
  api.fail("GET", /^sites\/s1\?view=details$/, 404, "site_not_found");
  await openNewManager();
  await fillNewManager();
  await click('#new-site-manager-dialog button[type="submit"]');
  // Pins a bug: the raw API code shows instead of a message. No issue filed yet.
  assert.match(pageText(), /site_not_found/);
});

test("removing memberships asks first and handles person and legacy records", async () => {
  const data = managerData();
  data.siteItems.s1[1].activeBindingCount = 1;
  const { api } = await openSite("/sites/s1", {
    data,
    setup: (api) =>
      api.on("DELETE", /^sites\/s1\/manager-memberships\/m3$/, {
        json: { revokedBindingCount: 1 },
      }),
  });
  const dialog = () => $("#remove-manager-membership-dialog");
  await click('[data-remove-manager-membership="m3"]');
  assert.match(dialog().textContent, /1 active device at/);
  await click('#remove-manager-membership-dialog button[value="cancel"]');
  await click('[data-remove-manager-membership="m3"]');
  await click('#remove-manager-membership-dialog button[value="confirm"]');
  assert.equal(api.calls("DELETE", /manager-memberships\/m3$/).length, 1);
  await click('[data-remove-manager-membership="legacy:u1"]');
  assert.match(dialog().textContent, /0 active devices/);
  await click('#remove-manager-membership-dialog button[value="confirm"]');
  assert.equal(api.calls("DELETE", /^sites\/s1\/users\/u1$/).length, 1);
  assert.equal(api.calls("DELETE", /manager-memberships/).length, 1);
});

test("a failed membership removal shows the error", async () => {
  await openSite("/sites/s1", {
    setup: (api) =>
      api.fail(
        "DELETE",
        /manager-memberships\/m3$/,
        404,
        "manager_membership_not_found",
      ),
  });
  await click('[data-remove-manager-membership="m3"]');
  await click('#remove-manager-membership-dialog button[value="confirm"]');
  // Pins a bug: the raw API code shows instead of a message. No issue filed yet.
  assert.match(pageText(), /manager_membership_not_found/);
});

test("a compliance manager without edit rights sees no assignment controls", async () => {
  await openSite("/sites/s1", { role: "compliance-manager" });
  assert.ok(!missing("#site-managers-title"));
  assert.ok(missing("#manager-membership-form"));
  assert.ok(missing("[data-remove-manager-membership]"));
});

test("the access tab lists devices and enrollment history", async () => {
  await openSite(ACCESS, { data: accessData() });
  const devices = [...access().querySelectorAll("[data-revoke-device]")].map(
    (button) => button.parentElement.textContent,
  );
  assert.equal(devices.length, 3);
  assert.match(devices[0], /morgan@example\.org/);
  assert.ok(
    devices[1].includes(
      t("admin.devices.enrolledBy", { email: "alex@example.org" }),
    ),
  );
  assert.match(devices[1], /device-0…cdef/);
  assert.ok(devices[2].includes(t("admin.devices.emailUnavailable")));
  const rows = historyRows();
  assert.equal(rows.length, 3);
  assert.ok(rows[0].textContent.includes(t("admin.enrollment.oneTimeCode")));
  assert.match(rows[1].textContent, /pending/);
  assert.match(rows[2].textContent, /Not applicable/);
  assert.ok(rows[0].querySelector("[data-cancel-manager-grant]"));
  assert.equal(
    access().querySelectorAll("[data-issue-manager-grant]").length,
    4,
  );
});

test("an empty Site says so", async () => {
  const data = managerData();
  data.siteItems.s1 = [];
  await openSite(ACCESS, { data });
  const text = access().textContent;
  assert.match(text, /No devices in use\./);
  assert.ok(text.includes(t("admin.siteManagers.none")));
  assert.match(text, /No enrollment links issued\./);
});

test("history without a one-time link has no link column", async () => {
  const data = accessData();
  data.grants = data.grants.slice(1);
  await openSite(ACCESS, { data });
  assert.equal(historyRows().length, 2);
  assert.ok(
    !$$("details th").some(
      (header) => header.textContent.trim() === t("admin.enrollment.link"),
    ),
  );
  assert.ok(missing("[data-copy-enrollment-url]"));
});

test("emailing an enrollment link or code reports delivery", async () => {
  const { api } = await openSite(ACCESS, {
    data: accessData(),
    setup: (api) =>
      api.on("POST", /^sites\/s1\/manager-grants$/, (request) => ({
        json: {
          grant: {
            grantId: "g1",
            deliveryStatus:
              request.body.deliveryMode === "code" ? "accepted" : "failed",
          },
          enrollmentUrl: `https://example.org/enroll/${request.body.deliveryMode}`,
        },
      })),
  });
  await click('[data-issue-manager-grant="m3"][data-delivery-mode="code"]');
  assert.ok(toastText().includes(t("admin.enrollment.codeEmailed")));
  assert.ok(
    !missing('[data-copy-enrollment-url="https://example.org/enroll/code"]'),
  );
  await click('[data-issue-manager-grant="m3"][data-delivery-mode="link"]');
  assert.ok(toastText().includes(t("admin.toast.enrollmentEmailFailed")));
  assert.ok(
    !missing('[data-copy-enrollment-url="https://example.org/enroll/link"]'),
  );
  assert.deepEqual(
    api.calls("POST", /manager-grants$/).map((request) => request.body),
    [
      { membershipId: "m3", deliveryMode: "code" },
      { membershipId: "m3", deliveryMode: "link" },
    ],
  );
});

test("a legacy assignment becomes a membership before its link is sent", async () => {
  const { api } = await openSite(ACCESS, {
    data: accessData(),
    setup: (api) => {
      api.on("POST", /^sites\/s1\/manager-memberships$/, {
        json: {
          membership: {
            membershipId: "m40",
            name: "Alex Example",
            email: "alex@example.org",
            status: "active",
          },
        },
      });
      api.on("POST", /^sites\/s1\/manager-grants$/, {
        json: { grant: { grantId: "g9", deliveryStatus: "accepted" } },
      });
    },
  });
  await click(
    '[data-issue-manager-grant="legacy:u1"][data-delivery-mode="link"]',
  );
  assert.ok(toastText().includes(t("admin.enrollment.emailed")));
  assert.equal(
    api.calls("POST", /manager-grants$/)[0].body.membershipId,
    "m40",
  );
  const { email, programId, userId } = api.calls(
    "POST",
    /^sites\/s1\/manager-memberships$/,
  )[0].body;
  assert.deepEqual(
    { email, programId, userId },
    { email: "alex@example.org", programId: "p1", userId: "u1" },
  );
});

test("a legacy assignment whose link fails keeps its new membership for the retry", async () => {
  let grants = 0;
  const { api } = await openSite(ACCESS, {
    data: accessData(),
    setup: (api) => {
      api.on("POST", /^sites\/s1\/manager-memberships$/, {
        json: {
          membership: {
            membershipId: "m40",
            name: "Alex Example",
            email: "alex@example.org",
            status: "active",
          },
        },
      });
      api.on("POST", /^sites\/s1\/manager-grants$/, () =>
        ++grants === 1
          ? { status: 409, json: { error: "manager_grant_conflict" } }
          : { json: { grant: { grantId: "g9", deliveryStatus: "accepted" } } },
      );
    },
  });
  await click(
    '[data-issue-manager-grant="legacy:u1"][data-delivery-mode="link"]',
  );
  assert.ok(alertText().includes(t("admin.toast.partial")));
  await click('[data-issue-manager-grant="m40"][data-delivery-mode="link"]');
  assert.equal(api.calls("POST", /manager-memberships$/).length, 1);
  assert.equal(
    api.calls("POST", /manager-grants$/)[1].body.membershipId,
    "m40",
  );
});

test("an emailed link shows one toast before the access lists reload", async () => {
  const held = gate();
  await openSite(ACCESS, {
    data: accessData(),
    setup: (api) => {
      api.on("POST", /^sites\/s1\/manager-grants$/, {
        json: { grant: { grantId: "g9", deliveryStatus: "accepted" } },
      });
      // The first read opens the tab; the second is the reload after the send.
      let reads = 0;
      api.on("GET", /^sites\/s1\/devices$/, async () => {
        if (++reads > 1) await held.promise;
        return undefined;
      });
    },
  });
  await click('[data-issue-manager-grant="m3"][data-delivery-mode="link"]');
  try {
    assert.equal(toastCount(t("admin.enrollment.emailed")), 1);
  } finally {
    // A held read would be shared by the next test's identical read.
    held.release();
  }
  await settle();
  assert.equal(toastCount(t("admin.enrollment.emailed")), 1);
});

test("each enrollment error shows one generic notice and keeps the access tab usable", async () => {
  const { api } = await openSite(ACCESS, { data: accessData() });
  const link = '[data-issue-manager-grant="m3"][data-delivery-mode="link"]';
  const failed = t("admin.toast.requestFailed");
  const notices = () =>
    $$("[data-operation-error]").filter(
      (notice) => notice.textContent.trim() === failed,
    ).length;
  const codes = [
    ["provider_manager_grant_already_active", "admin.enrollment.alreadyActive"],
    ["manager_grant_conflict", "admin.enrollment.conflict"],
    ["unexpected", ""],
  ];
  for (const [index, [code, key]] of codes.entries()) {
    api.fail("POST", /manager-grants$/, 409, code);
    const before = notices();
    await click(link);
    assert.equal(notices(), before + 1, code);
    // Pins a bug: issueManagerGrant in pages/site/manager.actions.js maps these
    // codes to their own message, but adminErrorMessage ignores it for an HTTP
    // error. No issue filed yet.
    if (key) assert.ok(!pageText().includes(t(key)), code);
    assert.equal(api.calls("POST", /manager-grants$/).length, index + 1);
    assert.equal($(link).disabled, false);
  }
});

test("a failed enrollment clears a stale page banner instead of repeating its toast there", async () => {
  const { api } = await openSite(ACCESS, {
    data: accessData(),
    setup: (api) =>
      api.fail(
        "DELETE",
        /^sites\/s1\/grants\/g1$/,
        404,
        "manager_grant_not_found",
      ),
  });
  await click('[data-cancel-manager-grant="g1"]');
  // Pins a bug: the raw API code shows instead of a message. No issue filed yet.
  assert.equal(pageError(), "manager_grant_not_found");
  api.fail("POST", /manager-grants$/, 409, "manager_grant_conflict");
  await click('[data-issue-manager-grant="m3"][data-delivery-mode="link"]');
  assert.ok(alertText().includes(t("admin.toast.requestFailed")));
  assert.equal(pageError(), "");
});

test("a page error clears when a link is sent, and a late refresh is dropped", async () => {
  const data = accessData();
  data.grants.push({
    siteId: "s3",
    grantId: "g5",
    issuedTo: "morgan@example.org",
    status: "pending",
  });
  const { api } = await openSite(ACCESS, {
    data,
    setup: (api) =>
      api.fail(
        "DELETE",
        /^sites\/s1\/grants\/g1$/,
        404,
        "manager_grant_not_found",
      ),
  });
  await click('[data-cancel-manager-grant="g1"]');
  // Pins a bug: the raw API code shows instead of a message. No issue filed yet.
  assert.match(pageText(), /manager_grant_not_found/);
  const held = gate();
  api.on("POST", /manager-grants$/, {
    json: { grant: { grantId: "g9", deliveryStatus: "accepted" } },
  });
  api.on("GET", /^sites\/s1\/grants$/, async () => {
    await held.promise;
    return { json: { grants: [] } };
  });
  await click('[data-issue-manager-grant="m3"][data-delivery-mode="link"]');
  assert.doesNotMatch(pageText(), /manager_grant_not_found/);
  await routeTo("/sites/s3?section=access");
  assert.equal(heading(), "North Site");
  assert.ok(!missing('[data-cancel-manager-grant="g5"]'));
  held.release();
  await settle();
  assert.ok(!missing('[data-cancel-manager-grant="g5"]'));
  assert.ok(missing('[data-cancel-manager-grant="g1"]'));
  assert.equal(heading(), "North Site");
});

test("cancelling a pending link refreshes the history", async () => {
  const { api } = await openSite(ACCESS, {
    data: accessData(),
    setup: (api) =>
      api.on("DELETE", /^sites\/s1\/grants\/g1$/, () => {
        const grant = api.data.grants.find(
          (/** @type {any} */ item) => item.grantId === "g1",
        );
        grant.status = "cancelled";
        return { json: { cancelled: true, grantId: "g1" } };
      }),
  });
  await click('[data-cancel-manager-grant="g1"]');
  assert.equal(api.calls("GET", /^sites\/s1\/grants$/).length, 2);
  assert.equal(api.calls("DELETE", /^sites\/s1\/grants\/g1$/).length, 1);
  const g1 = historyRows().find((row) =>
    row.textContent.includes("morgan@example.org"),
  );
  assert.equal(g1?.cells[4].textContent, "cancelled");
});

test("copying an enrollment link reports success", async () => {
  /** @type {string[]} */
  const copied = [];
  vi.spyOn(window.navigator.clipboard, "writeText").mockImplementation(
    async (text) => {
      copied.push(text);
    },
  );
  await openSite(ACCESS, { data: accessData() });
  await click("[data-copy-enrollment-url]");
  assert.equal(
    $("[data-copy-enrollment-url]").getAttribute("aria-label"),
    "Enrollment link copied",
  );
  assert.equal(
    $("[data-copy-status]").textContent.trim(),
    "Enrollment link copied.",
  );
  assert.deepEqual(copied, ["https://example.org/enroll/g1"]);
});

test("a failed copy says so", async () => {
  vi.spyOn(window.navigator.clipboard, "writeText").mockImplementation(
    async () => {
      throw new Error("denied");
    },
  );
  await openSite(ACCESS, { data: accessData() });
  await click("[data-copy-enrollment-url]");
  assert.equal(
    $("[data-copy-enrollment-url]").getAttribute("aria-label"),
    "Copy enrollment link failed",
  );
  assert.equal(
    $("[data-copy-status]").textContent.trim(),
    "The enrollment link could not be copied.",
  );
  assert.equal($("[data-copy-enrollment-url]").disabled, false);
});

const REVOCATION = 'dialog[aria-labelledby="device-revocation-title"]';
const revocation = () => $(REVOCATION);

/** Open the removal dialog the way a click does, focus first. @param {string} id */
async function askToRemove(id) {
  $(`[data-revoke-device="${id}"]`).focus();
  await click(`[data-revoke-device="${id}"]`);
  assert.equal(revocation().open, true);
}

test("removing one device asks in a dialog and reports the result", async () => {
  const { api } = await openSite(ACCESS, { data: accessData() });
  await askToRemove("b1");
  assert.ok(
    revocation().textContent.includes(
      t("admin.devices.revokeDescription", {
        name: "Front desk phone",
        site: "Example Site",
      }),
    ),
  );
  assert.ok(revocation().textContent.includes(t("admin.devices.revokeTitle")));
  // A click focuses the button first, as a browser does.
  $(`${REVOCATION} button[value="cancel"]`).focus();
  await click(`${REVOCATION} button[value="cancel"]`);
  assert.ok(missing(REVOCATION));
  // Pins a bug: focus can't return to the remove button, which stays disabled
  // until the dialog's answer is handled. No issue filed yet.
  assert.ok(!focused('[data-revoke-device="b1"]'));
  assert.deepEqual(api.calls("DELETE", /devices\//), []);
  await askToRemove("b3");
  const unnamed = t("admin.devices.unnamedDevice");
  assert.ok(revocation().textContent.includes(unnamed));
  await click(`${REVOCATION} button[value="confirm"]`);
  assert.ok(missing(REVOCATION));
  assert.equal(
    accessStatus(),
    t("admin.devices.revokedMessage", { name: unnamed }),
  );
  assert.equal(api.calls("DELETE", /^sites\/s1\/devices\/b3$/).length, 1);
});

test("closing the removal dialog with Escape removes nothing", async () => {
  const { api } = await openSite(ACCESS, { data: accessData() });
  await askToRemove("b1");
  // happy-dom has no Escape handling; a browser closes the dialog with no value.
  revocation().close();
  await settle();
  assert.ok(missing(REVOCATION));
  assert.deepEqual(api.calls("DELETE", /devices\//), []);
});

test("a failed device removal shows the error", async () => {
  await openSite(ACCESS, {
    data: accessData(),
    setup: (api) =>
      api.fail(
        "DELETE",
        /^sites\/s1\/devices\/b1$/,
        409,
        "device_revocation_conflict",
      ),
  });
  await askToRemove("b1");
  await click(`${REVOCATION} button[value="confirm"]`);
  // Pins a bug: the raw API code shows instead of a message. No issue filed yet.
  assert.match(pageText(), /device_revocation_conflict/);
});

test("leaving the page with the removal dialog open closes it and sends nothing", async () => {
  const { api } = await openSite(ACCESS, { data: accessData() });
  await askToRemove("b1");
  await routeTo("/sites/s3?section=access");
  assert.equal(heading(), "North Site");
  assert.ok(missing(REVOCATION));
  assert.deepEqual(api.calls("DELETE", /devices\//), []);
});

test("a navigation in the same moment as Remove sends nothing", async () => {
  const { api } = await openSite(ACCESS, { data: accessData() });
  await askToRemove("b1");
  // The answer arrives after this close event, so the page has already changed.
  revocation().addEventListener("close", () => {
    window.history.pushState({}, "", "/sites/s3?section=access");
    window.dispatchEvent(new window.PopStateEvent("popstate"));
  });
  await click(`${REVOCATION} button[value="confirm"]`);
  assert.equal(heading(), "North Site");
  assert.deepEqual(api.calls("DELETE", /devices\//), []);
});

test("closing the app with the removal dialog open closes it and sends nothing", async () => {
  const { app, api } = await openSite(ACCESS, { data: accessData() });
  await askToRemove("b1");
  app.remove();
  await settle();
  assert.ok(missing(REVOCATION));
  assert.deepEqual(api.calls("DELETE", /devices\//), []);
});

test("a device removal that finishes after navigation leaves the new page", async () => {
  const held = gate();
  await openSite(ACCESS, {
    data: accessData(),
    setup: (api) =>
      api.on("DELETE", /^sites\/s1\/devices\/b1$/, async () => {
        await held.promise;
        return { json: {} };
      }),
  });
  await askToRemove("b1");
  await click(`${REVOCATION} button[value="confirm"]`);
  await routeTo("/sites/s3?section=access");
  assert.equal(heading(), "North Site");
  held.release();
  await settle();
  assert.equal(heading(), "North Site");
  assert.equal(accessStatus(), "");
});

test("revoking every device needs the Site name and reports each outcome", async () => {
  let call = 0;
  const { api } = await openSite(ACCESS, {
    data: accessData(),
    setup: (api) =>
      api.on("POST", /^sites\/s1\/device-bindings:revoke-all$/, () => {
        call += 1;
        return {
          json: [
            { status: "complete", operationId: "op1", affectedCount: 1 },
            { status: "complete", operationId: "op2", affectedCount: 3 },
            { status: "partial", operationId: "op3", failedCount: 1 },
            { status: "partial", operationId: "op4", failedCount: 2 },
          ][call - 1],
        };
      }),
  });
  assert.equal($("#revoke-all-site-devices button").disabled, true);
  await submit("#revoke-all-site-devices");
  assert.equal(call, 0);
  await fill("#revoke-all-site-devices wa-input", "example site");
  assert.equal($("#revoke-all-site-devices button").disabled, true);
  await submit("#revoke-all-site-devices");
  assert.equal(call, 0);
  for (const text of [
    "Operation op1: all Site credentials invalidated and 1 device record reconciled.",
    "Operation op2: all Site credentials invalidated and 3 device records reconciled.",
    "Operation op3: canonical Site credentials were invalidated, but 1 device record could not be reconciled. Follow the revocation runbook.",
    "Operation op4: canonical Site credentials were invalidated, but 2 device records could not be reconciled. Follow the revocation runbook.",
  ]) {
    await fill("#revoke-all-site-devices wa-input", "Example Site");
    await click("#revoke-all-site-devices button");
    assert.equal(accessStatus(), text);
  }
  assert.deepEqual(api.calls("POST", /revoke-all$/)[0].body, {
    confirmation: "Example Site",
  });
});

test("a failed revoke-all shows the error and lets the user try again", async () => {
  await openSite(ACCESS, {
    data: accessData(),
    setup: (api) =>
      api.fail("POST", /revoke-all$/, 409, "site_revocation_conflict"),
  });
  await fill("#revoke-all-site-devices wa-input", "Example Site");
  await click("#revoke-all-site-devices button");
  // Pins a bug: the raw API code shows instead of a message. No issue filed yet.
  assert.match(pageText(), /site_revocation_conflict/);
  assert.equal($("#revoke-all-site-devices wa-input").disabled, false);
  await fill("#revoke-all-site-devices wa-input", "Example Site");
  assert.equal($("#revoke-all-site-devices button").disabled, false);
});

test("a second revoke-all submit while one is pending sends nothing", async () => {
  const held = gate();
  const { api } = await openSite(ACCESS, {
    data: accessData(),
    setup: (api) =>
      api.on("POST", /revoke-all$/, async () => {
        await held.promise;
        return {
          json: { status: "complete", operationId: "op6", affectedCount: 0 },
        };
      }),
  });
  await fill("#revoke-all-site-devices wa-input", "Example Site");
  await click("#revoke-all-site-devices button");
  assert.equal($("#revoke-all-site-devices button").disabled, true);
  await submit("#revoke-all-site-devices");
  held.release();
  await settle();
  assert.equal(api.calls("POST", /revoke-all$/).length, 1);
});

test("a revoke-all that finishes after navigation reports its outcome on the next Site's panel (bug)", async () => {
  const held = gate();
  const { api } = await openSite(ACCESS, {
    data: accessData(),
    setup: (api) =>
      api.on("POST", /revoke-all$/, async () => {
        await held.promise;
        return {
          json: { status: "complete", operationId: "op5", affectedCount: 0 },
        };
      }),
  });
  await fill("#revoke-all-site-devices wa-input", "Example Site");
  await click("#revoke-all-site-devices button");
  await routeTo("/sites/s3?section=access");
  assert.equal(heading(), "North Site");
  held.release();
  await settle();
  // Pins a bug: s1's outcome shows on s3's access panel. No issue filed yet.
  assert.match(accessStatus(), /op5/);
  assert.equal(api.calls("GET", /^sites\/s1\/devices$/).length, 1);
});

test("a compliance manager without edit rights cannot change access", async () => {
  const { api } = await openSite(ACCESS, {
    role: "compliance-manager",
    data: accessData(),
  });
  const controls = $$(
    "[data-issue-manager-grant], [data-show-enrollment-code], [data-revoke-device], [data-cancel-manager-grant]",
  );
  assert.equal(controls.length, 10);
  assert.ok(controls.every((control) => control.disabled));
  // With the Site's name typed, only the permission keeps revoke-all shut.
  await fill("#revoke-all-site-devices wa-input", "Example Site");
  assert.equal($("#revoke-all-site-devices button").disabled, true);
  await submit("#revoke-all-site-devices");
  assert.equal(api.calls("POST", /revoke-all$/).length, 0);
});

/** @param {any} request @param {string} grantId */
const screenGrant = (request, grantId) => ({
  status: 201,
  json: {
    grant: {
      grantId,
      membershipId: request.body.membershipId,
      issuedTo: "blair@example.org",
      status: "pending",
      deliveryMode: "code",
      deliveryChannel: "screen",
      deliveryStatus: "issued",
      createdAt: "2026-10-20T10:00:00Z",
      expiresAt: "2099-01-01T00:00:00Z",
    },
    enrollmentCode: "246810",
  },
});

test("showing a one-time code puts it on screen until the page is left", async () => {
  let issued = 0;
  const { api } = await openSite(ACCESS, {
    data: accessData(),
    setup: (api) =>
      api.on("POST", /^sites\/s1\/manager-grants$/, (request) =>
        screenGrant(request, `g-screen-${++issued}`),
      ),
  });
  await click('[data-show-enrollment-code="m3"]');
  assert.match($('[data-enrollment-code="g-screen-1"]').textContent, /246810/);
  assert.ok(focused('[data-enrollment-code="g-screen-1"]'));
  assert.deepEqual(api.calls("POST", /manager-grants$/)[0].body, {
    membershipId: "m3",
    deliveryMode: "code",
    deliveryChannel: "screen",
  });
  assert.ok(access().textContent.includes(t("admin.enrollment.screenIssued")));
  // A second code for the same person replaces the first on screen.
  await click('[data-show-enrollment-code="m3"]');
  assert.ok(missing('[data-enrollment-code="g-screen-1"]'));
  assert.ok(!missing('[data-enrollment-code="g-screen-2"]'));
  window.dispatchEvent(new window.Event("pagehide"));
  assert.ok(missing("[data-enrollment-code]"));
});

test("a failed one-time code request says so", async () => {
  await openSite(ACCESS, {
    data: accessData(),
    setup: (api) => api.fail("POST", /^sites\/s1\/manager-grants$/, 500),
  });
  await click('[data-show-enrollment-code="m3"]');
  assert.ok(toastText().includes(t("admin.enrollment.screenFailed")));
  assert.ok(missing("[data-enrollment-code]"));
});

for (const [delivery, key] of [
  ["accepted", "admin.enrollment.emailed"],
  ["failed", "admin.enrollment.createdEmailFailed"],
])
  test(`a new manager emailed a link on creation reports ${delivery} delivery`, async () => {
    const { api } = await openSite("/sites/s1", {
      setup: (api) =>
        api.on("POST", /^sites\/s1\/manager-grants$/, (request) => ({
          status: 201,
          json: {
            grant: {
              grantId: "g-new",
              membershipId: request.body.membershipId,
              deliveryStatus: delivery,
            },
          },
        })),
    });
    await openNewManager();
    await fillNewManager();
    await fill('#new-site-manager-form [name="email-enrollment-link"]', true);
    await click('#new-site-manager-dialog button[type="submit"]');
    const membership = api.calls("POST", /^sites\/s1\/manager-memberships$/);
    assert.equal(membership.length, 1);
    const [grant] = api.calls("POST", /^sites\/s1\/manager-grants$/);
    assert.equal(grant.body.deliveryMode, "link");
    assert.ok(toastText().includes(t(key)));
  });

test("a code returned after leaving the Site is discarded", async () => {
  const held = gate();
  await openSite(ACCESS, {
    data: accessData(),
    setup: (api) =>
      api.on("POST", /^sites\/s1\/manager-grants$/, async (request) => {
        await held.promise;
        return screenGrant(request, "g-late");
      }),
  });
  await click('[data-show-enrollment-code="m3"]');
  await routeTo("/sites/s2?section=access");
  held.release();
  await settle();
  // The late grant belongs to s1, so it must not join s2's history.
  assert.ok(!access().textContent.includes(t("admin.enrollment.screenIssued")));
  assert.ok(missing("[data-enrollment-code]"));
});
