import { beforeEach, expect, it, vi } from "vitest";
import {
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../db.js", () => ({ ddb: { send } }));
const { cancelPendingSiteGrants } = await import("./pending-site-grants.js");

const context = {
  actor: "admin-1",
  now: "2026-11-25T12:00:00.000Z",
  operationId: "operation-1",
};

/** @param {string} name @param {string} [message] */
const awsError = (name, message = name) =>
  Object.assign(new Error(message), { name });

/**
 * Answer the two grant queries; record every write.
 * @param {{ manager?: any[], staff?: any[] }} grants
 * @param {(command: any) => unknown} [onWrite]
 */
function table({ manager = [], staff = [] }, onWrite = () => ({})) {
  send.mockImplementation(async (/** @type {any} */ command) => {
    if (command instanceof QueryCommand) {
      const prefix = /** @type {any} */ (command).input
        .ExpressionAttributeValues[":prefix"];
      return { Items: prefix === "MANAGER_GRANT#" ? manager : staff };
    }
    return onWrite(command);
  });
}

/** Every non-query command sent, as untyped test doubles. @returns {any[]} */
const writes = () =>
  send.mock.calls
    .map(([command]) => command)
    .filter((command) => !(command instanceof QueryCommand));

/**
 * Plain boolean (not a type guard), so test doubles stay untyped.
 * @param {unknown} command @returns {boolean}
 */
const isTransaction = (command) => command instanceof TransactWriteCommand;
/** @param {unknown} command @returns {boolean} */
const isUpdate = (command) => command instanceof UpdateCommand;

beforeEach(() => send.mockReset());

it("cancels each pending manager, recovery and staff grant with its lookups", async () => {
  table({
    manager: [
      {
        pk: "SITE#site-1",
        sk: "MANAGER_GRANT#t#admin-grant",
        grantId: "admin-grant",
        membershipId: "m-1",
        status: "pending",
        tokenHash: "token-a",
        codeHash: "code-a",
      },
      {
        pk: "SITE#site-1",
        sk: "MANAGER_GRANT#t#recovery-grant",
        grantId: "recovery-grant",
        membershipId: "m-2",
        issuedBy: "manager-email-recovery",
        status: "pending",
        tokenHash: "token-b",
      },
      { sk: "MANAGER_GRANT#t#used", grantId: "used", status: "redeemed" },
    ],
    staff: [
      {
        pk: "SITE#site-1",
        sk: "STAFF_GRANT#t#staff-grant",
        grantId: "staff-grant",
        status: "pending",
        tokenHash: "token-c",
      },
    ],
  });

  const result = await cancelPendingSiteGrants("table", "site-1", context);

  expect(result).toEqual({ cancelledCount: 3, failedCount: 0 });
  const transactions = writes().filter(isTransaction);
  // Three cancellations plus one audit entry; the redeemed grant is untouched.
  expect(transactions).toHaveLength(4);
  const byGrant = Object.fromEntries(
    transactions
      .filter((command) => command.input.TransactItems[0].Update)
      .map((command) => [
        command.input.TransactItems[0].Update.Key.sk,
        command.input.TransactItems,
      ]),
  );
  const admin = byGrant["MANAGER_GRANT#t#admin-grant"];
  expect(admin[0].Update.ExpressionAttributeValues).toMatchObject({
    ":cancelled": "cancelled",
    ":reason": "site_revocation",
  });
  expect(
    admin.map(
      (/** @type {any} */ item) => item.Update?.Key.pk ?? item.Delete?.Key.sk,
    ),
  ).toEqual([
    "SITE#site-1",
    "ENROLLMENT_TOKEN#token-a",
    "ENROLLMENT_TOKEN#code-a",
    "MANAGER_GRANT_CURRENT#m-1",
  ]);
  expect(byGrant["MANAGER_GRANT#t#recovery-grant"].at(-1).Delete.Key.sk).toBe(
    "MANAGER_RECOVERY_GRANT_CURRENT#m-2",
  );
  // Staff grants have no per-membership pointer.
  expect(
    byGrant["STAFF_GRANT#t#staff-grant"].some(
      (/** @type {any} */ item) => item.Delete,
    ),
  ).toBe(false);
  const audit = transactions.at(-1).input.TransactItems[0].Put.Item;
  expect(audit).toMatchObject({
    eventType: "pending_grants_cancelled_by_revocation",
    cancelledCount: 3,
    operationId: "operation-1",
  });
});

it("still cancels the grant itself when its lookups are already gone", async () => {
  table(
    {
      staff: [
        {
          pk: "SITE#site-1",
          sk: "STAFF_GRANT#t#g",
          grantId: "g",
          status: "pending",
          tokenHash: "gone",
        },
      ],
    },
    (command) => {
      if (isTransaction(command) && command.input.TransactItems[0].Update)
        throw awsError("TransactionCanceledException");
      return {};
    },
  );

  const result = await cancelPendingSiteGrants("table", "site-1", context);

  expect(result).toEqual({ cancelledCount: 1, failedCount: 0 });
  const fallback = writes().find(isUpdate);
  expect(fallback.input.Key).toEqual({
    pk: "SITE#site-1",
    sk: "STAFF_GRANT#t#g",
  });
  expect(fallback.input.ConditionExpression).toBe("#status = :pending");
});

it("doesn't count a grant redeemed meanwhile as a failure", async () => {
  table(
    {
      staff: [
        {
          pk: "SITE#site-1",
          sk: "STAFF_GRANT#t#g",
          grantId: "g",
          status: "pending",
        },
      ],
    },
    (command) => {
      if (command instanceof TransactWriteCommand)
        throw awsError("TransactionCanceledException");
      if (command instanceof UpdateCommand)
        throw awsError("ConditionalCheckFailedException");
      return {};
    },
  );

  expect(await cancelPendingSiteGrants("table", "site-1", context)).toEqual({
    cancelledCount: 0,
    failedCount: 0,
  });
  // No audit entry when nothing was cancelled.
  expect(writes().filter(isTransaction)).toHaveLength(1);
});

it("reports a grant it couldn't cancel, and logs it without ids", async () => {
  const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  table(
    {
      staff: [
        {
          pk: "SITE#site-1",
          sk: "STAFF_GRANT#t#g",
          grantId: "g",
          status: "pending",
        },
      ],
    },
    (command) => {
      if (command instanceof TransactWriteCommand)
        throw awsError("TransactionCanceledException");
      if (command instanceof UpdateCommand)
        throw awsError("ProvisionedThroughputExceededException");
      return {};
    },
  );

  expect(await cancelPendingSiteGrants("table", "site-1", context)).toEqual({
    cancelledCount: 0,
    failedCount: 1,
  });
  const logged = JSON.stringify(errorLog.mock.calls);
  expect(logged).toContain("PendingGrantCancelFailed");
  expect(logged).not.toContain("STAFF_GRANT");
  errorLog.mockRestore();
});
