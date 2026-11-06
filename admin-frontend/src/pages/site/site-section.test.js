// @vitest-environment node
import assert from "node:assert/strict";
import { test } from "vitest";

import { activeSiteSection } from "./site-section.js";

test("maps Site sub-sections to the panel that holds them", () => {
  assert.equal(activeSiteSection(null, {}), "details");
  assert.equal(activeSiteSection("staff", {}), "details");
  assert.equal(activeSiteSection("terms", {}), "compliance");
  assert.equal(activeSiteSection("letters", {}), "compliance");
  assert.equal(activeSiteSection("perimeter", {}), "compliance");
  assert.equal(activeSiteSection("access", {}), "access");
});

test("shows details instead of settings to admins who cannot create entities", () => {
  assert.equal(activeSiteSection("settings", {}), "details");
  assert.equal(
    activeSiteSection("settings", { createEntities: true }),
    "settings",
  );
});

test("a section named like an Object method stays a plain string", () => {
  for (const name of ["constructor", "toString", "__proto__"])
    assert.equal(activeSiteSection(name, {}), name);
});
