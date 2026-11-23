import { test } from "vitest";
import assert from "node:assert/strict";
import {
  $,
  $$,
  adminData,
  click,
  fill,
  pageError,
  pageText,
  revisitPage,
  settle,
  submit,
  toastText,
  missing,
  window,
} from "../test-support/admin-dom.js";
import { openSitePage } from "../test-support/site-pages.js";
import { gate } from "../../e2e/admin-tests/admin-mock.js";
import { t } from "../../frontend/src/i18n/i18n.js";
import { createAdminCatalog } from "./admin-catalog.js";

// pages/site/save-error-messages.js has no catalog key for this copy, so tests match its English.
const SITE_CONFLICT =
  "Someone else updated this site. Reload it before saving your changes.";
const saveError = () =>
  document
    .querySelector("#site-details-form [data-form-save-error]")
    ?.textContent.trim() || "";
const heading = () => $("admin-site-page h1").textContent.trim();

test("details save sends the edited name and contact, then confirms", async () => {
  const { api } = await openSitePage("/sites/s1");
  assert.equal($("[data-save-site-details]").disabled, true);
  await fill('wa-input[name="site-name"]', "Example Site Renamed");
  await fill('wa-input[name="public-contact-email"]', "desk@example.org");
  assert.equal($("[data-save-site-details]").disabled, false);
  await click("[data-save-site-details]");
  assert.equal(heading(), "Example Site Renamed");
  assert.equal($("[data-save-site-details]").disabled, true);
  const [patch] = api.calls("PATCH", /^sites\/s1$/);
  assert.equal(patch.body.name, "Example Site Renamed");
  assert.deepEqual(patch.body.publicContact, {
    email: "desk@example.org",
    phone: "4155550100",
    phoneExtension: "",
  });
  assert.equal(patch.body.siteType, "shelter");
  assert.equal(patch.body.addressParts, undefined);
});

test("pressing Enter saves the details, but not with an invalid email", async () => {
  const { api } = await openSitePage("/sites/s1");
  await fill('wa-input[name="public-contact-email"]', "not-an-email");
  await submit("#site-details-form");
  assert.equal(api.calls("PATCH", /^sites\/s1$/).length, 0);
  await fill('wa-input[name="public-contact-email"]', "desk@example.org");
  await submit("#site-details-form");
  assert.equal(
    api.calls("PATCH", /^sites\/s1$/)[0].body.publicContact.email,
    "desk@example.org",
  );
});

test("the public phone's extension field opens and closes", async () => {
  await openSitePage("/sites/s1");
  const extension = "#site-details-form [data-phone-extension]";
  assert.equal($(extension).hidden, true);
  await click("#site-details-form [data-add-extension]");
  assert.equal($(extension).hidden, false);
  await click("#site-details-form [data-remove-extension]");
  assert.equal($(extension).hidden, true);
  assert.equal($("#site-details-form [data-add-extension]").hidden, false);
});

test("resetting the details form turns Save off again", async () => {
  await openSitePage("/sites/s1");
  await fill('wa-input[name="site-name"]', "Example Site Renamed");
  assert.equal($("[data-save-site-details]").disabled, false);
  $("#site-details-form").reset();
  await settle();
  assert.equal($("[data-save-site-details]").disabled, true);
});

test("a Site typed Other keeps Other selected and saves it", async () => {
  const data = adminData();
  data.sites[0].siteType = "other";
  const { api } = await openSitePage("/sites/s1", { data });
  const siteType = '#site-details-form wa-select[name="site-type"]';
  assert.equal($(siteType).value, "other");
  assert.equal(
    $(`${siteType} wa-option[value="other"]`).textContent,
    t("admin.sites.typeOther"),
  );
  await fill('wa-input[name="site-name"]', "Example Site Renamed");
  await click("[data-save-site-details]");
  assert.equal(api.calls("PATCH", /^sites\/s1$/)[0].body.siteType, "other");
});

test("a Site with no type selects no type", async () => {
  const data = adminData();
  delete data.sites[0].siteType;
  await openSitePage("/sites/s1", { data });
  assert.equal($('#site-details-form wa-select[name="site-type"]').value, "");
});

test("details save explains each API error in its own words", async () => {
  const codes = [
    "lead_program_required",
    "site_creation_incomplete",
    "invalid_public_contact",
    "address_not_found",
    "geocoding_unavailable",
    "address_required",
    "invalid_address",
    "invalid_contact_person",
    "invalid_oversight",
    "valid_phone_required",
    "invalid_compliance",
    "invalid_compliance_letter",
    "compliance_letter_upload_failed",
    "site_update_conflict",
    "program_not_found",
    "unexpected_code",
  ];
  let next = 0;
  await openSitePage("/sites/s1", {
    setup: (api) =>
      api.on("PATCH", /^sites\/s1$/, () => ({
        status: 400,
        json: { error: codes[next++] },
      })),
  });
  await fill('wa-input[name="site-name"]', "Example Site Renamed");
  const messages = [];
  for (let index = 0; index < codes.length; index++) {
    await click("[data-save-site-details]");
    messages.push(saveError());
  }
  assert.ok(messages.includes(t("admin.compliance.checkInputs")));
  assert.ok(messages.includes(t("admin.errors.programUnavailable")));
  assert.equal(messages.at(-1), t("admin.toast.requestFailed"));
  assert.equal(new Set(messages).size, codes.length);
  messages.forEach((message, index) =>
    assert.ok(!message.includes(codes[index])),
  );
});

test("PDF errors share one explanation", async () => {
  const codes = [
    "pdf_required",
    "invalid_file_size",
    "invalid_compliance_letter",
    "site_update_conflict",
  ];
  let next = 0;
  await openSitePage("/sites/s1", {
    setup: (api) =>
      api.on("PATCH", /^sites\/s1$/, () => ({
        status: 400,
        json: { error: codes[next++] },
      })),
  });
  await fill('wa-input[name="site-name"]', "Example Site Renamed");
  const messages = [];
  for (const _code of codes) {
    await click("[data-save-site-details]");
    messages.push(saveError());
  }
  assert.equal(new Set(messages.slice(0, 3)).size, 1);
  assert.notEqual(messages[3], messages[0]);
});

function dataWithOtherProgram() {
  const data = adminData();
  data.programs.push({
    programId: "p3",
    name: "Other Program",
    providerId: "v1",
    status: "active",
  });
  return data;
}

/** @param {Record<string, any>} [extra] */
const preview = (extra = {}) => ({
  json: {
    preview: {
      updatedAt: "2026-10-20T10:00:00Z",
      previousProvider: "Example Provider",
      newProvider: "Example Provider",
      previousProgram: "Example Program",
      newProgram: "Other Program",
      retainedManagers: [],
      affectedProviderDevices: 0,
      ...extra,
    },
  },
});

test("changing the lead program asks to confirm, then reassigns", async () => {
  const { api } = await openSitePage("/sites/s1", {
    data: dataWithOtherProgram(),
    setup: (api) =>
      api.on("POST", /^sites\/s1\/reassign$/, (request) =>
        request.body.preview
          ? preview({
              retainedManagers: ["Alex Example"],
              affectedProviderDevices: 2,
            })
          : {
              json: {
                site: { leadProgramId: "p3", programName: "Other Program" },
              },
            },
      ),
  });
  assert.equal($("[data-save-lead-program]").disabled, true);
  await fill('wa-select[name="lead-program-id"]', "p3");
  assert.equal($("[data-save-lead-program]").disabled, false);
  await click("[data-save-lead-program]");
  assert.equal($("#lead-program-confirmation-dialog").open, true);
  // The provider access warning is only for a change of provider.
  assert.equal($("#lead-program-confirmation-copy").hidden, true);
  assert.equal(
    $("#lead-program-confirmation-dialog").hasAttribute("aria-describedby"),
    false,
  );
  await click('#lead-program-confirmation-dialog button[value="confirm"]');
  assert.match(toastText(), new RegExp(t("admin.toast.leadProgramSaved")));
  const [, reassign] = api.calls("POST", /^sites\/s1\/reassign$/);
  assert.deepEqual(reassign.body, {
    providerId: "v1",
    leadProgramId: "p3",
    expectedUpdatedAt: "2026-10-20T10:00:00Z",
  });
  assert.deepEqual(api.calls("PATCH", /^sites\/s1$/), []);
});

test("changing the lead provider warns about provider access", async () => {
  const data = dataWithOtherProgram();
  data.providers.push({
    providerId: "v4",
    name: "Fourth Provider",
    status: "active",
  });
  data.programs.push({
    programId: "p4",
    name: "Fourth Program",
    providerId: "v4",
    status: "active",
  });
  const { api } = await openSitePage("/sites/s1", {
    data,
    setup: (api) => api.on("POST", /^sites\/s1\/reassign$/, preview()),
  });
  await fill('wa-select[name="lead-provider-id"]', "v4");
  await fill('wa-select[name="lead-program-id"]', "p4");
  await click("[data-save-lead-program]");
  assert.equal($("#lead-program-confirmation-dialog").open, true);
  assert.equal($("#lead-program-confirmation-copy").hidden, false);
  assert.equal(
    $("#lead-program-confirmation-copy").textContent.trim(),
    t("admin.relationships.providerAccessWarning"),
  );
  assert.equal(
    $("#lead-program-confirmation-dialog").getAttribute("aria-describedby"),
    "lead-program-confirmation-copy",
  );
  assert.deepEqual(
    [
      api.calls("POST", /^sites\/s1\/reassign$/)[0].body.providerId,
      api.calls("POST", /^sites\/s1\/reassign$/)[0].body.leadProgramId,
    ],
    ["v4", "p4"],
  );
});

test("cancelling the lead program confirmation changes nothing", async () => {
  const { api } = await openSitePage("/sites/s1", {
    data: dataWithOtherProgram(),
    setup: (api) => api.on("POST", /^sites\/s1\/reassign$/, preview()),
  });
  await fill('wa-select[name="lead-program-id"]', "p3");
  await click("[data-save-lead-program]");
  assert.equal($("#lead-program-confirmation-dialog").open, true);
  await click('#lead-program-confirmation-dialog button[value="cancel"]');
  assert.equal($("#lead-program-confirmation-dialog").open, false);
  assert.equal(api.calls("POST", /^sites\/s1\/reassign$/).length, 1);
});

test("lead program errors stay on the form", async () => {
  const { api } = await openSitePage("/sites/s1", {
    data: dataWithOtherProgram(),
    setup: (api) =>
      api.fail(
        "POST",
        /^sites\/s1\/reassign$/,
        409,
        "site_reassignment_conflict",
      ),
  });
  await fill('wa-select[name="lead-program-id"]', "p3");
  await click("[data-save-lead-program]");
  assert.equal(saveError(), t("admin.errors.siteChanged"));
  let previewed = false;
  api.on("POST", /^sites\/s1\/reassign$/, () => {
    if (previewed)
      return { status: 400, json: { error: "incompatible_program" } };
    previewed = true;
    return preview();
  });
  await click("[data-save-lead-program]");
  await click('#lead-program-confirmation-dialog button[value="confirm"]');
  assert.equal(saveError(), t("admin.errors.programUnavailable"));
});

test("clearing the lead program asks to confirm, then saves without one", async () => {
  const { api } = await openSitePage("/sites/s1", {
    // admin.js reassignSite accepts an empty program, so mirror its replies.
    setup: (api) =>
      api.on("POST", /^sites\/s1\/reassign$/, (request) =>
        request.body.preview
          ? preview({ newProgram: "" })
          : { json: { site: { leadProgramId: "", programName: "" } } },
      ),
  });
  await fill('wa-select[name="lead-program-id"]', "");
  await click("[data-save-lead-program]");
  assert.equal($("#lead-program-confirmation-dialog").open, true);
  await click('#lead-program-confirmation-dialog button[value="confirm"]');
  assert.match(toastText(), new RegExp(t("admin.toast.leadProgramSaved")));
  const [, reassign] = api.calls("POST", /^sites\/s1\/reassign$/);
  assert.deepEqual(reassign.body, {
    providerId: "v1",
    leadProgramId: "",
    expectedUpdatedAt: "2026-10-20T10:00:00Z",
  });
});

test("a compliance manager without Site permission sees a read-only record", async () => {
  const { api } = await openSitePage("/sites/s1", {
    role: "compliance-manager",
  });
  assert.match(pageText(), new RegExp(t("admin.sites.readOnly")));
  assert.equal($("#site-details-form").dataset.readOnly, "true");
  assert.equal($('wa-input[name="site-name"]').disabled, true);
  assert.ok(missing("[data-save-lead-program]"));
  // A dirty-state update from an edit event must not re-enable Save.
  await fill('wa-input[name="site-name"]', "Example Site Renamed");
  assert.equal($("[data-save-site-details]").disabled, true);
  $("#site-details-form").requestSubmit();
  await settle();
  assert.deepEqual(api.calls("PATCH", /^sites\/s1$/), []);
});

test("a compliance manager with Site permission edits details but not the lead program", async () => {
  const { api } = await openSitePage("/sites/s1", {
    role: "compliance-manager",
    setup: (api) =>
      api.on("GET", /^sites\/s1\?view=details$/, (request) => ({
        json: { ...api.reply(request).json, permissions: { canEdit: true } },
      })),
  });
  assert.doesNotMatch(pageText(), new RegExp(t("admin.sites.readOnly")));
  assert.equal($('wa-select[name="lead-program-id"]').disabled, true);
  await fill('wa-input[name="site-name"]', "Example Site Renamed");
  await click("[data-save-site-details]");
  assert.equal(api.calls("PATCH", /^sites\/s1$/).length, 1);
});

test("a save error shows again after switching tabs and clears on edit", async () => {
  await openSitePage("/sites/s1?section=oversight", {
    setup: (api) =>
      api.fail("PATCH", /^sites\/s1$/, 409, "site_update_conflict"),
  });
  await revisitPage("/sites/s1?section=details");
  await fill('wa-input[name="site-name"]', "Example Site Renamed");
  await click("[data-save-site-details]");
  assert.equal(saveError(), SITE_CONFLICT);
  // <admin-app> asks before discarding the edit; app-site-navigation tests that dialog.
  await revisitPage("/sites/s1?section=oversight");
  assert.ok(!missing("#site-oversight-form"));
  await revisitPage("/sites/s1?section=details");
  assert.ok(!missing("#site-save-error"));
  await fill('wa-input[name="site-name"]', "Example Site Again");
  assert.ok(missing("#site-save-error"));
});

test("a save error shown in place stays after the next edit", async () => {
  await openSitePage("/sites/s1", {
    setup: (api) =>
      api.fail("PATCH", /^sites\/s1$/, 409, "site_update_conflict"),
  });
  await fill('wa-input[name="site-name"]', "Example Site Renamed");
  await click("[data-save-site-details]");
  const shown = saveError();
  await fill('wa-input[name="site-name"]', "Example Site Edited");
  assert.ok(shown);
  assert.equal(saveError(), shown);
});

test("an invalid contact email is not sent", async () => {
  const { api } = await openSitePage("/sites/s1");
  await fill('wa-input[name="public-contact-email"]', "not-an-email");
  assert.equal($("[data-save-site-details]").disabled, false);
  await click("[data-save-site-details]");
  assert.deepEqual(api.calls("PATCH", /^sites\/s1$/), []);
});

test("changing only the lead provider also asks for a reassignment", async () => {
  const data = adminData();
  data.providers.push({
    providerId: "v3",
    name: "Third Provider",
    status: "active",
  });
  const { api } = await openSitePage("/sites/s1", {
    data,
    setup: (api) =>
      api.on("POST", /^sites\/s1\/reassign$/, (request) =>
        request.body.preview
          ? {
              json: {
                preview: { ...preview().json.preview, updatedAt: undefined },
              },
            }
          : { json: { site: { providerId: "v3" } } },
      ),
  });
  await fill('wa-select[name="lead-provider-id"]', "v3");
  await click("[data-save-lead-program]");
  await click('#lead-program-confirmation-dialog button[value="confirm"]');
  assert.match(toastText(), new RegExp(t("admin.toast.leadProgramSaved")));
  const [, reassign] = api.calls("POST", /^sites\/s1\/reassign$/);
  assert.deepEqual(reassign.body, {
    providerId: "v3",
    leadProgramId: "p1",
    expectedUpdatedAt: "",
  });
});

test("choosing to create a program opens its dialog", async () => {
  await openSitePage("/sites/s1");
  await fill('wa-select[name="lead-program-id"]', "__create_program__");
  assert.equal($("#create-site-program-dialog").open, true);
});

test("a details save that finishes after moving to another Site leaves that Site on screen", async () => {
  const held = gate();
  await openSitePage("/sites/s1", {
    setup: (api) =>
      api.on("PATCH", /^sites\/s1$/, async () => {
        await held.promise;
        return undefined;
      }),
  });
  await fill('wa-input[name="site-name"]', "Example Site Renamed");
  await click("[data-save-site-details]");
  await revisitPage("/sites/s2");
  held.release();
  await settle();
  assert.equal(heading(), "Quiet Site");
});

test("a redraw after the URL moves on still draws the route open() was given", async () => {
  const { page } = await openSitePage("/sites/s1");
  window.history.replaceState({}, "", "/profile");
  page.render();
  assert.ok(!missing("admin-site-page h1"));
});

test("the Site page asks in its own dialog before its edits are dropped", async () => {
  const { page } = await openSitePage("/sites/s1");
  await fill('wa-input[name="site-name"]', "Harbor House");
  assert.equal(page.hasUnsavedChanges(), true);
  const keep = page.confirmLeave();
  await settle();
  assert.equal($("#site-unsaved-dialog").open, true);
  await click('#site-unsaved-dialog button[value="keep"]');
  assert.equal(await keep, false);
  const discard = page.confirmLeave();
  await click('#site-unsaved-dialog button[value="discard"]');
  assert.equal(await discard, true);
});

const crumbs = `nav[aria-label="${t("admin.breadcrumb.label")}"]`;
const url = () => window.location.pathname + window.location.search;

/** Hold the first GET matching `pattern` until released. @param {any} api @param {RegExp} pattern */
function holdFirst(api, pattern) {
  const held = gate();
  let reads = 0;
  api.on("GET", pattern, async () => {
    reads += 1;
    if (reads === 1) await held.promise;
    return undefined;
  });
  return held;
}

test("breadcrumbs fall back to generic labels for unnamed parents", async () => {
  await openSitePage("/sites/s1", {
    setup: (api) => {
      api.data.providers.push({ providerId: "v9", name: "", status: "active" });
      api.data.programs.push({
        programId: "p9",
        name: "",
        providerId: "v9",
        status: "active",
      });
      api.data.sites[0] = {
        ...api.data.sites[0],
        providerId: "v9",
        providerName: "",
        leadProgramId: "p9",
        programName: "",
      };
    },
  });
  assert.equal(
    $(`${crumbs} a[href="/providers/v9"]`).textContent,
    t("admin.breadcrumb.provider"),
  );
  assert.equal(
    $(`${crumbs} a[href="/programs/p9"]`).textContent,
    t("admin.breadcrumb.program"),
  );
});

test("breadcrumbs show a provider's name as text and encode parent IDs", async () => {
  await openSitePage("/sites/s1", {
    setup: (api) => {
      api.data.providers.push({
        providerId: "v/9",
        name: "<b>Bold</b> & Co",
        status: "active",
      });
      api.data.programs.push({
        programId: "p/9",
        name: "Slash Program",
        providerId: "v/9",
        status: "active",
      });
      api.data.sites[0] = {
        ...api.data.sites[0],
        providerId: "v/9",
        providerName: "<b>Bold</b> & Co",
        leadProgramId: "p/9",
      };
    },
  });
  assert.equal(
    $(`${crumbs} a[href="/providers/v%2F9"]`).textContent,
    "<b>Bold</b> & Co",
  );
  assert.ok(!missing(`${crumbs} a[href="/programs/p%2F9"]`));
});

test("a site page's breadcrumb names the site as the current page", async () => {
  await openSitePage("/sites/s1");
  assert.equal(
    $(`${crumbs} [aria-current="page"]`).textContent,
    t("admin.breadcrumb.site"),
  );
});

test("a Site with no provider or Program shows no parent links", async () => {
  await openSitePage("/sites/s1", {
    setup: (api) => {
      api.data.sites[0] = {
        ...api.data.sites[0],
        providerId: undefined,
        providerName: undefined,
        leadProgramId: undefined,
      };
    },
  });
  assert.deepEqual(
    $$(`${crumbs} a`).map((link) => link.getAttribute("href")),
    ["/sites"],
  );
});

test("a Site read that finishes after leave() doesn't let the page open, even at the same address", async () => {
  const { page, api } = await openSitePage("/sites/s1");
  // The lead Program read comes after the Site read, which leave() aborts.
  const held = holdFirst(api, /^programs\//);
  const opening = page.open({ name: "site", id: "s1" });
  // <admin-app> calls leave() as the user goes; the page mustn't wait for the URL to change.
  page.leave();
  held.release();
  assert.equal(await opening, false);
});

test("a redraw after leave() empties the Site page", async () => {
  const { page } = await openSitePage("/sites/s1");
  page.leave();
  // A save that ends after the user goes still calls render().
  page.render();
  assert.ok(missing("#site-details-form"));
  assert.equal(page.innerHTML, "");
});

test("a Site page mount given a catalog shows that catalog's Providers", async () => {
  const catalog = createAdminCatalog();
  catalog.seed({
    providers: [
      { providerId: "v9", name: "Seeded Provider", status: "active" },
    ],
    programs: [],
    oversightOptions: { departments: [], systemsOfCare: [] },
    programManagers: [],
  });
  await openSitePage("/sites/s1", { catalog });
  const provider = 'wa-select[name="lead-provider-id"] wa-option';
  assert.ok(!missing(`${provider}[value="v9"]`));
  assert.ok(missing(`${provider}[value="v1"]`));
});

test("modified, non-primary and already handled clicks skip in-app routing", async () => {
  await openSitePage("/sites/s1");
  const link = $('admin-site-page a[href="/sites/s1?section=oversight"]');
  // Stop happy-dom from following the links routeClick skips.
  const stop = (/** @type {Event} */ event) => event.preventDefault();
  window.addEventListener("click", stop);
  try {
    for (const init of [
      { button: 1 },
      { metaKey: true },
      { ctrlKey: true },
      { shiftKey: true },
      { altKey: true },
    ]) {
      link.dispatchEvent(
        new window.MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          ...init,
        }),
      );
      await settle();
      assert.equal(url(), "/sites/s1", JSON.stringify(init));
    }
    window.addEventListener("click", stop, { capture: true });
    link.dispatchEvent(
      new window.MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    window.removeEventListener("click", stop, { capture: true });
    await click("admin-site-page h1");
    assert.equal(url(), "/sites/s1");
  } finally {
    window.removeEventListener("click", stop);
  }
});

for (const [section, view, form] of [
  ["staff", "details", "#site-details-form"],
  ["terms", "compliance", "#site-perimeter-form"],
  ["letters", "compliance", "#site-perimeter-form"],
  ["perimeter", "compliance", "#site-perimeter-form"],
])
  test(`the legacy ${section} section opens the ${view} tab`, async () => {
    const { api } = await openSitePage(`/sites/s1?section=${section}`);
    assert.ok(!missing(form));
    assert.equal(
      $(`a[href="/sites/s1?section=${view}"]`).getAttribute("aria-current"),
      "page",
    );
    assert.equal(
      api.calls("GET", new RegExp(`^sites/s1\\?view=${view}$`)).length,
      1,
    );
  });

test("a Site without a lead program skips the program read", async () => {
  const { api } = await openSitePage("/sites/s1", {
    setup: (api) => {
      api.data.sites[0] = { ...api.data.sites[0], leadProgramId: undefined };
    },
  });
  // Any program ID, so a read of programs/undefined fails the test too.
  assert.equal(api.calls("GET", /^programs\//).length, 0);
  assert.equal(pageError(), "");
});

test("a failed deactivation stays on the Site with an error", async () => {
  await openSitePage("/sites/s1", {
    setup: (api) => api.fail("DELETE", /^sites\/s1$/),
  });
  await fill(
    '#deactivate-site-form wa-input[name="confirmation"]',
    "Example Site",
  );
  await click('#deactivate-site-form button[type="submit"]');
  assert.equal(
    $("#deactivate-site-form [data-form-save-error]").textContent.trim(),
    t("admin.site.deactivateError"),
  );
  assert.equal(url(), "/sites/s1");
});

test("a Compliance manager who may edit a Site keeps its edit controls", async () => {
  await openSitePage("/sites/s1", {
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
