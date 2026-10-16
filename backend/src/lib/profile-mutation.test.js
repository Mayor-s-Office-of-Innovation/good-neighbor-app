import { beforeEach, expect, it, vi } from "vitest";
import { withProfileMutation } from "./profile-mutation.js";
const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../db.js", () => ({ ddb: { send } }));
const journal = {
  pool: "pool",
  username: "caller",
  attributes: { given_name: "Old", family_name: "Name", name: "Old Name" },
  directoryKey: { pk: "DIRECTORY", sk: "caller" },
};
/** @type {any} */
let lock;
/** @type {any} */
let directory;
let failRepair = false;
/** @type {any} */
let restored;
/** @type {any} */
let deleted;
const cognito = { send: vi.fn() };
beforeEach(() => {
  lock = undefined;
  directory = {
    firstName: "Old",
    lastName: "Name",
    name: "Old Name",
    cognitoSubject: "subject",
  };
  failRepair = false;
  restored = undefined;
  deleted = undefined;
  vi.stubEnv("DYNAMO_TABLE", "test");
  send.mockReset();
  send.mockImplementation(async (command) => {
    const input = command.input;
    if (command.constructor.name === "GetCommand") return { Item: directory };
    if (command.constructor.name === "DeleteCommand") {
      expect(input.ExpressionAttributeValues[":token"]).toBe(lock.token);
      lock = undefined;
      return {};
    }
    if (input.ReturnValues === "ALL_OLD") {
      if (lock?.leaseUntil >= Date.now())
        throw Object.assign(new Error("locked"), {
          name: "ConditionalCheckFailedException",
        });
      const previous = lock;
      lock = {
        ...lock,
        token: input.ExpressionAttributeValues[":token"],
        leaseUntil: input.ExpressionAttributeValues[":until"],
      };
      return { Attributes: previous };
    }
    expect(input.ExpressionAttributeValues[":token"]).toBe(lock.token);
    if (input.UpdateExpression.includes("recovery"))
      lock.recovery = input.ExpressionAttributeValues[":recovery"];
    else lock.leaseUntil = 0;
    return {};
  });
  cognito.send.mockReset();
  cognito.send.mockImplementation(async (command) => {
    if (command.constructor.name === "AdminGetUserCommand")
      return { UserAttributes: [{ Name: "sub", Value: "subject" }] };
    if (failRepair) throw new Error("Cognito unavailable");
    if (command.constructor.name === "AdminDeleteUserAttributesCommand")
      deleted = command.input.UserAttributeNames;
    else restored = command.input.UserAttributes;
    return {};
  });
});

it("compensates a failed conditional directory update using the persisted names", async () => {
  await expect(
    withProfileMutation("subject", cognito, async (prepare) => {
      await prepare(journal);
      throw Object.assign(new Error("directory conflict"), {
        name: "ConditionalCheckFailedException",
      });
    }),
  ).rejects.toThrow("directory conflict");
  expect(restored).toContainEqual({ Name: "given_name", Value: "Old" });
  expect(lock).toBeUndefined();
});

it("reconciles an ambiguously committed write to current directory names", async () => {
  await expect(
    withProfileMutation("subject", cognito, async (prepare) => {
      await prepare(journal);
      directory = { ...directory, firstName: "New", name: "New Name" };
      throw new Error("response lost");
    }),
  ).rejects.toThrow("response lost");
  expect(restored).toContainEqual({ Name: "given_name", Value: "New" });
  expect(lock).toBeUndefined();
});

it("retains failed compensation durably and repairs it before the next operation", async () => {
  failRepair = true;
  const response = await withProfileMutation(
    "subject",
    cognito,
    async (prepare) => {
      await prepare(journal);
      throw new Error("write failed");
    },
  );
  expect(response.statusCode).toBe(503);
  expect(lock).toMatchObject({ recovery: journal, leaseUntil: 0 });
  failRepair = false;
  await withProfileMutation("subject", cognito, async () => {
    expect(restored).toContainEqual({ Name: "given_name", Value: "Old" });
  });
  expect(lock).toBeUndefined();
});

it("does not let concurrent requests mutate or release an active operation's lock", async () => {
  let release = () => {};
  let started = () => {};
  const ready = new Promise(
    /** @param {(value?: any) => void} resolve */ (resolve) => {
      started = resolve;
    },
  );
  const active = withProfileMutation("subject", cognito, async () => {
    started();
    await new Promise((resolve) => {
      release = () => resolve(undefined);
    });
  });
  await ready;
  const action = vi.fn();
  const blocked = await withProfileMutation("subject", cognito, action);
  expect(blocked.statusCode).toBe(409);
  expect(action).not.toHaveBeenCalled();
  expect(lock).toBeDefined();
  release();
  await active;
  expect(lock).toBeUndefined();
});

it("recovers an expired invocation journal before accepting another edit", async () => {
  lock = { token: "old", leaseUntil: 0, recovery: journal };
  await withProfileMutation("subject", cognito, async () => {
    expect(restored).toContainEqual({ Name: "name", Value: "Old Name" });
  });
  expect(lock).toBeUndefined();
});

it("restores absent Cognito name attributes by removing them", async () => {
  directory = undefined;
  lock = {
    token: "old",
    leaseUntil: 0,
    recovery: { ...journal, attributes: {} },
  };
  await withProfileMutation("subject", cognito, async () => {});
  expect(deleted).toEqual(["given_name", "family_name", "name"]);
});

it("never repairs a deleted and recreated Cognito identity", async () => {
  lock = { token: "old", leaseUntil: 0, recovery: journal };
  cognito.send.mockResolvedValue({
    UserAttributes: [{ Name: "sub", Value: "someone-else" }],
  });
  const action = vi.fn();
  expect(
    (await withProfileMutation("subject", cognito, action)).statusCode,
  ).toBe(503);
  expect(action).not.toHaveBeenCalled();
  expect(lock.recovery).toEqual(journal);
  expect(restored).toBeUndefined();
});
