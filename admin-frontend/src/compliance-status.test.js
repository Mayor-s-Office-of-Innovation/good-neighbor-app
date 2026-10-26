import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
const source = readFileSync(new URL("./main.js", import.meta.url), "utf8");
const catalog = JSON.parse(
  readFileSync(
    new URL("../../frontend/src/i18n/catalogs/en.json", import.meta.url),
    "utf8",
  ),
);
const t = (key) => catalog[key];
function extract(name, next, context = {}) {
  return vm.runInNewContext(
    `${source.slice(source.indexOf(`function ${name}(`), source.indexOf(`function ${next}(`))}; ${name}`,
    { t, escapeHtml: String, ...context },
  );
}
test("active and inactive requirements expose distinct actions without a checkbox", () => {
  const render = extract(
    "siteComplianceSummaryView",
    "complianceLetterDetailsMissing",
    {
      activeSiteTerms: (terms) => terms[0],
      complianceLetterDetailsMissing: () => false,
      newChecksPeriodDialog: () => "",
      termsHistory: () => "",
    },
  );
  const active = render({ siteTerms: [{ effectiveStart: "2026-10-22" }] });
  assert.ok(active.includes(t("admin.compliance.active")));
  assert.ok(active.includes("data-end-checks"));
  assert.ok(!active.includes("data-require-checks"));
  assert.ok(active.includes(t("admin.compliance.endConfirmation")));
  const inactive = render({ siteTerms: [] });
  assert.ok(inactive.includes(t("admin.compliance.inactive")));
  assert.ok(inactive.includes("data-require-checks"));
  assert.ok(!inactive.includes("perimeter-checks-required"));
  assert.ok(
    !inactive.includes("There is no current perimeter check compliance period"),
  );
});
test("letters are collapsed initially and expand only for the selected site", () => {
  const render = extract("siteLettersView", "termsHistory", {
    formatTimestamp: String,
  });
  const state = { site: { siteId: "one" } };
  assert.match(render(state), /<details data-site-letters >/);
  assert.match(
    render({ ...state, expandedLettersSiteId: "one" }),
    /<details data-site-letters open>/,
  );
  assert.match(
    render({ ...state, expandedLettersSiteId: "other" }),
    /<details data-site-letters >/,
  );
});
test("cadence accepts the endpoints 1 and 8 and rejects fractional or larger values", () => {
  let value;
  const validate = extract(
    "compliancePeriodValidationError",
    "splitPersonName",
    { selectedComplianceReasons: () => ["2"], controlValue: () => value },
  );
  for (value of [1, 8]) assert.equal(validate({}), "");
  for (value of [0, 1.5, 9, 100])
    assert.equal(validate({}), t("admin.compliance.invalidCadence"));
});

test("successful setup expands letters after reloading the site", async () => {
  const start = source.indexOf("  async createSiteTerms(");
  const end = source.indexOf("\n  }", start) + 4;
  const actions = vm.runInNewContext(`({${source.slice(start, end)}})`, {
    t,
    actionFeedback: () => ({
      success() {},
      failure() {
        assert.fail("Unexpected failure");
      },
    }),
    selectedComplianceReasons: () => ["2"],
    controlValue: () => "3",
    adminApi: { createSiteTerms: async () => ({ jobId: "new-job" }) },
    window: { history: { replaceState() {} } },
  });
  const app = {
    state: { site: { siteId: "one" }, expandedLettersSiteId: null },
    async openSite() {
      this.state.expandedLettersSiteId = null;
    },
    render() {},
    loadSiteLetters() {},
    refreshPendingComplianceLetter() {},
    refreshLetterEmails() {},
  };
  assert.equal(await actions.createSiteTerms.call(app, {}), true);
  assert.equal(app.state.expandedLettersSiteId, "one");
});
