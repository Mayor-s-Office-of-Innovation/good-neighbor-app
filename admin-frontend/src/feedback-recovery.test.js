import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { createActionFeedback } from "./action-feedback-core.js";
const source = readFileSync(new URL("./main.js", import.meta.url), "utf8");
function subject(name, api, notices) {
  const start = source.indexOf(`  async ${name}(`);
  const end = source.indexOf("\n  }", start) + 4;
  const t = (key, params) =>
    params ? JSON.stringify({ key, ...params }) : key;
  return vm.runInNewContext(`(class { ${source.slice(start, end)} })`, {
    adminApi: api,
    currentRoute: () => ({ name: "site-import" }),
    t,
    actionFeedback: (key) =>
      createActionFeedback(
        key,
        (notice) => {
          notices.push(notice);
          return {
            close() {
              notice.closed = true;
            },
          };
        },
        t,
      ),
    notifyAdmin: (title) => notices.push({ title }),
    sessionStorage: { removeItem() {} },
    window: { history: { replaceState() {} } },
  });
}
test("partial import summary and prior history survive a history read failure", async () => {
  const notices = [];
  const Subject = subject(
    "applySiteImport",
    {
      applySiteImport: async () => ({
        status: "complete",
        resultStatus: "partial",
        outcomes: { applied: 2, failed: 1, skipped_conflict: 1 },
      }),
      listSiteImports: async () => {
        throw new Error("offline");
      },
    },
    notices,
  );
  const app = new Subject();
  const history = [{ importId: "old" }];
  app.state = { importPreview: { importId: "new" }, importHistory: history };
  app.render = () => {};
  app.querySelector = () => null;
  await app.applySiteImport();
  assert.equal(app.state.importHistory, history);
  assert.match(app.state.importNotice.message, /"applied":2,"failed":2/);
  assert.equal(notices[0].closed, undefined);
  assert.equal(notices[1].title, "admin.import.historyRefreshFailed");
  assert.equal(app.state.importBusy, false);
});
test("legacy membership remains reconciled when grant request fails", async () => {
  const notices = [];
  const linked = { membershipId: "saved", name: "Manager" };
  const Subject = subject(
    "issueManagerGrant",
    {
      createManagerMembership: async () => ({ membership: linked }),
      createManagerGrant: async () => {
        throw Object.assign(new Error("conflict"), { status: 409 });
      },
    },
    notices,
  );
  const app = new Subject();
  app.state = {
    site: { siteId: "site" },
    managerMemberships: [{ membershipId: "legacy", legacyAssignment: true }],
  };
  app.render = () => {};
  app.querySelector = () => null;
  await assert.rejects(app.issueManagerGrant("legacy"));
  assert.equal(app.state.managerMemberships[0], linked);
  assert.equal(notices[0].title, "admin.toast.partial");
});
