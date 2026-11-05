// @vitest-environment node
import { beginEnrollmentRequest } from "./enrollment-request.js";
import { test } from "vitest";
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
  beginEnrollmentRequest,
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
