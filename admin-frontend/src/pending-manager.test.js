import assert from "node:assert/strict";
import test from "node:test";
import { createAndAssignManager } from "./pending-manager.js";

test("cancel and reopen resumes a partial creation but changed person or scope creates a separate user", async () => {
  const pending = new Map();
  const operation = {
    siteId: "s1",
    programId: "p1",
    values: { firstName: "Sam", lastName: "Lee", email: "sam@example.org" },
  };
  let created = 0,
    assigned = 0;
  const api = {
    createProgramUser: async (_program, values) => ({
      user: { ...values, userId: `u${++created}` },
    }),
    createManagerMembership: async (...args) => {
      assigned++;
      if (assigned === 1) throw new Error("temporary");
      return args;
    },
  };
  await assert.rejects(createAndAssignManager(pending, operation, api));
  // A new form has no dataset; recovery is stored outside its lifecycle.
  const result = await createAndAssignManager(
    pending,
    { ...operation, values: { ...operation.values } },
    api,
  );
  assert.equal(created, 1);
  assert.equal(result.userId, "u1");
  assert.equal(pending.size, 0);
  await assert.rejects(
    createAndAssignManager(pending, operation, {
      ...api,
      createManagerMembership: async () => {
        throw new Error("temporary");
      },
    }),
  );
  await createAndAssignManager(
    pending,
    {
      ...operation,
      values: { ...operation.values, email: "other@example.org" },
    },
    api,
  );
  await createAndAssignManager(pending, { ...operation, siteId: "s2" }, api);
  assert.equal(created, 4);
});
