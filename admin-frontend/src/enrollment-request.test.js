import test from "node:test";
import assert from "node:assert/strict";
import {
  beginEnrollmentRequest,
  syncEnrollmentRequests,
} from "./enrollment-request.js";

function button(scope = "site", disabled = false) {
  return {
    dataset: { enrollmentScope: scope },
    disabled,
    hasAttribute: () => false,
  };
}
test("one request blocks all issuance modes across rerenders and releases on completion", () => {
  let buttons = [button(), button(), button()];
  const root = {
    state: { site: { siteId: "s" } },
    querySelectorAll: () => buttons,
  };
  const release = beginEnrollmentRequest(root, "site", "s");
  assert.ok(buttons.every((b) => b.disabled));
  assert.equal(beginEnrollmentRequest(root, "site", "s"), null);
  buttons = [button(), button(), button("site", true)];
  syncEnrollmentRequests(root);
  assert.ok(buttons.every((b) => b.disabled));
  release();
  assert.deepEqual(
    buttons.map((b) => b.disabled),
    [false, false, true],
  );
  assert.equal(typeof beginEnrollmentRequest(root, "site", "s"), "function");
});
test("late completion on another site does not release that site's pending request", () => {
  const buttons = [button()];
  const root = {
    state: { site: { siteId: "a" } },
    querySelectorAll: () => buttons,
  };
  const finishA = beginEnrollmentRequest(root, "site", "a");
  root.state.site.siteId = "b";
  const finishB = beginEnrollmentRequest(root, "site", "b");
  finishA();
  assert.equal(buttons[0].disabled, true);
  finishB();
  assert.equal(buttons[0].disabled, false);
});
