import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { siteManagerRoster } from "./site-managers.js";
import { upsertRecord } from "./save-feedback.js";
const source = readFileSync(new URL("./main.js", import.meta.url), "utf8");
function subject(name, globals) {
  const start = source.indexOf(`  async ${name}(`);
  return new (vm.runInNewContext(
    `(class {${source.slice(start, source.indexOf("\n  }", start) + 4)}})`,
    globals,
  ))();
}
for (const failure of ["create", "membership", "none"]) {
  test(`site creation preserves required writes and failure semantics: ${failure}`, async () => {
    const calls = [];
    const site = {
      siteId: "new",
      addressParts: {},
      publicContact: {},
      primaryContactUserId: "manager",
    };
    const app = subject("createSiteFromFlow", {
      location: { pathname: "/sites/new", search: "" },
      upsertRecord,
      siteManagerRoster,
      siteSaveErrorMessage: (error) => error.message,
      FormData: class {},
      formValue: () => "manager",
      controlValue: () => "",
      addressPartsFromForm: () => ({}),
      formatAddressParts: () => "",
      syncDirtyForm: () => {},
      actionFeedback: () => ({
        changed() {},
        success: () => calls.push("success"),
        failure: () => calls.push("failure"),
      }),
      navigate: () => calls.push("navigate"),
      adminApi: {
        createSite: async () => {
          calls.push("create");
          if (failure === "create") throw Error("create");
          return { site };
        },
        listManagerMemberships: async () => ({ memberships: [] }),
        createManagerMembership: async () => {
          calls.push("membership");
          if (failure === "membership") throw Error("membership");
          return { membership: { membershipId: "m", userId: "manager" } };
        },
      },
    });
    app.state = { newSiteUsers: [{ userId: "manager" }], sites: [] };
    app.loadDirectory = async () => {};
    app.loadSiteManagers = async () => {};
    if (failure !== "none") {
      await assert.rejects(
        app.createSiteFromFlow({ dataset: {} }),
        new RegExp(failure),
      );
      assert.ok(!calls.includes("success"));
      assert.ok(!calls.includes("navigate"));
    } else {
      await app.createSiteFromFlow({ dataset: {} });
      assert.deepEqual(calls, ["create", "membership", "success", "navigate"]);
    }
  });
}
test("manager save retains the created person id after assignment failure for a safe retry", async () => {
  const app = subject("persistPersonManager", {
    location: { pathname: "/managers/new", search: "" },
    FormData: class {
      getAll() {
        return ["site"];
      }
    },
    formValue: () => "value",
    adminApi: {
      createPerson: async () => ({ person: { personId: "created" } }),
      listManagerMemberships: async () => ({ memberships: [] }),
      assignPersonToSite: async () => {
        throw Error("assignment failed");
      },
    },
  });
  app.state = { capabilities: { createEntities: true } };
  const form = { dataset: {} };
  await assert.rejects(
    app.persistPersonManager(form, null, {
      changed() {},
      success() {
        throw Error("unexpected success");
      },
    }),
    /assignment failed/,
  );
  assert.equal(form.dataset.createdPersonId, "created");
});
