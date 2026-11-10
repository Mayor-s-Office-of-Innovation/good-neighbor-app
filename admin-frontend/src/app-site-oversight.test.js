import { test } from "vitest";
import assert from "node:assert/strict";
import {
  $,
  $$,
  adminData,
  click,
  fill,
  mountAdmin,
  pageText,
  submit,
  unhandledRejection,
  missing,
} from "../test-support/admin-dom.js";
import { t } from "../../frontend/src/i18n/i18n.js";

// main.js has no catalog key for this copy, so tests match its English.
const saveError = (form) => $(`${form} [data-form-save-error]`).textContent;

const OVERSIGHT = "/sites/s1?section=oversight";
const COMPLIANCE = "/sites/s1?section=compliance";

/** Site with one assigned City program manager and a custom system of care. */
function oversightData() {
  const data = adminData();
  data.sites[0] = {
    ...data.sites[0],
    oversight: {
      managingCityDepartment: "Example Department",
      managingSystemOfCare: "Custom System",
    },
  };
  data.programManagers = /** @type {any} */ ([
    {
      ...data.programManagers[0],
      name: "Casey Manager",
      departmentName: "Example Department",
      accountStatus: "active",
    },
    {
      userId: "pm2",
      firstName: "Drew",
      lastName: "Lead",
      name: "Drew Lead",
      email: "drew@example.org",
      accountStatus: "invited",
      status: "active",
    },
  ]);
  data.siteItems.s1.push({
    sk: "COMPLIANCE_MANAGER#pm1",
    type: "siteComplianceManagerAssignment",
    managerId: "pm1",
    status: "active",
  });
  return data;
}

const save = () => $("#site-oversight-form [data-save-button]");

test("oversight save sends the department and system of care", async () => {
  const { api } = await mountAdmin(OVERSIGHT, { data: oversightData() });
  assert.equal(save().disabled, true);
  assert.ok(!missing('#site-oversight-form wa-option[value="Custom System"]'));
  await fill('wa-select[name="managing-system-of-care"]', "BHS-PBH");
  assert.equal(save().disabled, false);
  await click(save());
  assert.equal(save().disabled, true);
  assert.deepEqual(api.calls("PATCH", /^sites\/s1$/)[0].body, {
    name: "Example Site",
    oversight: {
      managingCityDepartment: "Example Department",
      managingSystemOfCare: "BHS-PBH",
    },
  });
  assert.deepEqual(api.calls("PUT", /compliance-managers$/), []);
});

test("changed program managers are saved with the oversight", async () => {
  const { api } = await mountAdmin(OVERSIGHT, {
    data: oversightData(),
    setup: (api) =>
      api.on("PUT", /^sites\/s1\/compliance-managers$/, (request) => ({
        json: {
          assignments: request.body.managerIds.map(
            (/** @type {string} */ id) => ({
              siteId: "s1",
              managerId: id,
              manager: api.data.programManagers.find(
                (/** @type {any} */ item) => item.userId === id,
              ),
            }),
          ),
        },
      })),
  });
  await click("#site-oversight-form [data-remove-compliance-manager]");
  assert.equal($$("#site-oversight-form li[data-manager-id]").length, 0);
  await click("#add-compliance-manager");
  await fill("#compliance-manager-search", "drew");
  await click('#choose-compliance-manager-dialog [data-manager-id="pm2"]');
  assert.equal($("#choose-compliance-manager-dialog").open, false);
  await click(save());
  assert.deepEqual(api.calls("PUT", /compliance-managers$/)[0].body, {
    managerIds: ["pm2"],
  });
  assert.deepEqual(
    $$("#site-oversight-form li[data-manager-id]").map(
      (item) => item.dataset.managerId,
    ),
    ["pm2"],
  );
});

test("oversight errors stay on the form", async () => {
  await mountAdmin(OVERSIGHT, {
    data: oversightData(),
    setup: (api) => api.fail("PATCH", /^sites\/s1$/, 400, "invalid_oversight"),
  });
  await fill('wa-select[name="managing-system-of-care"]', "BHS-PBH");
  await click(save());
  assert.equal(
    saveError("#site-oversight-form"),
    "Check the City program manager, department, and system of care.",
  );
});

test("more than two program managers are refused before saving", async () => {
  const { api } = await mountAdmin(OVERSIGHT, { data: oversightData() });
  const form = $("#site-oversight-form");
  for (const id of ["pm2", "pm3"]) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = "compliance-manager-id";
    input.value = id;
    form.append(input);
  }
  form.dispatchEvent(new Event("input"));
  await click(save());
  assert.equal(
    saveError("#site-oversight-form"),
    "A site can have no more than two Program managers.",
  );
  assert.deepEqual(api.calls("PATCH", /^sites\/s1$/), []);
});

for (const [select, value, type] of [
  ["managing-city-department", "__add_department__", "department"],
  ["managing-system-of-care", "__add_system__", "systemOfCare"],
])
  test(`adding a new ${type} selects it on the oversight form`, async () => {
    const { api } = await mountAdmin(OVERSIGHT, {
      data: oversightData(),
      setup: (api) =>
        api.on("POST", /^oversight-options$/, (request) => ({
          status: 201,
          json: {
            option: {
              type: request.body.type,
              name: request.body.name,
              ...(request.body.type === "department"
                ? { departmentId: "d9" }
                : {}),
            },
          },
        })),
    });
    await fill(`wa-select[name="${select}"]`, value);
    assert.equal($("#new-oversight-option-dialog").open, true);
    assert.equal(
      $("#new-oversight-option-dialog [name='option-type']").value,
      type,
    );
    await fill('wa-input[name="option-name"]', "Added Option");
    await click("#new-oversight-option-dialog [data-save-button]");
    assert.equal($("#new-oversight-option-dialog").open, false);
    assert.equal($(`wa-select[name="${select}"]`).value, "Added Option");
    assert.deepEqual(api.calls("POST", /^oversight-options$/)[0].body, {
      type,
      name: "Added Option",
    });
    assert.equal(save().disabled, false);
  });

test("a failed new option keeps its dialog open, without an inline error", async () => {
  const { api } = await mountAdmin(OVERSIGHT, {
    data: oversightData(),
    setup: (api) =>
      api.fail("POST", /^oversight-options$/, 409, "oversight_option_exists"),
  });
  await fill(
    'wa-select[name="managing-city-department"]',
    "__add_department__",
  );
  await fill('wa-input[name="option-name"]', "Added Option");
  const failure = await unhandledRejection(() =>
    click("#new-oversight-option-dialog [data-save-button]"),
  );
  // Pins a bug: the catch reads event.currentTarget after an await, so it's
  // null and the inline error never shows. No issue filed yet.
  assert.equal(failure?.message, "Expected form event target");
  assert.ok(missing("#new-oversight-option-dialog [data-form-save-error]"));
  assert.equal(api.calls("POST", /^oversight-options$/).length, 1);
  assert.equal($("#new-oversight-option-dialog").open, true);
  await click("#new-oversight-option-dialog [data-close-dialog]");
  assert.equal($("#new-oversight-option-dialog").open, false);
  assert.equal(
    $('wa-select[name="managing-city-department"]').value,
    "Example Department",
  );
});

for (const [label, option, expected] of [
  ["its directory ID", { type: "department", departmentId: "d9" }, "d9"],
  ["its name without a directory ID", {}, "Invited Department"],
])
  test(`a department added while inviting a manager is selected by ${label}`, async () => {
    await mountAdmin(OVERSIGHT, {
      data: oversightData(),
      setup: (api) =>
        api.on("POST", /^oversight-options$/, (request) => ({
          status: 201,
          json: { option: { ...option, name: request.body.name } },
        })),
    });
    await click("#add-compliance-manager");
    await click("#invite-new-compliance-manager");
    assert.equal($("#new-city-program-manager-dialog").open, true);
    await fill('wa-select[name="manager-department"]', "__add_department__");
    assert.equal($("#new-oversight-option-dialog").open, true);
    await fill('wa-input[name="option-name"]', "Invited Department");
    await click("#new-oversight-option-dialog [data-save-button]");
    assert.equal($("#new-oversight-option-dialog").open, false);
    assert.equal(
      $('#new-city-program-manager-dialog wa-select[name="manager-department"]')
        .value,
      expected,
    );
  });

test("a read-only oversight record cannot be saved", async () => {
  const data = oversightData();
  // A compliance manager not assigned to this Site.
  data.profile.directoryUserId = "pm2";
  await mountAdmin(OVERSIGHT, { role: "compliance-manager", data });
  assert.match(pageText(), new RegExp(t("admin.sites.readOnly")));
  assert.equal($("#site-oversight-form").dataset.readOnly, "true");
  assert.equal(save().disabled, true);
  assert.ok(missing("#add-compliance-manager"));
  assert.ok(missing("[data-remove-compliance-manager]"));
});

test("the program manager picker reports how many managers match", async () => {
  const data = oversightData();
  data.programManagers.push(
    /** @type {any} */ ({
      userId: "pm3",
      name: "Drew Second",
      email: "drew2@example.org",
      status: "active",
    }),
  );
  await mountAdmin(OVERSIGHT, { data });
  await click("#add-compliance-manager");
  const status = () =>
    $("#choose-compliance-manager-dialog [data-manager-search-status]")
      .textContent;
  const visible = () =>
    $$(
      "#choose-compliance-manager-dialog li:not([hidden]) [data-select-compliance-manager]",
    ).length;
  const initial = status();
  await fill("#compliance-manager-search", "drew");
  assert.equal(visible(), 2);
  const many = status();
  await fill("#compliance-manager-search", "drew2");
  assert.equal(visible(), 1);
  assert.notEqual(status(), many);
  await fill("#compliance-manager-search", "nobody");
  assert.equal(visible(), 0);
  await fill("#compliance-manager-search", "");
  assert.equal(status(), initial);
  assert.equal(
    $("#choose-compliance-manager-dialog [data-manager-results-heading]")
      .hidden,
    true,
  );
});

/** @param {Record<string, unknown>} [site] */
function perimeterData(site = {}) {
  const data = adminData();
  data.sites[0] = {
    ...data.sites[0],
    perimeter: "16th Street between #1456 and #1756",
    perimeterUpdatedAt: "2026-10-18T10:00:00Z",
    ...site,
  };
  return data;
}

const perimeter = () => $('#site-perimeter-form wa-textarea[name="perimeter"]');
const updateLine = () =>
  document.querySelector("#site-perimeter-form + p")?.textContent || "";

async function failPerimeterSaveThenReopen() {
  await click('a[href="/sites/s1?section=compliance"]');
  await fill(perimeter(), "Mission Street from 16th to 17th");
  await click("#site-perimeter-form [data-save-button]");
  await click('a[href="/sites/s1?section=details"]');
  assert.ok(!missing("#site-details-form"));
  await click('a[href="/sites/s1?section=compliance"]');
}

test("perimeter save sends the text with the record version", async () => {
  const { api } = await mountAdmin(COMPLIANCE, {
    data: perimeterData(),
    setup: (api) =>
      api.on("PUT", /^sites\/s1\/perimeter$/, (request) => ({
        json: {
          perimeter: request.body.perimeter,
          updatedAt: "2026-10-30T10:00:00Z",
          perimeterUpdatedAt: "2026-10-30T10:00:00Z",
          perimeterUpdatedBy: "dana@example.org",
          perimeterUpdatedSource: "dashboard",
          perimeterUpdatedDeviceLabel: "",
        },
      })),
  });
  const button = () => $("#site-perimeter-form [data-save-button]");
  assert.equal(button().disabled, true);
  await fill(perimeter(), "Mission Street from 16th to 17th");
  assert.equal(button().disabled, false);
  await click(button());
  assert.match(updateLine(), /dana@example\.org/);
  assert.deepEqual(api.calls("PUT", /^sites\/s1\/perimeter$/)[0].body, {
    perimeter: "Mission Street from 16th to 17th",
    expectedUpdatedAt: "2026-10-20T10:00:00Z",
  });
});

test("a perimeter conflict offers to reload the latest Site", async () => {
  const { api } = await mountAdmin("/sites/s1?section=details", {
    data: perimeterData(),
    setup: (api) =>
      api.fail(
        "PUT",
        /^sites\/s1\/perimeter$/,
        409,
        "perimeter_update_conflict",
      ),
  });
  await failPerimeterSaveThenReopen();
  const reads = api.calls("GET", /^sites\/s1\?view=compliance$/).length;
  await click("#reload-site-perimeter");
  assert.equal(
    api.calls("GET", /^sites\/s1\?view=compliance$/).length,
    reads + 1,
  );
  assert.ok(missing("#reload-site-perimeter"));
});

test("other perimeter failures ask to check the text", async () => {
  await mountAdmin("/sites/s1?section=details", {
    data: perimeterData(),
    setup: (api) =>
      api.fail("PUT", /^sites\/s1\/perimeter$/, 500, "internal_error"),
  });
  await failPerimeterSaveThenReopen();
  assert.equal(
    $("#site-perimeter-form ~ div[role=alert]").textContent.trim(),
    "The perimeter could not be saved. Check the text and try again.",
  );
  assert.ok(missing("#reload-site-perimeter"));
});

test("an empty perimeter is refused before saving", async () => {
  const { api } = await mountAdmin(COMPLIANCE, { data: perimeterData() });
  await fill(perimeter(), "");
  await submit("#site-perimeter-form");
  assert.equal(
    saveError("#site-perimeter-form"),
    "Enter a perimeter description before saving.",
  );
  assert.deepEqual(api.calls("PUT", /perimeter$/), []);
});

for (const [label, site, expected] of [
  [
    "an app device label",
    {
      perimeterUpdatedSource: "good-neighbor",
      perimeterUpdatedDeviceLabel: "Front desk tablet",
    },
    "Front desk tablet",
  ],
  [
    "an app device ID",
    { perimeterUpdatedSource: "good-neighbor", perimeterUpdatedBy: "device-7" },
    "device-7",
  ],
  [
    "an administrator",
    { perimeterUpdatedBy: "dana@example.org" },
    "dana@example.org",
  ],
])
  test(`the perimeter shows when ${label} last updated it`, async () => {
    await mountAdmin(COMPLIANCE, {
      data: perimeterData(/** @type {any} */ (site)),
    });
    assert.ok(updateLine().includes(/** @type {string} */ (expected)));
  });

test("a perimeter never updated shows no update line", async () => {
  await mountAdmin(COMPLIANCE, {
    data: perimeterData({ perimeter: "", perimeterUpdatedAt: "" }),
  });
  assert.ok(!missing("#site-perimeter-form"));
  assert.equal(updateLine(), "");
});
