import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("./main.js", import.meta.url), "utf8");
const en = JSON.parse(
  readFileSync(
    new URL("../../frontend/src/i18n/catalogs/en.json", import.meta.url),
    "utf8",
  ),
);
const t = (key) => en[key] ?? key;

test("Other remains selected in the Site editor", () => {
  const start = source.indexOf("function siteTypeSelect(");
  const end = source.indexOf("\n}", start) + 2;
  const select = vm.runInNewContext(`(${source.slice(start, end)})`, { t });
  assert.ok(
    select("other").includes(
      `<wa-option value="other" selected>${t("admin.sites.typeOther")}</wa-option>`,
    ),
  );
  assert.ok(!select("").includes('value="other" selected'));
});

test("Other does not preselect a perimeter-check reason", () => {
  const start = source.indexOf(
    "  const mappedReason =",
    source.indexOf("function newChecksPeriodDialog("),
  );
  const end = source.indexOf("  const reasons =", start);
  for (const [siteType, expected] of [
    ["other", undefined],
    ["shelter", "3"],
    ["drop_in", "4"],
    ["permanent_supportive_housing", "2"],
  ]) {
    assert.equal(
      vm.runInNewContext(`${source.slice(start, end)} mappedReason`, {
        state: { site: { siteType } },
      }),
      expected,
    );
  }
});
