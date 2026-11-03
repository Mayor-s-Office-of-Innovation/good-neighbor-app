import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { escapeHtml, formatTimestamp } from "./dom.js";
const moduleSource = readFileSync(
  new URL("./enrollment-code-view.js", import.meta.url),
  "utf8",
)
  .replace(/^import .*;$/gm, "")
  .replace(/export /g, "");
const context = vm.createContext({
  escapeHtml,
  formatTimestamp,
  t: (key) => key,
  setTimeout,
  clearTimeout,
});
vm.runInContext(moduleSource, context);
const {
  clearEnrollmentCodeView,
  enrollmentCodePanel,
  bindEnrollmentCodeExpiry,
} = context;

function fixture(expiresAt = new Date(Date.now() + 60000).toISOString()) {
  const grant = {
    grantId: "g",
    membershipId: "m",
    status: "pending",
    expiresAt,
    issuedTo: "synthetic@example.org",
  };
  return {
    managerGrants: [grant],
    enrollmentCodeView: {
      codes: new Map([
        ["g", { scope: "site", id: "s", grant, code: "0AB123" }],
      ]),
      pending: new Set(),
    },
  };
}
test("display secrets are scoped to the view and removed on leave, redemption, or expiry", () => {
  const state = fixture();
  assert.match(enrollmentCodePanel(state, "site", "s"), /0AB123/);
  assert.equal(enrollmentCodePanel(state, "site", "other"), "");
  assert.ok(!JSON.stringify(state.managerGrants).includes("0AB123"));
  clearEnrollmentCodeView(state);
  assert.equal(enrollmentCodePanel(state, "site", "s"), "");
  const redeemed = fixture();
  redeemed.managerGrants[0].status = "redeemed";
  assert.equal(enrollmentCodePanel(redeemed, "site", "s"), "");
  const expired = fixture(new Date(0).toISOString());
  assert.equal(enrollmentCodePanel(expired, "site", "s"), "");
});
test("expiry removes an already displayed code without navigation", async () => {
  const state = fixture(new Date(Date.now() + 20).toISOString());
  let removed = false;
  bindEnrollmentCodeExpiry(
    {
      querySelectorAll: () => [
        {
          getAttribute: () => "g",
          remove: () => {
            removed = true;
          },
        },
      ],
    },
    state,
  );
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(removed, true);
  assert.equal(state.enrollmentCodeView.codes.size, 0);
});
test("a code returned after navigation is discarded", async () => {
  const source = readFileSync(new URL("./main.js", import.meta.url), "utf8");
  const start = source.indexOf("  async showEnrollmentCode(");
  const end = source.indexOf("\n  async issueManagerGrant", start);
  let finish;
  const context = vm.createContext({
    adminApi: {
      createManagerGrant: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    },
  });
  const Subject = vm.runInContext(
    `(class { ${source.slice(start, end)} })`,
    context,
  );
  const subject = new Subject();
  subject.state = { site: { siteId: "s" }, managerMemberships: [] };
  subject.render = () => {};
  subject.navigationGeneration = 1;
  const request = subject.showEnrollmentCode("site", "m");
  clearEnrollmentCodeView(subject.state);
  subject.navigationGeneration++;
  finish({ grant: { grantId: "g" }, enrollmentCode: "0AB123" });
  await request;
  assert.equal(subject.state.enrollmentCodeView, undefined);
});
