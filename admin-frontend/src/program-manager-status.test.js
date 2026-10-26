import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { siteManagerRoster } from "./site-managers.js";
const source = readFileSync(new URL("./main.js", import.meta.url), "utf8");
const en = JSON.parse(
  readFileSync(
    new URL("../../frontend/src/i18n/catalogs/en.json", import.meta.url),
    "utf8",
  ),
);
const t = (key) => en[key];

test("only actual lifecycle states are labeled; a link alone is not active", () => {
  const start = source.indexOf("function programManagerAccountLabel(");
  const end = source.indexOf("\n}", start) + 2;
  const label = vm.runInNewContext(`(${source.slice(start, end)})`, { t });
  for (const [status, key] of [
    ["invited", "statusInvited"],
    ["active", "statusActive"],
    ["suspended", "statusSuspended"],
  ])
    assert.equal(label(status), t(`admin.users.${key}`));
  for (const status of ["", "linked", "not-invited", undefined])
    assert.equal(label(status), "");
});

test("opening a site refreshes an invalidated manager list once, without reloading directories", async () => {
  const start = source.indexOf("  async openSite(");
  const end = source.indexOf("\n  }", start) + 4;
  let reads = 0;
  const manager = {
    userId: "invited",
    name: "New Person",
    accountStatus: "invited",
  };
  const Subject = vm.runInNewContext(
    `(class { ${source.slice(start, end)} })`,
    {
      AbortController,
      queueMicrotask,
      URLSearchParams,
      location: { pathname: "/sites/site", search: "" },
      siteManagerRoster,
      adminApi: {
        getSite: async () => ({
          items: [
            { sk: "#META", siteId: "site" },
            { sk: "COMPLIANCE_MANAGER#invited", managerId: "invited" },
          ],
        }),
        listManagerMemberships: async () => ({}),
        listManagerGrants: async () => ({}),
        listDevices: async () => ({}),
        listSiteTerms: async () => ({}),
        listPeople: async () => ({}),
        listCityProgramManagers: async () => {
          reads++;
          return { programManagers: [manager] };
        },
      },
    },
  );
  const app = new Subject();
  app.state = { sites: [], programManagers: [] };
  app.programManagersStale = true;
  app.render = () => {};
  app.querySelector = () => null;
  await app.openSite("site", false);
  assert.equal(reads, 1);
  assert.equal(app.state.programManagers[0], manager);
  assert.equal(
    app.state.assignedComplianceManagers[0].accountStatus,
    "invited",
  );
  await app.openSite("site", false);
  assert.equal(reads, 1);
});
