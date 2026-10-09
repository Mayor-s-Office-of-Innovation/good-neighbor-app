import { beforeEach, describe, expect, it, vi } from "vitest";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../db.js", () => ({ ddb: { send } }));

const { ADMIN_GROUPS, adminPrincipal, siteAdminOnly, supervisorOnly } =
  await import("./admin-auth.js");

beforeEach(() => {
  send.mockReset();
  vi.stubEnv("DYNAMO_TABLE", "gnp-test-app");
});

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

  it("allows an assigned Compliance manager to mutate that Site", async () => {
    send
      .mockResolvedValueOnce({
        Item: { userId: "manager-1", status: "active" },
      })
      .mockResolvedValueOnce({ Item: { status: "active" } });
    const response = await siteAdminOnly(
      event(ADMIN_GROUPS.manager, "manager@sfgov.org"),
      "site-1",
      async () => ({ statusCode: 200, body: "ok" }),
    );
    expect(response.statusCode).toBe(200);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("rejects an inactive Compliance manager with an active Site assignment", async () => {
    send.mockResolvedValueOnce({
      Item: { userId: "manager-1", status: "inactive" },
    });
    const response = await siteAdminOnly(
      event(ADMIN_GROUPS.manager, "manager@sfgov.org"),
      "site-1",
      async () => ({ statusCode: 200, body: "ok" }),
    );
    expect(response.statusCode).toBe(403);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("rejects an unassigned Compliance manager but lets a supervisor bypass assignment", async () => {
    send
      .mockResolvedValueOnce({
        Item: { userId: "manager-1", status: "active" },
      })
      .mockResolvedValueOnce({});
    const denied = await siteAdminOnly(
      event(ADMIN_GROUPS.manager, "manager@sfgov.org"),
      "site-1",
      async () => ({ statusCode: 200 }),
    );
    expect(denied.statusCode).toBe(403);
    expect(JSON.parse(denied.body)).toEqual({
      error: "site_assignment_required",
    });

    send.mockClear();
    const allowed = await siteAdminOnly(
      event(ADMIN_GROUPS.supervisor, "supervisor@sfgov.org"),
      "site-1",
      async () => ({ statusCode: 200 }),
    );
    expect(allowed.statusCode).toBe(200);
    expect(send).not.toHaveBeenCalled();
  });
});

/** @param {string} group @param {string} [email] */
function event(group, email = "") {
  return /** @type {any} */ ({
    requestContext: {
      authorizer: {
        jwt: { claims: { "cognito:groups": group, email } },
      },
    },
  });
}
