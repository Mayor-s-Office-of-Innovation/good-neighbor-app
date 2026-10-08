import { expect, it } from "vitest";
import { ACTIONS_ESCALATIONS_V4_ROWS } from "./actions-escalations-v4.rows.js";
import { ACTIONS_ESCALATIONS_V5_ROWS } from "./actions-escalations-v5.rows.js";
import { activeCatalog, catalogForPolicyVersion } from "./catalog-registry.js";
import { validateCatalog } from "./rule-catalog.js";
it("activates v5 with only label changes and preserves historical policies", () => {
  expect(activeCatalog().policyVersion).toBe("actions-escalations-v5");
  expect(validateCatalog(activeCatalog())).toEqual([]);
  expect(ACTIONS_ESCALATIONS_V5_ROWS).toHaveLength(36);
  expect(
    ACTIONS_ESCALATIONS_V5_ROWS.map((r) => r.filter((_, i) => i !== 12)),
  ).toEqual(
    ACTIONS_ESCALATIONS_V4_ROWS.map((r) => r.filter((_, i) => i !== 12)),
  );
  expect(catalogForPolicyVersion("actions-escalations-v4").policyVersion).toBe(
    "actions-escalations-v4",
  );
});
