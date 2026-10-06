import assert from "node:assert/strict";
import test from "node:test";

import { selectedLeadProgram } from "./site-assignment.js";

test("resolves the selected Lead program with its Provider", () => {
  const program = selectedLeadProgram(
    [
      {
        programId: "program-old",
        providerId: "provider-old",
        status: "active",
      },
      {
        programId: "program-new",
        providerId: "provider-new",
        status: "active",
      },
    ],
    "program-new",
  );

  assert.equal(program?.providerId, "provider-new");
});

test("does not resolve inactive or missing Lead programs", () => {
  const programs = [
    {
      programId: "program-inactive",
      providerId: "provider-old",
      status: "inactive",
    },
  ];

  assert.equal(selectedLeadProgram(programs, "program-inactive"), null);
  assert.equal(selectedLeadProgram(programs, "program-missing"), null);
});
