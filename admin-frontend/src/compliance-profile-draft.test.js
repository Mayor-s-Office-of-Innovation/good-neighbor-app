import test from "node:test";
import assert from "node:assert/strict";
import {
  captureComplianceDraft,
  restoreComplianceDraft,
} from "./compliance-profile-draft.js";

test("profile detour restores the requirement draft and refreshes validation", () => {
  const reasons = [
    { value: "2", checked: false },
    { value: "6", checked: true },
  ];
  const fields = {
    "terms-site-manager-id": { value: "manager-1" },
    "terms-expiry": { value: "2026-12-31" },
    "terms-checks-per-day": { value: "7" },
  };
  let changed = false;
  const form = {
    querySelectorAll: () => reasons,
    querySelector: (selector) => fields[selector.match(/name="([^"]+)"/)[1]],
    dispatchEvent: (event) => {
      changed = event.type === "change";
    },
  };
  const draft = captureComplianceDraft(form, "site-1");
  reasons[0].checked = true;
  reasons[1].checked = false;
  for (const field of Object.values(fields)) field.value = "";
  restoreComplianceDraft(form, draft);
  assert.equal(draft.siteId, "site-1");
  assert.deepEqual(
    reasons.map((r) => r.checked),
    [false, true],
  );
  assert.equal(fields["terms-site-manager-id"].value, "manager-1");
  assert.equal(fields["terms-expiry"].value, "2026-12-31");
  assert.equal(fields["terms-checks-per-day"].value, "7");
  assert.equal(changed, true);
});
