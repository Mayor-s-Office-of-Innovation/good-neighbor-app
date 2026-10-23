import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
const source = readFileSync(new URL("./main.js", import.meta.url), "utf8");
const helpers = source.slice(
  source.indexOf("function canEditSite("),
  source.indexOf("function myProfileView("),
);
const { canEditSite, canEditSiteManager } = vm.runInNewContext(
  `${helpers}; ({canEditSite, canEditSiteManager})`,
);
test("Site UI defaults to read-only unless server grants scope or user is a supervisor", () => {
  assert.equal(canEditSite({ capabilities: {} }), false);
  assert.equal(canEditSite({ capabilities: {}, siteCanEdit: false }), false);
  assert.equal(canEditSite({ capabilities: {}, siteCanEdit: true }), true);
  assert.equal(canEditSite({ capabilities: { createEntities: true } }), true);
});
test("shared manager UI requires assignment to all Sites and denies missing directory identity", () => {
  const state = {
    capabilities: {},
    profile: { directoryUserId: "cm" },
    siteManager: { assignedSites: [{ siteId: "one" }, { siteId: "two" }] },
    sites: [
      { siteId: "one", complianceManagerIds: ["cm"] },
      { siteId: "two", complianceManagerIds: [] },
    ],
  };
  assert.equal(canEditSiteManager(state), false);
  state.sites[1].complianceManagerIds.push("cm");
  assert.equal(canEditSiteManager(state), true);
  assert.equal(canEditSiteManager({ ...state, profile: null }), false);
});
test("read-only Site disables write controls but preserves informational reason dialogs", () => {
  const method = source.slice(
    source.indexOf("  applyCapabilities() {"),
    source.indexOf('\n}\n\ncustomElements.define("admin-app"'),
  );
  const app = vm.runInNewContext(`({${method}})`, {
    canEditSite,
    canEditSiteManager,
  });
  const field = { disabled: false, closest: () => null };
  const close = { disabled: false, closest: () => ({}) };
  const action = { disabled: false };
  const removed = [];
  app.state = { capabilities: {}, site: { siteId: "one" }, siteCanEdit: false };
  app.querySelectorAll = (selector) =>
    selector.startsWith(".site-page form")
      ? [field, close]
      : selector.startsWith("[data-require-checks]")
        ? [action]
        : [{ remove: () => removed.push(selector) }];
  app.querySelector = () => null;
  app.applyCapabilities();
  assert.equal(field.disabled, true);
  assert.equal(action.disabled, true);
  assert.equal(close.disabled, false);
  assert.ok(removed.some((s) => s.includes("[data-deactivate-site]")));
  assert.ok(removed.some((s) => s.includes("#manager-membership-form")));
});

test("later dirty-state updates cannot re-enable Save on a read-only Site", () => {
  class Button {
    disabled = false;
  }
  const sync = vm.runInNewContext(
    `${source.slice(source.indexOf("function syncSiteDetailsForm("), source.indexOf("function markSiteDetailsSectionEdited("))}; syncSiteDetailsForm`,
    {
      HTMLButtonElement: Button,
      controlValue: (_form, name) => (name === "site-name" ? "Changed" : ""),
    },
  );
  const buttons = Object.fromEntries(
    ["details", "address", "lead-program", "site-manager"].map((key) => [
      key,
      new Button(),
    ]),
  );
  const form = {
    dataset: { readOnly: "true" },
    querySelector(selector) {
      if (selector.startsWith("[name=")) return { getAttribute: () => "" };
      return {
        "[data-save-site-details]": buttons.details,
        "[data-save-address]": buttons.address,
        "[data-save-lead-program]": buttons["lead-program"],
        "[data-save-site-manager]": buttons["site-manager"],
      }[selector];
    },
  };
  sync(form, true);
  form.dataset.editedSections = '["details"]';
  sync(form);
  assert.equal(buttons.details.disabled, true);
  assert.equal(form.dataset.isDirty, "false");
  form.dataset.readOnly = "false";
  sync(form);
  assert.equal(buttons.details.disabled, false);
  assert.equal(form.dataset.isDirty, "true");
});
