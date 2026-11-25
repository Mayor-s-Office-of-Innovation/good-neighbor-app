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
      // The whole set, so a manager can't quietly gain a supervisor power.
      expect(principal.capabilities).toEqual({
        manageAdminUsers: false,
        createEntities: false,
        deactivateEntities: false,
        changeLeadProgram: false,
        manageSiteManagers: false,
        manageProviderManagers: false,
        runImports: false,
        viewInsights: true,
      });
    },
  );

  it("gives Compliance supervisors elevated capabilities", () => {
    const principal = adminPrincipal(event(ADMIN_GROUPS.supervisor));
    expect(principal.role).toBe(ADMIN_GROUPS.supervisor);
    expect(principal.capabilities).toEqual({
      manageAdminUsers: true,
      createEntities: true,
      deactivateEntities: true,
      changeLeadProgram: true,
      manageSiteManagers: true,
      manageProviderManagers: true,
      runImports: true,
      viewInsights: true,
    });
  });

  it("gives a caller in no admin group no Insights and no edit rights", () => {
    expect(adminPrincipal(event("site-staff")).capabilities).toEqual({
      manageAdminUsers: false,
      createEntities: false,
      deactivateEntities: false,
      changeLeadProgram: false,
      manageSiteManagers: false,
      manageProviderManagers: false,
      runImports: false,
      viewInsights: false,
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
        Item: {
          userId: "manager-1",
          status: "active",
          cognitoSubject: "sub-manager-1",
        },
      })
      .mockResolvedValueOnce({ Item: { status: "active" } });
    const response = await siteAdminOnly(
      event(ADMIN_GROUPS.manager, "manager@sfgov.org", "sub-manager-1"),
      "site-1",
      async () => ({ statusCode: 200, body: "ok" }),
    );
    expect(response.statusCode).toBe(200);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("rejects a Compliance manager whose Cognito subject does not match the directory row", async () => {
    send.mockResolvedValueOnce({
      Item: {
        userId: "manager-1",
        status: "active",
        cognitoSubject: "victim-sub",
      },
    });
    const response = await siteAdminOnly(
      event(ADMIN_GROUPS.manager, "victim@sfgov.org", "attacker-sub"),
      "site-1",
      async () => ({ statusCode: 200, body: "ok" }),
    );
    expect(response.statusCode).toBe(403);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("rejects a Compliance manager when directory cognitoSubject is missing or email is unverified", async () => {
    send.mockResolvedValueOnce({
      Item: { userId: "manager-1", status: "active" },
    });
    const missingSubject = await siteAdminOnly(
      event(ADMIN_GROUPS.manager, "manager@sfgov.org", "sub-manager-1"),
      "site-1",
      async () => ({ statusCode: 200, body: "ok" }),
    );
    expect(missingSubject.statusCode).toBe(403);
    expect(send).toHaveBeenCalledTimes(1);

    send.mockClear();
    const unverified = await siteAdminOnly(
      event(ADMIN_GROUPS.manager, "manager@sfgov.org", "sub-manager-1", false),
      "site-1",
      async () => ({ statusCode: 200, body: "ok" }),
    );
    expect(unverified.statusCode).toBe(403);
    expect(send).not.toHaveBeenCalled();
  });

  it("links a missing directory subject on first use when the username is the row's email", async () => {
    const row = {
      pk: "ADMIN_DIRECTORY#PROGRAM_MANAGERS",
      sk: "MANAGER#manager@example.org",
      userId: "manager-1",
      status: "active",
    };
    send
      .mockResolvedValueOnce({ Item: row })
      .mockResolvedValueOnce({
        Attributes: { ...row, cognitoSubject: "sub-manager-1" },
      })
      .mockResolvedValueOnce({ Item: { status: "active" } });
    const response = await siteAdminOnly(
      event(
        ADMIN_GROUPS.manager,
        "manager@example.org",
        "sub-manager-1",
        true,
        "Manager@example.org",
      ),
      "site-1",
      async () => ({ statusCode: 200, body: "ok" }),
    );
    expect(response.statusCode).toBe(200);
    const update = send.mock.calls[1][0].input;
    expect(update.Key).toEqual({ pk: row.pk, sk: row.sk });
    expect(update.ConditionExpression).toContain(
      "attribute_not_exists(cognitoSubject)",
    );
    expect(update.ExpressionAttributeValues[":subject"]).toBe("sub-manager-1");
  });

  it("never links a directory row from the email claim alone", async () => {
    send.mockResolvedValueOnce({
      Item: {
        pk: "ADMIN_DIRECTORY#PROGRAM_MANAGERS",
        sk: "MANAGER#victim@example.org",
        userId: "victim-1",
        status: "active",
      },
    });
    const response = await siteAdminOnly(
      event(
        ADMIN_GROUPS.manager,
        "victim@example.org",
        "attacker-sub",
        true,
        "attacker@example.org",
      ),
      "site-1",
      async () => ({ statusCode: 200, body: "ok" }),
    );
    expect(response.statusCode).toBe(403);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("uses the stored subject when a concurrent request linked the row first", async () => {
    const row = {
      pk: "ADMIN_DIRECTORY#PROGRAM_MANAGERS",
      sk: "MANAGER#manager@example.org",
      userId: "manager-1",
      status: "active",
    };
    send
      .mockResolvedValueOnce({ Item: row })
      .mockRejectedValueOnce(
        Object.assign(new Error("conditional"), {
          name: "ConditionalCheckFailedException",
        }),
      )
      .mockResolvedValueOnce({
        Item: { ...row, cognitoSubject: "other-sub" },
      });
    const response = await siteAdminOnly(
      event(
        ADMIN_GROUPS.manager,
        "manager@example.org",
        "sub-manager-1",
        true,
        "manager@example.org",
      ),
      "site-1",
      async () => ({ statusCode: 200, body: "ok" }),
    );
    expect(response.statusCode).toBe(403);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("rejects an inactive Compliance manager with an active Site assignment", async () => {
    send.mockResolvedValueOnce({
      Item: {
        userId: "manager-1",
        status: "inactive",
        cognitoSubject: "sub-manager-1",
      },
    });
    const response = await siteAdminOnly(
      event(ADMIN_GROUPS.manager, "manager@sfgov.org", "sub-manager-1"),
      "site-1",
      async () => ({ statusCode: 200, body: "ok" }),
    );
    expect(response.statusCode).toBe(403);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("rejects an unassigned Compliance manager but lets a supervisor bypass assignment", async () => {
    send
      .mockResolvedValueOnce({
        Item: {
          userId: "manager-1",
          status: "active",
          cognitoSubject: "sub-manager-1",
        },
      })
      .mockResolvedValueOnce({});
    const denied = await siteAdminOnly(
      event(ADMIN_GROUPS.manager, "manager@sfgov.org", "sub-manager-1"),
      "site-1",
      async () => ({ statusCode: 200 }),
    );
    expect(denied.statusCode).toBe(403);
    expect(JSON.parse(denied.body)).toEqual({
      error: "site_assignment_required",
    });

    send.mockClear();
    const allowed = await siteAdminOnly(
      event(ADMIN_GROUPS.supervisor, "supervisor@sfgov.org", "sub-sup-1"),
      "site-1",
      async () => ({ statusCode: 200 }),
    );
    expect(allowed.statusCode).toBe(200);
    expect(send).not.toHaveBeenCalled();
  });
});

/**
 * @param {string} group
 * @param {string} [email]
 * @param {string} [sub]
 * @param {boolean} [emailVerified]
 * @param {string} [username] the `cognito:username` claim, omitted when empty
 */
function event(
  group,
  email = "",
  sub = "sub-default",
  emailVerified = true,
  username = "",
) {
  return /** @type {any} */ ({
    requestContext: {
      authorizer: {
        jwt: {
          claims: {
            "cognito:groups": group,
            email,
            sub,
            email_verified: emailVerified,
            ...(username ? { "cognito:username": username } : {}),
          },
        },
      },
    },
  });
}

/** @param {unknown} groups */
function principal(groups) {
  return adminPrincipal(
    /** @type {any} */ ({
      requestContext: {
        authorizer: { jwt: { claims: { "cognito:groups": groups } } },
      },
    }),
  );
}

describe("API Gateway administrator groups", () => {
  it.each([
    "[central-admin compliance-supervisor]",
    "[compliance-supervisor central-admin]",
    "[compliance-manager compliance-supervisor]",
    '["central-admin","compliance-supervisor"]',
    "[central-admin, compliance-supervisor]",
    ["central-admin", "compliance-supervisor"],
  ])("recognizes supervisor membership in %j", (groups) => {
    expect(principal(groups)).toMatchObject({
      authenticated: true,
      role: "compliance-supervisor",
      capabilities: { manageAdminUsers: true },
    });
  });

  it("keeps manager-only access limited", () => {
    expect(principal("[central-admin compliance-manager]")).toMatchObject({
      authenticated: true,
      role: "compliance-manager",
      capabilities: { manageAdminUsers: false },
    });
  });

  it.each([
    "[not-compliance-supervisor support]",
    "[compliance-supervisor-readonly]",
    "[compliance-supervisor",
    '["compliance-supervisor" invalid]',
    "support compliance-supervisor",
    "[]",
    null,
  ])("rejects malformed or nonmatching groups %j", (groups) => {
    expect(principal(groups).authenticated).toBe(false);
  });
});
