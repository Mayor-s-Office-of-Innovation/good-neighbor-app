import { createActionFeedback } from "./action-feedback-core.js";
import { upsertRecord } from "./save-feedback.js";
import { createAndAssignManager } from "./pending-manager.js";
import assert from "node:assert/strict";
import test from "node:test";
import { siteManagerRoster } from "./site-managers.js";

test("combines legacy assignments and memberships without duplicating a person", () => {
  const roster = siteManagerRoster(
    [
      {
        userId: "one",
        firstName: "First",
        lastName: "Manager",
        status: "active",
      },
      {
        userId: "two",
        firstName: "Second",
        lastName: "Manager",
        status: "active",
      },
    ],
    [
      {
        userId: "one",
        membershipId: "m1",
        status: "active",
        name: "Old Name",
        email: "old@example.org",
      },
    ],
    [
      {
        userId: "one",
        firstName: "Updated",
        lastName: "Name",
        email: "new@example.org",
      },
    ],
  );
  assert.equal(roster.length, 2);
  assert.equal(roster[0].membershipId, "m1");
  assert.equal(roster[0].name, "Updated Name");
  assert.equal(roster[0].email, "new@example.org");
  assert.equal(roster[1].legacyAssignment, true);
  assert.equal(roster[1].membershipId, "legacy:two");
});

test("matches older email-only memberships to current program staff", () => {
  const roster = siteManagerRoster(
    [{ userId: "u1", email: "sam@example.org" }],
    [{ membershipId: "m1", email: "sam@example.org", status: "active" }],
    [
      {
        userId: "u1",
        email: "sam@example.org",
        firstName: "Sam",
        lastName: "Lee",
      },
    ],
  );
  assert.equal(roster.length, 1);
  assert.equal(roster[0].userId, "u1");
});

test("saving assignments to several Sites serializes the shared staff count changes", async () => {
  const { readFileSync } = await import("node:fs");
  const vm = await import("node:vm");
  const source = readFileSync(new URL("./main.js", import.meta.url), "utf8");
  const start = source.indexOf("  async persistSiteManager(form)");
  const end = source.indexOf("\n  async removeSiteManager", start);
  let active = 0;
  let peak = 0;
  const calls = [];
  const destinations = [];
  const user = {
    userId: "u1",
    programId: "p1",
    firstName: "Sam",
    lastName: "Lee",
    email: "sam@example.org",
    phone: "4155550100",
    assignedSites: [],
  };
  const context = vm.createContext({
    upsertRecord,
    location: { pathname: "/managers/u1", search: "" },
    navigate: (path) => destinations.push(path),
    createAndAssignManager,
    FormData: class {
      get(name) {
        return (
          {
            "manager-program-id": "p1",
            "manager-first-name": "Sam",
            "manager-last-name": "Lee",
            "manager-phone": "4155550100",
            "manager-email": "sam@example.org",
          }[name] || ""
        );
      }
      getAll() {
        return ["s1", "s2"];
      }
    },
    formValue: (data, name) => String(data.get(name)),
    actionFeedback: (key) =>
      createActionFeedback(
        key,
        () => ({ close() {} }),
        (key) => key,
      ),
    adminApi: {
      updateProgramUser: async () => ({ user }),
      createManagerMembership: async (siteId) => {
        peak = Math.max(peak, ++active);
        calls.push(siteId);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active--;
        return {
          membership: { membershipId: `m-${siteId}`, siteId, userId: "u1" },
        };
      },
    },
    showFormSaveError: (_form, error) => {
      throw error;
    },
    managerSaveErrorMessage: (error) => error,
  });
  const Subject = vm.runInContext(
    `(class {
    ${source.slice(start, end)}
    state = {};
    async loadSiteManagers() { throw new Error("Unexpected directory reload"); }
    render() {}
  })`,
    context,
  );
  const subject = new Subject();
  subject.state = {
    siteManager: user,
    siteManagers: [user],
    programs: [{ programId: "p1", name: "Program", providerId: "provider" }],
    sites: [
      { siteId: "s1", name: "First" },
      { siteId: "s2", name: "Second" },
    ],
    capabilities: { createEntities: true },
  };
  const form = { dataset: { returnSite: "origin/site" } };
  await subject.persistSiteManager(form);
  assert.equal(subject.state.siteManager.assignedSites.length, 2);
  assert.equal(subject.state.siteManager.assignedSites[0].membershipId, "m-s1");
  assert.equal(peak, 1);
  assert.deepEqual(calls, ["s1", "s2"]);
  assert.deepEqual(destinations, ["/sites/origin%2Fsite?section=details"]);
  assert.equal(form.dataset.isDirty, "false");
});

test("creating a Site manager retries assignment without duplicating staff", async () => {
  const { readFileSync } = await import("node:fs");
  const vm = await import("node:vm");
  const source = readFileSync(new URL("./main.js", import.meta.url), "utf8");
  const start = source.indexOf("  async createSiteManagerFromAccess(form)");
  const end = source.indexOf("\n  async addManagerMembership", start);
  let staffCreates = 0,
    assignments = 0,
    opens = 0;
  const buttons = { save: { disabled: false }, cancel: { disabled: false } };
  const form = {
    dataset: {},
    querySelector: (selector) =>
      selector.includes("submit") ? buttons.save : buttons.cancel,
    querySelectorAll: () => [],
    closest: () => ({ close() {} }),
  };
  const context = vm.createContext({
    createAndAssignManager,
    FormData: class {
      get(name) {
        return {
          "new-manager-first-name": "Sam",
          "new-manager-last-name": "Lee",
          "new-manager-email": "sam@example.org",
          "new-manager-phone": "4155550100",
        }[name];
      }
    },
    formValue: (data, name) => data.get(name),
    t: (key) => key,
    showFormSaveError: () => {},
    actionFeedback: (key) =>
      createActionFeedback(
        key,
        () => ({ close() {} }),
        (key) => key,
      ),
    adminApi: {
      createPerson: async (values) => {
        staffCreates++;
        assert.equal(values.siteId, "s1");
        return { person: { ...values, personId: "u1" } };
      },
      assignPersonToSite: async (siteId, person) => {
        assignments++;
        assert.deepEqual([siteId, person.personId], ["s1", "u1"]);
        if (assignments === 1) throw new Error("temporary");
      },
    },
  });
  const Subject = vm.runInContext(
    `(class {
    ${source.slice(start, end)}
    state = { site: { siteId: "s1", leadProgramId: "p1" } };
    async openSite(siteId, updateUrl) { if (siteId !== "s1" || updateUrl !== false) throw new Error("wrong destination"); }
    querySelector() { return { focus() {} }; }
  })`,
    context,
  );
  const subject = new Subject();
  await subject.createSiteManagerFromAccess(form);
  assert.equal(staffCreates, 1);
  assert.ok(form.dataset.createdUser);
  assert.equal(buttons.save.disabled, false);
  await subject.createSiteManagerFromAccess(form);
  assert.equal(staffCreates, 1);
  assert.equal(assignments, 2);
  assert.equal(subject.state.managerDirectoryLoaded, false);
});

test("new site flow forces a fresh manager directory even when a stale load is pending", async () => {
  const { readFileSync } = await import("node:fs");
  const vm = await import("node:vm");
  const { createDirectoryLoader } = await import("./manager-directory.js");
  const source = readFileSync(new URL("./main.js", import.meta.url), "utf8");
  const start = source.indexOf("  async createSiteFromFlow(form)");
  const end = source.indexOf("\n  /**", start);
  let release;
  let loads = 0;
  const loader = createDirectoryLoader(async () => {
    if (++loads === 1)
      await new Promise((resolve) => {
        release = resolve;
      });
  });
  const old = loader.load();
  await Promise.resolve();
  const destinations = [];
  const values = {
    "provider-id": "p1",
    "lead-program-id": "g1",
    "site-manager-user-id": "u1",
  };
  const context = vm.createContext({
    FormData: class {},
    formValue: (_data, name) => values[name] || "",
    addressPartsFromForm: () => ({ city: "SF" }),
    formatAddressParts: () => "1 Main",
    controlValue: () => "",
    navigate: (path) => destinations.push(path),
    actionFeedback: (key) =>
      createActionFeedback(
        key,
        () => ({ close() {} }),
        (key) => key,
      ),
    adminApi: {
      createSite: async () => ({
        site: {
          siteId: "s1",
          addressParts: { city: "SF" },
          publicContact: { email: "public@example.org" },
          primaryContactUserId: "u1",
        },
      }),
      listManagerMemberships: async () => ({ memberships: [] }),
      createManagerMembership: async () => ({}),
    },
  });
  const Subject = vm.runInContext(
    `(class {${source.slice(start, end)} })`,
    context,
  );
  const subject = new Subject();
  subject.state = {
    managerDirectoryLoaded: true,
    newSiteUsers: [
      {
        userId: "u1",
        firstName: "Sam",
        lastName: "Lee",
        email: "sam@example.org",
      },
    ],
  };
  subject.loadDirectory = async () =>
    assert.equal(subject.state.managerDirectoryLoaded, false);
  subject.loadSiteManagers = (force) => {
    assert.equal(force, true);
    return loader.load(force);
  };
  const created = subject.createSiteFromFlow({});
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(loads, 1);
  release();
  await Promise.all([old, created]);
  assert.equal(loads, 2);
  assert.deepEqual(destinations, ["/sites/s1"]);
});
