import { beforeEach, expect, it, vi } from "vitest";
const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../db.js", () => ({ ddb: { send } }));
const { createManagerGrant, cancelManagerGrant } = await import(
  "./admin-manager-grants.js"
);
const {
  createManagerMembership,
  updateManagerMembership,
  deactivateManagerMembership,
} = await import("./admin-manager-memberships.js");
const {
  suspendDeviceBinding,
  revokeSelectedDeviceBindings,
  revokeAllSiteDeviceBindings,
} = await import("./admin-device-revocation.js");
const {
  presignComplianceLetter,
  issueAdminSetupCode,
  revokeDevice,
  updateSite,
  deactivateSite,
} = await import("./admin.js");
const { assignSiteUser, unassignSiteUser } = await import(
  "./admin-site-config.js"
);
const { createProgramUser, updateProgramUser } = await import(
  "./admin-programs.js"
);
const { authorizeSiteChanges } = await import("../lib/admin-auth.js");
beforeEach(() => {
  send.mockReset();
  vi.stubEnv("DYNAMO_TABLE", "test");
  vi.stubEnv("SETUP_CODE_VERIFIER_SECRET", "test-secret");
});
function event(body = {}, group = "compliance-manager") {
  return /** @type {any} */ ({
    body: JSON.stringify(body),
    pathParameters: {
      siteId: "s1",
      programId: "p1",
      userId: "u1",
      membershipId: "m1",
      grantId: "g1",
    },
    requestContext: {
      authorizer: {
        jwt: { claims: { "cognito:groups": group, email: "cm@example.org" } },
      },
    },
  });
}
const guarded = [
  createManagerGrant,
  cancelManagerGrant,
  createManagerMembership,
  updateManagerMembership,
  deactivateManagerMembership,
  suspendDeviceBinding,
  revokeSelectedDeviceBindings,
  revokeAllSiteDeviceBindings,
  presignComplianceLetter,
  issueAdminSetupCode,
  revokeDevice,
  updateSite,
  assignSiteUser,
  unassignSiteUser,
];
it.each(guarded)(
  "%s denies unassigned or inactive assignments before any mutation",
  async (handler) => {
    for (const assignment of [undefined, { status: "inactive" }]) {
      send
        .mockReset()
        .mockResolvedValueOnce({ Item: { userId: "cm", status: "active" } })
        .mockResolvedValueOnce({ Item: assignment });
      const result = await call(handler, event());
      expect(result.statusCode).toBe(403);
      expect(send.mock.calls).toHaveLength(2);
      expect(
        send.mock.calls.every(
          ([command]) => command.constructor.name === "GetCommand",
        ),
      ).toBe(true);
    }
  },
);
it("requires every Site in multi-Site operations, including legacy admin roles", async () => {
  for (const group of ["compliance-manager", "central-admin"]) {
    send
      .mockReset()
      .mockResolvedValueOnce({ Item: { userId: "cm", status: "active" } })
      .mockResolvedValueOnce({ Item: { status: "active" } })
      .mockResolvedValueOnce({});
    expect(
      (await authorizeSiteChanges(event({}, group), ["s1", "s2"]))?.statusCode,
    ).toBe(403);
    expect(send.mock.calls.map(([c]) => c.input.Key.sk)).toEqual([
      "MANAGER#cm@example.org",
      "COMPLIANCE_MANAGER#cm",
      "COMPLIANCE_MANAGER#cm",
    ]);
  }
});
it("allows all assigned Sites and refuses empty scope", async () => {
  send
    .mockResolvedValueOnce({ Item: { userId: "cm", status: "active" } })
    .mockResolvedValue({ Item: { status: "active" } });
  expect(await authorizeSiteChanges(event(), ["s1", "s2"])).toBeNull();
  expect((await authorizeSiteChanges(event(), []))?.statusCode).toBe(403);
});
it("allows assigned managers to create Site manager staff in that Site's lead program", async () => {
  send
    .mockResolvedValueOnce({ Item: { userId: "cm", status: "active" } })
    .mockResolvedValueOnce({ Item: { status: "active" } })
    .mockResolvedValueOnce({ Item: { status: "active", leadProgramId: "p1" } })
    .mockResolvedValueOnce({ Item: { status: "active" } })
    .mockResolvedValue({});
  const result = await call(
    createProgramUser,
    event({
      siteId: "s1",
      siteManager: true,
      firstName: "Alex",
      lastName: "Lee",
      email: "alex@example.org",
      phone: "4155550101",
    }),
  );
  expect(result.statusCode).toBe(201);
  expect(send.mock.calls.at(-1)?.[0].constructor.name).toBe(
    "TransactWriteCommand",
  );
});
it("rejects a mismatched lead program before creating staff", async () => {
  send
    .mockResolvedValueOnce({ Item: { userId: "cm", status: "active" } })
    .mockResolvedValueOnce({ Item: { status: "active" } })
    .mockResolvedValueOnce({
      Item: { status: "active", leadProgramId: "other" },
    });
  expect(
    (await call(createProgramUser, event({ siteId: "s1", siteManager: true })))
      ?.statusCode,
  ).toBe(403);
  expect(send.mock.calls).toHaveLength(3);
});
it("does not let assigned managers deactivate Sites", async () => {
  expect((await call(deactivateSite, event()))?.statusCode).toBe(403);
  expect(send).not.toHaveBeenCalled();
});
it("shared staff edits reject an unassigned Site discovered on a later directory page", async () => {
  send.mockImplementation(async (c) => {
    const key = c.input.Key;
    const values = c.input.ExpressionAttributeValues;
    if (key?.sk === "USER#u1")
      return {
        Item: {
          status: "active",
          email: "alex@example.org",
          siteManager: true,
        },
      };
    if (key?.pk === "ADMIN_DIRECTORY#PROGRAM_MANAGERS")
      return { Item: { userId: "cm", status: "active" } };
    if (key?.sk === "COMPLIANCE_MANAGER#cm")
      return key.pk === "SITE#s1" ? { Item: { status: "active" } } : {};
    if (key?.sk === "ASSIGNED_USER#u1") return { Item: { status: "active" } };
    if (values?.[":pk"]?.startsWith("MANAGER_EMAIL#"))
      return c.input.ExclusiveStartKey
        ? { Items: [{ siteId: "s2" }] }
        : {
            Items: [{ siteId: "s1" }],
            LastEvaluatedKey: { pk: "directory", sk: "cursor" },
          };
    if (c.constructor.name === "QueryCommand") return { Items: [] };
    throw new Error("Unexpected mutation");
  });
  const result = await call(
    updateProgramUser,
    event({
      firstName: "Alex",
      lastName: "Lee",
      email: "alex@example.org",
      siteManager: true,
    }),
  );
  expect(result.statusCode).toBe(403);
});

/** @param {Function} handler @param {any} request */
async function call(handler, request) {
  return /** @type {import("aws-lambda").APIGatewayProxyStructuredResultV2} */ (
    await handler(request, {}, () => {})
  );
}
it("shared staff scope retains a Site after both email and Lead program change", async () => {
  send.mockImplementation(async (c) => {
    const key = c.input.Key;
    const values = c.input.ExpressionAttributeValues;
    if (key?.sk === "USER#u1")
      return {
        Item: {
          status: "active",
          email: "alex@example.org",
          siteManager: true,
        },
      };
    if (key?.pk === "ADMIN_DIRECTORY#PROGRAM_MANAGERS")
      return { Item: { userId: "cm", status: "active" } };
    if (key?.sk === "COMPLIANCE_MANAGER#cm")
      return key.pk === "SITE#s1" ? { Item: { status: "active" } } : {};
    if (key?.sk === "ASSIGNED_USER#u1") return { Item: { status: "active" } };
    if (values?.[":pk"] === "PROGRAM#p1") return { Items: [{ siteId: "s1" }] };
    if (values?.[":pk"] === "SITE_SEARCH#ACTIVE")
      return { Items: [{ siteId: "s1" }, { siteId: "s2" }] };
    if (c.constructor.name === "QueryCommand") return { Items: [] };
    throw new Error("Unexpected mutation");
  });
  const result = await call(
    updateProgramUser,
    event({
      firstName: "Alex",
      lastName: "Lee",
      email: "alex@example.org",
      siteManager: true,
    }),
  );
  expect(result.statusCode).toBe(403);
});

it("retrying a completed manager revocation succeeds without writes", async () => {
  const { revokeManagerDevices } = await import("./admin-device-revocation.js");
  send
    .mockResolvedValueOnce({ Item: { email: "alex@example.org" } })
    .mockResolvedValue({ Items: [] });
  const result = await call(
    revokeManagerDevices,
    event({ confirmation: "alex@example.org" }),
  );
  expect(result.statusCode).toBe(200);
  expect(JSON.parse(String(result.body)).affectedCount).toBe(0);
  expect(
    send.mock.calls.every(([c]) =>
      ["GetCommand", "QueryCommand"].includes(c.constructor.name),
    ),
  ).toBe(true);
});
it("retrying a completed physical-device revocation succeeds without writes", async () => {
  const { revokePhysicalDeviceEverywhere } = await import(
    "./admin-device-revocation.js"
  );
  send.mockImplementation(async (c) =>
    c.constructor.name === "GetCommand"
      ? { Item: { status: "revoked", label: "Phone" } }
      : { Items: [] },
  );
  const request = event({ confirmation: "Phone" });
  request.pathParameters.physicalDeviceId = "physical-1";
  const result = await call(revokePhysicalDeviceEverywhere, request);
  expect(result.statusCode).toBe(200);
  expect(JSON.parse(String(result.body)).alreadyRevoked).toBe(true);
  expect(
    send.mock.calls.every(([c]) =>
      ["GetCommand", "QueryCommand"].includes(c.constructor.name),
    ),
  ).toBe(true);
});
it("emergency revocation cannot partially modify an allowed Site when another Site is unassigned", async () => {
  const { startEmergencySiteRevocation } = await import(
    "./admin-multi-site-revocation.js"
  );
  send
    .mockResolvedValueOnce({ Item: { userId: "cm", status: "active" } })
    .mockResolvedValueOnce({ Item: { status: "active" } })
    .mockResolvedValueOnce({});
  const result = await call(
    startEmergencySiteRevocation,
    event({ siteIds: ["s1", "s2"] }),
  );
  expect(result.statusCode).toBe(403);
  expect(
    send.mock.calls.every(([c]) => c.constructor.name === "GetCommand"),
  ).toBe(true);
});
