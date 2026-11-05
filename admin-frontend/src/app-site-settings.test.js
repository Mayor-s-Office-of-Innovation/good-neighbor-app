import { test } from "vitest";
import assert from "node:assert/strict";
import {
  $,
  click,
  fill,
  missing,
  mountAdmin,
  window,
} from "../test-support/admin-dom.js";
import { t } from "../../frontend/src/i18n/i18n.js";

// pages/site/record.templates.js has no catalog key for this copy, so tests match its English.

const SETTINGS = "/sites/s1?section=settings";
const form = "#site-deliberate-311-form";
const select = `${form} wa-select[name="deliberate-311-enabled"]`;
const save = `${form} [data-save-button]`;
const DELIBERATE_311 = /^sites\/s1\/deliberate-311$/;

/** @param {any} api */
function serveSetting(api) {
  api.on("PUT", DELIBERATE_311, (/** @type {any} */ request) => {
    Object.assign(api.data.sites[0], {
      deliberate311ProductionEnabled:
        request.body.deliberate311ProductionEnabled,
      updatedAt: "version-2",
    });
    return { json: { site: api.data.sites[0] } };
  });
}

test("a Supervisor switches a Site to simulated 311 filing", async () => {
  const { api } = await mountAdmin(SETTINGS, {
    setup: (api) => {
      api.data.sites[0].updatedAt = "version-1";
      serveSetting(api);
    },
  });
  assert.equal($(select).value, "true");
  assert.equal($(save).disabled, true);
  await fill(select, "false");
  assert.equal($(save).disabled, false);
  await click(save);
  assert.deepEqual(api.calls("PUT", DELIBERATE_311)[0].body, {
    deliberate311ProductionEnabled: false,
    expectedUpdatedAt: "version-1",
  });
  assert.equal($(form).dataset.isDirty, "false");
  assert.equal($(save).disabled, true);
  assert.equal($(select).value, "false");
});

test("a failed settings save keeps the draft for another try", async () => {
  const { api } = await mountAdmin(SETTINGS, {
    setup: (api) => api.fail("PUT", DELIBERATE_311, 409, "site_changed"),
  });
  await fill(select, "false");
  await click(save);
  assert.equal(
    $(`${form} [data-form-save-error]`).textContent,
    t("admin.errors.siteChanged"),
  );
  assert.equal($(select).value, "false");
  assert.equal($(select).hasAttribute("disabled"), false);
  assert.equal($(save).disabled, false);
  assert.equal($(form).dataset.isDirty, "true");
  serveSetting(api);
  await click(save);
  assert.equal($(form).dataset.isDirty, "false");
});

test("an edited setting guards leaving the tab", async () => {
  await mountAdmin(SETTINGS);
  await fill(select, "false");
  await click('nav[aria-label="Site sections"] a[href$="section=details"]');
  assert.equal($("#site-unsaved-dialog").open, true);
  await click('#site-unsaved-dialog button[value="keep"]');
  assert.equal(window.location.search, "?section=settings");
  assert.equal($(select).value, "false");
});

test("a Compliance manager has no App settings tab", async () => {
  await mountAdmin(SETTINGS, { role: "compliance-manager" });
  assert.ok(missing('a[href="/sites/s1?section=settings"]'));
  assert.ok(missing(form));
  // The settings URL falls back to the details tab, not a blank page.
  assert.ok(!missing("#site-details-form"));
});
