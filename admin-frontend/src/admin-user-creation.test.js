import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { upsertRecord } from "./save-feedback.js";

const source = readFileSync(new URL("./main.js", import.meta.url), "utf8");
function method(name, context) {
  const start = source.indexOf(`  async ${name}(`);
  const end = source.indexOf("\n  }", start) + 4;
  return vm.runInNewContext(`(class { ${source.slice(start, end)} })`, context);
}
for (const outcome of ["invited", "active", "failure", "left"]) {
  test(`administrator invite: ${outcome}, no directory reload`, async () => {
    const calls = [];
    const user = { username: "confirmed", role: "compliance-supervisor" };
    const location = { pathname: "/administrators/new", search: "" };
    const Subject = method("inviteAdministrator", {
      location,
      upsertRecord,
      FormData: class {
        get() {
          return " value ";
        }
      },
      syncDirtyForm: (_, reset) => calls.push(["dirty", reset]),
      navigate: (path) => calls.push(["navigate", path]),
      actionFeedback: () => ({
        success: (key) => calls.push(["success", key]),
        failure: () => calls.push(["failure"]),
      }),
      adminApi: {
        inviteAdminUser: async (values) => {
          assert.equal(values.email, "value");
          if (outcome === "failure") throw new Error("failed");
          if (outcome === "left") location.pathname = "/sites";
          return { user, invitationStatus: outcome };
        },
      },
    });
    const app = new Subject();
    const other = { username: "existing" };
    app.state = { adminUsers: [other], adminUserStatusFilter: "suspended" };
    if (outcome === "failure") {
      await assert.rejects(app.inviteAdministrator({ dataset: {} }), /failed/);
      assert.deepEqual(app.state.adminUsers, [other]);
      assert.deepEqual(calls, [["failure"]]);
    } else {
      await app.inviteAdministrator({ dataset: {} });
      assert.deepEqual(app.state.adminUsers, [other, user]);
      assert.equal(app.programManagersStale, true);
      assert.equal(app.state.adminUserStatusFilter, "all");
      assert.ok(
        calls.some(
          ([kind, key]) =>
            kind === "success" &&
            key ===
              (outcome === "active"
                ? "admin.toast.accountActive"
                : "admin.toast.invitationSent"),
        ),
      );
      assert.equal(
        calls.some(([kind]) => kind === "navigate"),
        outcome !== "left",
      );
    }
  });
}

test("administrator routes reuse the directory only for a return from creation and enforce permissions", async () => {
  let route = { name: "administrator-new" };
  let reads = 0;
  const destinations = [];
  const Subject = method("openRoute", {
    currentRoute: () => route,
    location: { pathname: "/administrators", search: "" },
    navigate: (path) => destinations.push(path),
    adminApi: {
      listOversightOptions: async () => ({}),
      listAdminUsers: async () => {
        reads++;
        return { users: [] };
      },
    },
  });
  const app = new Subject();
  app.state = { capabilities: { manageAdminUsers: true } };
  app.render = () => {};
  app.querySelector = () => null;
  app.adminUsersLoaded = true;
  await app.openRoute();
  assert.equal(reads, 0);
  route = { name: "administrators" };
  await app.openRoute();
  assert.equal(reads, 0);
  await app.openRoute();
  assert.equal(reads, 1);
  app.state.capabilities.manageAdminUsers = false;
  route = { name: "administrator-new" };
  await app.openRoute();
  assert.deepEqual(destinations, ["/sites"]);
});
