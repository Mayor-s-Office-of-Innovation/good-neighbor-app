import { URLSearchParams } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
const { send, rows, transactions } = vi.hoisted(() => ({
  send: vi.fn(),
  rows: new Map(),
  transactions: /** @type {any[][]} */ ([]),
}));
vi.mock("../db.js", () => ({ ddb: { send } }));
vi.mock("../integrations/email.js", () => ({
  sendManagerSecurityNotification: vi.fn(async () => ({
    provider: "ses",
    messageId: "synthetic",
  })),
  sendProviderManagerSecurityNotification: vi.fn(),
}));
const { createStaffGrant, getCurrentStaffGrant, revokeGeneralBinding } =
  await import("./manager-access.js");
const { redeemEnrollmentGrant } = await import("./enrollment.js");
/** @param {Record<string, any>} row */
const key = (row) => `${row.pk}|${row.sk}`;
/** @param {Record<string, any>} row */
const save = (row) => rows.set(key(row), globalThis.structuredClone(row));
const site = () => rows.get("SITE#site-1|#META");
const issuer = () => rows.get("SITE#site-1|DEVICE_BINDING#manager-1");
const providerMember = () =>
  rows.get("PROVIDER#provider-1|PROVIDER_MANAGER#provider-member-1");
function event(body = {}) {
  return {
    body: JSON.stringify(body),
    requestContext: {
      requestId: "synthetic-request",
      authorizer: {
        jwt: {
          claims: {
            sub: "manager-1",
            "custom:siteId": "site-1",
            accessLevel: "manager",
          },
        },
      },
    },
  };
}
/** @param {Function} handler @param {any} request */
const call = async (handler, request) => handler(request, {}, () => {});
/** @param {any} response */
const data = (response) => JSON.parse(response.body);
async function issue(accessLevel = "general", contact = {}) {
  return call(
    createStaffGrant,
    event({ label: "Team phone", accessLevel, ...contact }),
  );
}
/** @param {any} response */
function grantFrom(response) {
  return [...rows.values()].find(
    (row) =>
      row.grantId === data(response).grant.grantId &&
      row.sk.startsWith("STAFF_GRANT#"),
  );
}
/** @param {any} response */
async function redeem(response) {
  const hash = new URLSearchParams(
    new URL(data(response).enrollmentUrl).hash.slice(1),
  );
  return call(
    redeemEnrollmentGrant,
    event({
      grantId: hash.get("enrollment_grant"),
      token: hash.get("enrollment_token"),
    }),
  );
}

beforeEach(() => {
  rows.clear();
  transactions.length = 0;
  vi.stubEnv("DYNAMO_TABLE", "gnp-test-app");
  vi.stubEnv("DEVICE_TOKEN_SECRET", "test-device-secret-at-least-32-bytes");
  vi.stubEnv("PROVIDER_APP_URL", "https://field.example.test/");
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  save({
    pk: "SITE#site-1",
    sk: "#META",
    siteId: "site-1",
    name: "Site One",
    providerId: "provider-1",
    status: "active",
    siteCredentialGeneration: 3,
    providerAccessGeneration: 2,
  });
  save({
    pk: "SITE#site-1",
    sk: "DEVICE_BINDING#manager-1",
    bindingId: "manager-1",
    siteId: "site-1",
    status: "active",
    accessLevel: "manager",
    authorityScope: "provider",
    providerId: "provider-1",
    providerMembershipId: "provider-member-1",
    providerMembershipGeneration: 4,
    providerAccessGeneration: 2,
    siteCredentialGeneration: 3,
    absoluteExpiresAt: "2099-01-01T00:00:00Z",
  });
  save({
    pk: "PROVIDER#provider-1",
    sk: "PROVIDER_MANAGER#provider-member-1",
    membershipId: "provider-member-1",
    status: "active",
    generation: 4,
  });
  save({
    pk: "SITE#site-1",
    sk: "MANAGER_MEMBERSHIP#existing",
    membershipId: "existing",
    name: "Existing Manager",
    email: "existing@example.org",
    status: "active",
    generation: 1,
    createdAt: "2020-01-01T00:00:00Z",
  });
  send.mockReset().mockImplementation(async (command) => {
    const input = command.input;
    if (command instanceof GetCommand)
      return { Item: rows.get(key(input.Key)) };
    if (command instanceof QueryCommand) {
      const values = input.ExpressionAttributeValues;
      const prefix = values[":prefix"];
      return {
        Items: [...rows.values()].filter(
          (row) =>
            row.pk === values[":pk"] &&
            (prefix
              ? row.sk.startsWith(prefix)
              : row.sk.startsWith("STAFF_GRANT#")),
        ),
      };
    }
    if (command instanceof TransactWriteCommand) {
      transactions.push(input.TransactItems);
      for (const write of input.TransactItems)
        if (write.Put) save(write.Put.Item);
    }
    return {};
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("issues and redeems a provider-issued team link without a site manager membership", async () => {
  const response = await issue();
  expect(response.statusCode).toBe(201);
  expect(grantFrom(response)).toMatchObject({
    accessLevel: "general",
    issuerAuthorityScope: "provider",
    issuerProviderMembershipId: "provider-member-1",
    issuerProviderMembershipGeneration: 4,
    issuerProviderAccessGeneration: 2,
  });
  expect(grantFrom(response).issuerMembershipId).toBeUndefined();
  const result = await redeem(response);
  expect(result.statusCode).toBe(201);
  expect(data(result)).toMatchObject({
    accessLevel: "general",
    site: { siteId: "site-1" },
  });
});

it("adds a named site manager and person atomically alongside existing managers", async () => {
  const response = await issue("manager", {
    firstName: "New",
    lastName: "Manager",
    email: "NEW@example.org",
  });
  expect(response.statusCode).toBe(201);
  expect(data(response).grant.accessLevel).toBe("manager");
  const grant = grantFrom(response);
  const membership = rows.get(
    `SITE#site-1|MANAGER_MEMBERSHIP#${grant.membershipId}`,
  );
  expect(membership).toMatchObject({
    firstName: "New",
    lastName: "Manager",
    email: "new@example.org",
    status: "active",
    siteId: "site-1",
    generation: 1,
  });
  expect(rows.get("SITE#site-1|MANAGER_MEMBERSHIP#existing").status).toBe(
    "active",
  );
  const person = rows.get(`PEOPLE|PERSON#${membership.personId}`);
  expect(person.sources).toContainEqual({
    pk: membership.pk,
    sk: membership.sk,
  });
  expect(
    [...rows.values()].some(
      (row) =>
        row.type === "managerMembershipDirectory" &&
        row.membershipId === grant.membershipId,
    ),
  ).toBe(true);
  const siteWrite = transactions[0].find(
    (write) => write.Update?.Key.sk === "#META",
  ).Update;
  expect(siteWrite.ExpressionAttributeValues[":contact"].email).toBe(
    "existing@example.org",
  );
  expect(siteWrite.ConditionExpression).toContain("providerAccessGeneration");
  const result = await redeem(response);
  expect(result.statusCode).toBe(201);
  expect(data(result)).toMatchObject({
    accessLevel: "manager",
    site: { siteId: "site-1" },
  });
  const binding = rows.get(
    `SITE#site-1|DEVICE_BINDING#${data(result).bindingId}`,
  );
  expect(binding.membershipId).toBe(grant.membershipId);
  expect(binding.authorityScope).not.toBe("provider");
  const checks = transactions[transactions.length - 1]
    .filter((write) => write.ConditionCheck)
    .map((write) => write.ConditionCheck);
  expect(
    checks.some(
      (check) =>
        check.Key.pk === "PROVIDER#provider-1" &&
        check.ConditionExpression.includes("generation"),
    ),
  ).toBe(true);
  expect(
    checks.some(
      (check) =>
        check.Key.sk === "#META" &&
        check.ConditionExpression.includes("siteCredentialGeneration"),
    ),
  ).toBe(true);
});

it("preserves direct site managers' team invitations but denies manager invitations", async () => {
  Object.assign(issuer(), {
    authorityScope: "site",
    membershipId: "existing",
    membershipGeneration: 1,
  });
  const denied = await issue("manager", {
    firstName: "New",
    lastName: "Manager",
    email: "new@example.org",
  });
  expect(denied.statusCode).toBe(403);
  expect(transactions).toHaveLength(0);
  const response = await issue();
  expect(response.statusCode).toBe(201);
  expect((await redeem(response)).statusCode).toBe(201);
});

it.each([
  {},
  { firstName: "New", lastName: "Manager", email: "invalid" },
  { firstName: "", lastName: "Manager", email: "new@example.org" },
])("requires valid named-manager contact details: %j", async (contact) => {
  expect((await issue("manager", contact)).statusCode).toBe(400);
  expect(transactions).toHaveLength(0);
});

it.each(["general", "manager"])(
  "rechecks provider authority at redemption for %s invitations",
  async (role) => {
    const response = await issue(role, {
      firstName: "New",
      lastName: "Manager",
      email: "new@example.org",
    });
    providerMember().generation++;
    const writes = transactions.length;
    expect((await redeem(response)).statusCode).toBe(403);
    expect(transactions).toHaveLength(writes);
  },
);

it.each([
  "provider transfer",
  "site reassignment",
  "credential rotation",
  "revoked issuer",
  "expired issuer",
])("rejects changed access: %s", async (change) => {
  const response = await issue();
  if (change === "provider transfer") providerMember().status = "inactive";
  if (change === "site reassignment") site().providerAccessGeneration++;
  if (change === "credential rotation") site().siteCredentialGeneration++;
  if (change === "revoked issuer") issuer().status = "revoked";
  if (change === "expired issuer")
    issuer().absoluteExpiresAt = "2000-01-01T00:00:00Z";
  expect((await redeem(response)).statusCode).toBe(403);
});

it("rejects older malformed provider invitations instead of bypassing membership checks", async () => {
  const response = await issue();
  const grant = grantFrom(response);
  delete grant.issuerAuthorityScope;
  expect((await redeem(response)).statusCode).toBe(403);
});

it("exposes the manager-invitation capability only for provider bindings", async () => {
  expect(
    data(await call(getCurrentStaffGrant, event())).canInviteManagers,
  ).toBe(true);
  issuer().authorityScope = "site";
  expect(
    data(await call(getCurrentStaffGrant, event())).canInviteManagers,
  ).toBe(false);
});

it("derives invitation scope from the authenticated binding, not body fields", async () => {
  const response = await issue("general", {
    siteId: "other-site",
    issuerProviderId: "other-provider",
    issuerProviderMembershipGeneration: 999,
  });
  expect(response.statusCode).toBe(201);
  expect(grantFrom(response)).toMatchObject({
    siteId: "site-1",
    issuerProviderId: "provider-1",
    issuerProviderMembershipGeneration: 4,
  });
});
it("rejects unsupported roles without creating an assignment or grant", async () => {
  expect((await issue("supervisor")).statusCode).toBe(400);
  expect(transactions).toHaveLength(0);
});

function targetDevice() {
  const binding = {
    pk: "SITE#site-1",
    sk: "DEVICE_BINDING#target",
    bindingId: "target",
    physicalDeviceId: "physical-target",
    accessLevel: "manager",
    authorityScope: "site",
    status: "active",
    tokenGeneration: 2,
  };
  save(binding);
  save({ ...binding, sk: "DEVICE#target" });
  return { ...event(), pathParameters: { bindingId: "target" } };
}
it("provider managers revoke site manager devices with transactional authority checks", async () => {
  const response = await call(revokeGeneralBinding, targetDevice());
  expect(response.statusCode).toBe(200);
  expect(data(response).binding).toMatchObject({
    accessLevel: "manager",
    status: "revoked",
    tokenGeneration: 3,
  });
  const writes = transactions.at(-1) || [];
  expect(writes.filter((w) => w.ConditionCheck)).toHaveLength(3);
  expect(writes.filter((w) => w.Update)).toHaveLength(3);
  expect(writes.find((w) => w.Put)?.Put.Item.eventType).toBe(
    "manager_binding_revoked",
  );
});
it.each(["site", "expired", "membership", "provider"])(
  "rejects invalid provider authority: %s",
  async (reason) => {
    const request = targetDevice();
    if (reason === "site") issuer().authorityScope = "site";
    if (reason === "expired")
      issuer().absoluteExpiresAt = "2000-01-01T00:00:00Z";
    if (reason === "membership") providerMember().status = "revoked";
    if (reason === "provider") site().providerId = "another-provider";
    expect((await call(revokeGeneralBinding, request)).statusCode).toBe(403);
    expect(transactions).toHaveLength(0);
  },
);
it("fails closed if provider authority changes before revocation commits", async () => {
  const request = targetDevice();
  const original = send.getMockImplementation();
  send.mockImplementation(async (command) => {
    if (command instanceof TransactWriteCommand)
      throw Object.assign(new Error("conflict"), {
        name: "TransactionCanceledException",
      });
    if (!original) throw new Error("Missing mock implementation");
    return original(command);
  });
  expect((await call(revokeGeneralBinding, request)).statusCode).toBe(409);
});

it("does not allow this site-device endpoint to revoke provider manager authority", async () => {
  const request = targetDevice();
  rows.get("SITE#site-1|DEVICE_BINDING#target").authorityScope = "provider";
  expect((await call(revokeGeneralBinding, request)).statusCode).toBe(403);
  expect(transactions).toHaveLength(0);
});
it("does not resolve a target outside the current site", async () => {
  const request = targetDevice();
  rows.delete("SITE#site-1|DEVICE_BINDING#target");
  expect((await call(revokeGeneralBinding, request)).statusCode).toBe(404);
  expect(transactions).toHaveLength(0);
});
