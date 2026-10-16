import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultProgramManagerFilter,
  matchesProgramManager,
} from "./program-manager-filter.js";
test("defaults to the caller only for managers and preserves explicit All or other selections", () => {
  const profile = { directoryUserId: "me" };
  assert.equal(
    defaultProgramManagerFilter("compliance-manager", profile, null),
    "id:me",
  );
  assert.equal(
    defaultProgramManagerFilter("compliance-manager", profile, ""),
    "",
  );
  assert.equal(
    defaultProgramManagerFilter("compliance-manager", profile, "id:other"),
    "id:other",
  );
  assert.equal(
    defaultProgramManagerFilter("compliance-supervisor", profile, null),
    "",
  );
});
test("filters active assignments by identity, including secondary managers and missing identities", () => {
  const site = {
    complianceManagerIds: ["other", "me"],
    oversight: { cityProgramManager: "Same Name" },
  };
  assert.equal(matchesProgramManager(site, "id:me"), true);
  assert.equal(matchesProgramManager(site, "id:unassigned"), false);
  assert.equal(matchesProgramManager(site, "Same Name"), true);
  assert.equal(matchesProgramManager(site, ""), true);
  assert.equal(
    matchesProgramManager(
      site,
      defaultProgramManagerFilter("compliance-manager", {}, null),
    ),
    false,
  );
});
