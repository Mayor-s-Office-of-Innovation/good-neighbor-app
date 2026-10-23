import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

test("enrollment failures show one toast and clear the stale page banner", async () => {
  const source = await readFile(new URL("./main.js", import.meta.url), "utf8");
  const start = source.indexOf("  async issueManagerGrant(");
  const end = source.indexOf("  /** @param {HTMLButtonElement}", start);
  const failures = [];
  const context = vm.createContext({
    actionFeedback: () => ({
      failure: (error) => failures.push(error.message),
    }),
    adminApi: {
      createManagerGrant: async () => {
        throw new Error("program_user_not_found");
      },
    },
    t: (key) => key,
  });
  const actions = vm.runInContext(`({${source.slice(start, end)}})`, context);
  const app = {
    state: {
      error: "program_user_not_found",
      site: { siteId: "site-1" },
      managerMemberships: [],
    },
    render() {},
  };
  await assert.rejects(
    actions.issueManagerGrant.call(app, "member-1", "code"),
    /program_user_not_found/,
  );
  assert.deepEqual(failures, ["program_user_not_found"]);
  assert.equal(app.state.error, "");
});

test("enrollment click handler does not duplicate the toast in the page banner", async () => {
  const source = await readFile(new URL("./main.js", import.meta.url), "utf8");
  const start = source.indexOf(
    '    this.querySelectorAll("[data-issue-manager-grant]")',
  );
  const end = source.indexOf(
    '    this.querySelectorAll("[data-cancel-manager-grant]")',
    start,
  );
  let click;
  const button = {
    dataset: { deliveryMode: "code" },
    addEventListener(_event, handler) {
      click = handler;
    },
  };
  const app = {
    state: { error: "" },
    querySelectorAll() {
      return [button];
    },
    async issueManagerGrant() {
      throw new Error("program_user_not_found");
    },
    render() {
      assert.fail("Failures should not render a page banner");
    },
  };
  const bind = vm.runInNewContext(
    `(function() {${source.slice(start, end)}})`,
    { dataAttr: () => "member-1" },
  );
  bind.call(app);
  await click();
  assert.equal(app.state.error, "");
});
