import { QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ send: vi.fn(), sendEmail: vi.fn() }));
vi.mock("../db.js", () => ({ ddb: { send: mocks.send } }));
vi.mock("../integrations/email.js", () => ({
  sendManagerAccessEmail: mocks.sendEmail,
}));

const { requestManagerAccess } = await import("./manager-access-requests.js");
const generic = {
  message:
    "If that email is authorized, enrollment instructions will arrive shortly.",
};

beforeEach(() => {
  mocks.send.mockReset();
  mocks.sendEmail.mockReset();
  vi.stubEnv("DYNAMO_TABLE", "gnp-test-app");
  vi.stubEnv("SETUP_CODE_VERIFIER_SECRET", "test-verifier-secret");
  vi.stubEnv("PROVIDER_APP_URL", "https://field.example.test/");
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(globalThis, "setTimeout").mockImplementation((callback) => {
    callback();
    return /** @type {any} */ (0);
  });
});

afterEach(() => vi.restoreAllMocks());

describe("public Manager access recovery", () => {
  it("returns the same generic response for an unknown email", async () => {
    mocks.send.mockResolvedValueOnce({}).mockResolvedValueOnce({ Items: [] });
    const response = await call("unknown@example.org");
    expect(response.statusCode).toBe(202);
    expect(JSON.parse(String(response.body))).toEqual(generic);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.send.mock.calls[0][0]).toBeInstanceOf(TransactWriteCommand);
    expect(mocks.send.mock.calls[1][0]).toBeInstanceOf(QueryCommand);
  });

  it("issues one single-Site link per active membership in one email", async () => {
    mocks.send
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        Items: [{ siteId: "site-1", membershipId: "membership-1" }],
      })
      .mockResolvedValueOnce({
        Item: { siteId: "site-1", name: "Site One", status: "active" },
      })
      .mockResolvedValueOnce({
        Item: {
          membershipId: "membership-1",
          name: "Alex Rivera",
          email: "alex@example.org",
          emailHash: await verifier("alex@example.org"),
          status: "active",
        },
      })
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});
    mocks.sendEmail.mockResolvedValue({ provider: "ses", messageId: "msg-1" });

    const response = await call("alex@example.org");
    expect(response.statusCode).toBe(202);
    expect(JSON.parse(String(response.body))).toEqual(generic);
    expect(mocks.sendEmail).toHaveBeenCalledOnce();
    const links = mocks.sendEmail.mock.calls[0][0].links;
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ siteName: "Site One" });
    expect(links[0].enrollmentUrl).toContain("#enrollment_grant=");
    const transaction = mocks.send.mock.calls[6][0];
    expect(transaction).toBeInstanceOf(TransactWriteCommand);
    expect(JSON.stringify(response)).not.toContain("enrollment_token");
  });

  it("keeps an unredeemed administrator invitation when issuing recovery", async () => {
    const adminGrant = {
      pk: "SITE#site-1",
      sk: "MANAGER_GRANT#2026-10-06T00:00:00.000Z#admin-grant",
      grantId: "admin-grant",
      membershipId: "membership-1",
      issuedBy: "admin@example.org",
      tokenHash: "admin-token-hash",
      status: "pending",
      expiresAt: "2999-10-06T00:15:00.000Z",
    };
    mocks.send
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        Items: [{ siteId: "site-1", membershipId: "membership-1" }],
      })
      .mockResolvedValueOnce({
        Item: { siteId: "site-1", name: "Site One", status: "active" },
      })
      .mockResolvedValueOnce({
        Item: {
          membershipId: "membership-1",
          name: "Alex Rivera",
          email: "alex@example.org",
          emailHash: await verifier("alex@example.org"),
          status: "active",
        },
      })
      .mockResolvedValueOnce({ Items: [adminGrant] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});
    mocks.sendEmail.mockResolvedValue({ provider: "ses", messageId: "msg-1" });

    await call("alex@example.org");

    const transaction = mocks.send.mock.calls[6][0];
    const writes = transaction.input.TransactItems;
    expect(
      writes.some(
        /** @param {any} write */
        (write) =>
          write.Update?.Key?.sk === adminGrant.sk ||
          write.Delete?.Key?.pk === "ENROLLMENT_TOKEN#admin-token-hash",
      ),
    ).toBe(false);
    expect(
      writes.some(
        /** @param {any} write */
        (write) =>
          write.Put?.Item?.sk === "MANAGER_RECOVERY_GRANT_CURRENT#membership-1",
      ),
    ).toBe(true);
  });

  it("silently absorbs an email rate limit without looking up memberships", async () => {
    const limited = cancellation("ConditionalCheckFailed", "None");
    mocks.send.mockRejectedValueOnce(limited);
    const response = await call("alex@example.org");
    expect(response.statusCode).toBe(202);
    expect(JSON.parse(String(response.body))).toEqual(generic);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(
      JSON.stringify({
        marker: "ManagerAccessThrottled",
        limitedBy: "email_hour",
      }),
    );
  });

  it("acquires the existing hourly and cooldown guards in one transaction", async () => {
    mocks.send.mockResolvedValue({ Items: [] });
    await call("alex@example.org");
    const writes = mocks.send.mock.calls[0][0].input.TransactItems;
    const hash = await verifier("alex@example.org");
    expect(writes).toHaveLength(2);
    expect(writes[0].Update).toMatchObject({
      Key: { pk: `MANAGER_ACCESS_RATE#EMAIL#${hash}` },
      ConditionExpression:
        "attribute_not_exists(requestCount) OR requestCount < :limit",
      ExpressionAttributeValues: { ":limit": 3, ":one": 1 },
    });
    expect(writes[1].Put).toMatchObject({
      Item: { pk: `MANAGER_ACCESS_REQUEST#${hash}`, sk: "#COOLDOWN" },
      ConditionExpression: "attribute_not_exists(pk) OR nextAllowedAt <= :now",
    });
    const cooldown = writes[1].Put.Item;
    expect(
      Date.parse(cooldown.nextAllowedAt) - Date.parse(cooldown.requestedAt),
    ).toBe(15 * 60 * 1000);
  });

  it("absorbs repeated cooldown clicks without separate counter writes or delivery", async () => {
    mocks.send.mockRejectedValue(
      cancellation("None", "ConditionalCheckFailed"),
    );
    for (let click = 0; click < 4; click++) {
      const response = await call("alex@example.org");
      expect(response.statusCode).toBe(202);
      expect(JSON.parse(String(response.body))).toEqual(generic);
    }
    expect(
      mocks.send.mock.calls.every(
        ([command]) => command instanceof TransactWriteCommand,
      ),
    ).toBe(true);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(
      JSON.stringify({
        marker: "ManagerAccessThrottled",
        limitedBy: "email_cooldown",
      }),
    );
  });

  it("only allows the winning concurrent request to look up memberships", async () => {
    let acquired = false;
    mocks.send.mockImplementation(async (command) => {
      if (command instanceof QueryCommand) return { Items: [] };
      if (acquired) throw cancellation("None", "ConditionalCheckFailed");
      acquired = true;
      return {};
    });
    const responses = await Promise.all([
      call("alex@example.org"),
      call("alex@example.org"),
    ]);
    expect(responses.map((response) => response.statusCode)).toEqual([
      202, 202,
    ]);
    expect(
      mocks.send.mock.calls.filter(
        ([command]) => command instanceof QueryCommand,
      ),
    ).toHaveLength(1);
  });

  it.each([
    cancellation("TransactionConflict", "None"),
    Object.assign(new Error("database unavailable"), {
      name: "ServiceUnavailable",
    }),
    Object.assign(new Error("missing cancellation reasons"), {
      name: "TransactionCanceledException",
    }),
  ])(
    "fails closed on database errors without misreporting throttling: $name",
    async (error) => {
      mocks.send.mockRejectedValueOnce(error);
      await expect(call("alex@example.org")).rejects.toBe(error);
      expect(mocks.send).toHaveBeenCalledTimes(1);
      expect(mocks.sendEmail).not.toHaveBeenCalled();
      expect(console.warn).not.toHaveBeenCalled();
    },
  );
});

/** @param {string} email */
async function call(email) {
  return /** @type {Promise<any>} */ (
    requestManagerAccess(
      /** @type {any} */ ({
        body: JSON.stringify({ email }),
        requestContext: { http: { sourceIp: "203.0.113.9" } },
      }),
      /** @type {any} */ ({}),
      () => {},
    )
  );
}

/** @param {string} email */
async function verifier(email) {
  const { emailHash } = await import("./setup-codes.js");
  return emailHash(email);
}

/**
 * @param {string} hourly
 * @param {string} cooldown
 * @returns {Error & {CancellationReasons: {Code: string}[]}} DynamoDB cancellation.
 */
function cancellation(hourly, cooldown) {
  return Object.assign(new Error("transaction cancelled"), {
    name: "TransactionCanceledException",
    CancellationReasons: [{ Code: hourly }, { Code: cooldown }],
  });
}
