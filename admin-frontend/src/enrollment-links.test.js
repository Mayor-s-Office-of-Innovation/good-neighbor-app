import assert from "node:assert/strict";
import test from "node:test";

import {
  attachCreatedEnrollmentUrl,
  copyEnrollmentUrl,
} from "./enrollment-links.js";

test("attaches a newly issued secret URL only to its matching grant", () => {
  const grants = [{ grantId: "older" }, { grantId: "new" }];
  const result = attachCreatedEnrollmentUrl(grants, {
    grant: { grantId: "new" },
    enrollmentUrl: "http://localhost:5173/#enrollment_grant=new&token=secret",
  });

  assert.equal(result[0].enrollmentUrl, undefined);
  assert.equal(
    result[1].enrollmentUrl,
    "http://localhost:5173/#enrollment_grant=new&token=secret",
  );
});

test("copies an enrollment URL through the supplied clipboard", async () => {
  const copied = [];
  await copyEnrollmentUrl("https://example.test/#secret", {
    writeText: async (value) => copied.push(value),
  });
  assert.deepEqual(copied, ["https://example.test/#secret"]);
});

test("rejects when clipboard access is unavailable", async () => {
  await assert.rejects(
    copyEnrollmentUrl("https://example.test/#secret", undefined),
    /clipboard_unavailable/,
  );
});
