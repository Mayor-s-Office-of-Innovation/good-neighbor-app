import { describe, expect, it } from "vitest";
import { ADMIN_GROUPS, adminPrincipal, supervisorOnly } from "./admin-auth.js";

describe("admin roles", () => {
  it.each([ADMIN_GROUPS.manager, ADMIN_GROUPS.legacyManager])(
    "treats %s as a Compliance manager",
    (group) => {
      const principal = adminPrincipal(event(group));
      expect(principal.role).toBe(ADMIN_GROUPS.manager);
      expect(principal.capabilities.createEntities).toBe(false);
      expect(principal.capabilities.manageSiteManagers).toBe(false);
    },
  );

  it("gives Compliance supervisors elevated capabilities", () => {
    const principal = adminPrincipal(event(ADMIN_GROUPS.supervisor));
    expect(principal.role).toBe(ADMIN_GROUPS.supervisor);
    expect(principal.capabilities).toMatchObject({
      createEntities: true,
      deactivateEntities: true,
      changeLeadProgram: true,
      manageAdminUsers: true,
    });
  });

  it("rejects a Compliance manager at a supervisor-only boundary", async () => {
    const response = await supervisorOnly(
      event(ADMIN_GROUPS.manager),
      async () => ({ ok: true }),
    );
    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body)).toEqual({ error: "supervisor_required" });
  });
});

/** @param {string} group */
function event(group) {
  return /** @type {any} */ ({
    requestContext: {
      authorizer: { jwt: { claims: { "cognito:groups": group } } },
    },
  });
}
