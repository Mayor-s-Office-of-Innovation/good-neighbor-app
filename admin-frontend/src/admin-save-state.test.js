import test from "node:test";
import assert from "node:assert/strict";
import { letterEmailProgress, profilePhoneUpdate } from "./admin-save-state.js";

test("older uncertain sends do not stop or mask a new send", () => {
  const items = [{ letterJobId: "old", deliveryState: "uncertain" }];
  assert.equal(letterEmailProgress(items, "new").currentUncertain, false);
  const sent = { type: "complianceLetterEmail", sk: "LETTER_EMAIL#new" };
  const progress = letterEmailProgress([...items, sent], "new");
  assert.equal(progress.sent, sent);
  assert.equal(progress.uncertain, true);
  assert.deepEqual(progress.history, [sent]);
  assert.equal(letterEmailProgress(items, "old").currentUncertain, true);
  assert.equal(letterEmailProgress([sent], "other").sent, undefined);
});
test("name-only edits omit missing phones without silently ignoring clearing", () => {
  assert.deepEqual(profilePhoneUpdate("", ""), {});
  assert.deepEqual(profilePhoneUpdate("", "1234567890"), { phone: "" });
  assert.deepEqual(profilePhoneUpdate("1234567890", ""), {
    phone: "1234567890",
  });
});
