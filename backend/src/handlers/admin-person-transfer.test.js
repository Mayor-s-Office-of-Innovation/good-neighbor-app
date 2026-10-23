import { beforeEach, expect, it, vi } from "vitest";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../db.js", () => ({ ddb: { send } }));
const { transferProviderManager } = await import(
  "./admin-provider-managers.js"
);
beforeEach(() => {
  send.mockReset();
  vi.stubEnv("DYNAMO_TABLE", "test");
});
const event = (role = "compliance-supervisor") => ({
  body: JSON.stringify({ providerId: "new" }),
  pathParameters: { providerId: "old", membershipId: "m" },
  requestContext: {
    authorizer: { jwt: { claims: { sub: "actor", "cognito:groups": [role] } } },
  },
});
it.each([3, undefined])(
  "transfers provider authority with generation %s, retaining identity and requiring fresh enrollment",
  async (generation) => {
    const manager = {
      pk: "PROVIDER#old",
      sk: "PROVIDER_MANAGER#m",
      providerId: "old",
      membershipId: "m",
      personId: "person",
      ...(generation === undefined ? {} : { generation }),
      status: "active",
      email: "a@example.org",
    };
    send.mockImplementation(async (command) => {
      if (command.input.Key?.pk === "PEOPLE")
        return {
          Item: {
            personId: "person",
            pk: "PEOPLE",
            sk: "PERSON#person",
            revision: "v1",
            sources: [{ pk: manager.pk, sk: manager.sk }],
            primaryProviderId: "old",
          },
        };
      if (command.input.Key?.pk === "PROVIDER#new")
        return { Item: { status: "active", name: "New" } };
      return { Items: [manager] };
    });
    const result = /** @type {any} */ (
      await transferProviderManager(
        /** @type {any} */ (event()),
        /** @type {any} */ ({}),
        () => {},
      )
    );
    expect(result.statusCode).toBe(200);
    const items = /** @type {any[]} */ (
      send.mock.calls.find(([c]) => c instanceof TransactWriteCommand)?.[0]
        .input.TransactItems
    );
    const old = items.find((i) => i.Put?.Item?.sk === manager.sk).Put.Item;
    expect(old.status).toBe("inactive");
    expect(old.generation).toBe(generation === undefined ? 2 : 4);
    const condition = items.find((i) => i.Put?.Item?.sk === manager.sk).Put;
    expect(condition.ConditionExpression).toBe(
      generation === undefined
        ? "#status = :active AND attribute_not_exists(generation)"
        : "#status = :active AND generation = :generation",
    );
    expect(condition.ExpressionAttributeValues).toEqual(
      generation === undefined
        ? { ":active": "active" }
        : { ":active": "active", ":generation": generation },
    );
    const next = JSON.parse(result.body).manager;
    expect(next.personId).toBe("person");
    expect(next.membershipId).not.toBe("m");
    expect(JSON.stringify(items)).not.toContain("DEVICE_BINDING#");
    expect(JSON.stringify(items)).not.toContain("MANAGER_MEMBERSHIP#");
  },
);
it("denies provider transfer to compliance managers before reading records", async () => {
  const result = /** @type {any} */ (
    await transferProviderManager(
      /** @type {any} */ (event("compliance-manager")),
      /** @type {any} */ ({}),
      () => {},
    )
  );
  expect(result.statusCode).toBe(403);
  expect(send).not.toHaveBeenCalled();
});
