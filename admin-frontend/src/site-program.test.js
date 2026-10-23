import assert from "node:assert/strict";
import test from "node:test";
import { siteProviderPrograms } from "./site-program.js";

test("site program choices include active programs independently of its provider", () => {
  const programs = [
    { programId: "one", providerId: "provider", status: "active" },
    { programId: "two", providerId: "other", status: "active" },
    { programId: "three", providerId: "provider", status: "inactive" },
  ];
  assert.deepEqual(
    siteProviderPrograms(programs, "provider").map((p) => p.programId),
    ["one", "two"],
  );
  assert.deepEqual(
    siteProviderPrograms(programs, "").map((p) => p.programId),
    ["one", "two"],
  );
});
