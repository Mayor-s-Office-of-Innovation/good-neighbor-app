import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../db.js", () => ({ ddb: { send } }));

const {
  cancelStaffGrant,
  createStaffGrant,
  getCurrentStaffGrant,
  listGeneralBindings,
  revokeGeneralBinding,
} = await import("./manager-access.js");

beforeEach(() => {
  send.mockReset();
  vi.stubEnv("DYNAMO_TABLE", "gnp-test-app");
  vi.stubEnv("PROVIDER_APP_URL", "https://field.example.test/");
});

describe("manager staff enrollment", () => {
  it("issues another eight-hour grant while one is pending without storing its secret", async () => {
    send
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Item: { siteId: "site-1", name: "Site One" } })
      .mockResolvedValueOnce({
        Item: {
          pk: "SITE#site-1",
          sk: "DEVICE_BINDING#manager-1",
          status: "active",
          accessLevel: "manager",
          membershipId: "membership-1",
          membershipGeneration: 2,
          tokenGeneration: 4,
        },
      })
      .mockResolvedValueOnce({
        Items: [
          {
            grantId: "already-pending",
            issuedByBindingId: "manager-1",
            status: "pending",
          },
        ],
      })
      .mockResolvedValueOnce({});

    const response = await call(
      createStaffGrant,
      event({ body: { label: "Front desk tablet" } }),
    );
    expect(response.statusCode).toBe(201);
    const body = JSON.parse(String(response.body));
    expect(body.grant).toMatchObject({
      label: "Front desk tablet",
      accessLevel: "general",
      status: "pending",
    });
    expect(
      Date.parse(body.grant.expiresAt) - Date.parse(body.grant.createdAt),
    ).toBe(8 * 60 * 60 * 1000);
    expect(body.enrollmentUrl).toContain("#enrollment_grant=");
    const transaction = send.mock.calls[4][0];
    expect(transaction).toBeInstanceOf(TransactWriteCommand);
    expect(transaction.input.TransactItems).toHaveLength(5);
    const serialized = JSON.stringify(transaction.input);
    expect(serialized).not.toContain(
      new URL(body.enrollmentUrl).hash.match(/enrollment_token=([^&]+)/)?.[1],
    );
  });

  it("rejects general devices from manager operations", async () => {
    const response = await call(
      createStaffGrant,
      event({ accessLevel: "general", body: { label: "Tablet" } }),
    );
    expect(response.statusCode).toBe(403);
    expect(send).not.toHaveBeenCalled();
  });

  it("returns and cancels only the Manager binding's grants", async () => {
    const marker = {
      pk: "SITE#site-1",
      sk: "ACTIVE_STAFF_GRANT#manager-1",
      grantId: "staff-1",
      grantPk: "SITE#site-1",
      grantSk: "STAFF_GRANT#time#staff-1",
    };
    const grant = {
      pk: marker.grantPk,
      sk: marker.grantSk,
      grantId: "staff-1",
      label: "Team phone",
      issuedByBindingId: "manager-1",
      status: "pending",
      tokenHash: "token-hash",
      createdAt: "2026-10-03T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
    send.mockResolvedValueOnce({ Items: [grant] });
    const current = await call(getCurrentStaffGrant, event());
    expect(current.statusCode).toBe(200);
    expect(JSON.parse(String(current.body)).grants[0]).toMatchObject({
      grantId: "staff-1",
      label: "Team phone",
    });

    send.mockResolvedValueOnce({ Items: [grant] }).mockResolvedValueOnce({});
    const cancelled = await call(
      cancelStaffGrant,
      event({ pathParameters: { grantId: "staff-1" } }),
    );
    expect(cancelled.statusCode).toBe(200);
    const transaction = send.mock.calls.filter(
      ([command]) => command instanceof TransactWriteCommand,
    )[0][0];
    expect(transaction.input.TransactItems).toHaveLength(3);
    expect(transaction.input.TransactItems[1].Delete.Key).toEqual({
      pk: "ENROLLMENT_TOKEN#token-hash",
      sk: "#META",
    });
  });

  it("lists both site roles with their actual access levels", async () => {
    send.mockResolvedValueOnce({
      Items: [
        { bindingId: "general-1", accessLevel: "general", status: "active" },
        { bindingId: "manager-2", accessLevel: "manager", status: "active" },
      ],
    });
    send.mockResolvedValueOnce({
      Responses: {
        "gnp-test-app": [
          {
            deviceId: "general-1",
            status: "active",
            primarySessionKind: "browser",
            lastSeenAt: "2026-10-27T12:00:00Z",
            sessions: {
              home: {
                kind: "home_screen",
                status: "active",
                tokenGeneration: 1,
                refreshJti: "private-jti",
                expiresAt: "2099-01-01T00:00:00Z",
                lastSeenAt: "2026-10-27T13:00:00Z",
              },
            },
          },
        ],
      },
    });
    const response = await call(listGeneralBindings, event());
    expect(response.statusCode).toBe(200);
    expect(send.mock.calls[0][0]).toBeInstanceOf(QueryCommand);
    /** @type {{sessions: {kind: string}[]}[]} */
    const listed = JSON.parse(String(response.body)).bindings;
    expect(listed[0].sessions.map((session) => session.kind)).toEqual([
      "browser",
      "home_screen",
    ]);
    expect(listed[1].sessions).toEqual([]);
    expect(String(response.body)).not.toContain("private-jti");
    expect(String(response.body)).not.toContain("refreshJti");

    expect(JSON.parse(String(response.body)).bindings).toEqual([
      expect.objectContaining({
        bindingId: "general-1",
        accessLevel: "general",
      }),
      expect.objectContaining({
        bindingId: "manager-2",
        accessLevel: "manager",
      }),
    ]);
  });

  it("revokes a general binding, its compatibility row, and its pointer", async () => {
    const binding = {
      pk: "SITE#site-1",
      sk: "DEVICE_BINDING#general-1",
      bindingId: "general-1",
      physicalDeviceId: "physical-1",
      accessLevel: "general",
      status: "active",
      tokenGeneration: 1,
    };
    send
      .mockResolvedValueOnce({ Item: binding })
      .mockResolvedValueOnce({
        Item: {
          ...binding,
          sk: "DEVICE#general-1",
          tokenGeneration: 3,
        },
      })
      .mockResolvedValueOnce({});
    const response = await call(
      revokeGeneralBinding,
      event({ pathParameters: { bindingId: "general-1" } }),
    );
    expect(response.statusCode).toBe(200);
    expect(send.mock.calls[0][0]).toBeInstanceOf(GetCommand);
    const transaction = send.mock.calls[2][0];
    expect(transaction).toBeInstanceOf(TransactWriteCommand);
    expect(transaction.input.TransactItems).toHaveLength(4);
    expect(
      transaction.input.TransactItems[1].Update.ExpressionAttributeValues[
        ":current"
      ],
    ).toBe(3);
  });
});

/** @param {{accessLevel?: string, actorId?: string, body?: unknown, pathParameters?: Record<string, string>}} [options] */
function event(options = {}) {
  return {
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    pathParameters: options.pathParameters,
    requestContext: {
      authorizer: {
        jwt: {
          claims: {
            "custom:siteId": "site-1",
            accessLevel: options.accessLevel ?? "manager",
            sub: options.actorId ?? "manager-1",
          },
        },
      },
    },
  };
}

/** @param {Function} handler @param {any} request */
async function call(handler, request) {
  return /** @type {import("aws-lambda").APIGatewayProxyStructuredResultV2} */ (
    await handler(request, /** @type {any} */ ({}), () => {})
  );
}

it("lists all issuer-owned grant statuses across pages without exposing secrets", async () => {
  const cursor = { pk: "SITE#site-1", sk: "STAFF_GRANT#cursor" };
  send
    .mockResolvedValueOnce({
      Items: [
        {
          grantId: "one",
          issuedByBindingId: "manager-1",
          status: "pending",
          expiresAt: "2099-01-01",
          tokenHash: "secret",
        },
        { grantId: "other", issuedByBindingId: "manager-2", status: "pending" },
      ],
      LastEvaluatedKey: cursor,
    })
    .mockResolvedValueOnce({
      Items: [
        { grantId: "two", issuedByBindingId: "manager-1", status: "redeemed" },
      ],
    });
  const response = await call(getCurrentStaffGrant, event());
  const body = JSON.parse(String(response.body));
  expect(
    body.grants.map((/** @type {{grantId: string}} */ grant) => grant.grantId),
  ).toEqual(["one", "two"]);
  expect(body.grants[1].status).toBe("redeemed");
  expect(response.body).not.toContain("secret");
  expect(send.mock.calls[1][0].input.ExclusiveStartKey).toEqual(cursor);
});

it("does not cancel another manager's grant", async () => {
  send.mockResolvedValueOnce({
    Items: [
      { grantId: "other", issuedByBindingId: "manager-2", status: "pending" },
    ],
  });
  expect(
    (
      await call(
        cancelStaffGrant,
        event({ pathParameters: { grantId: "other" } }),
      )
    ).statusCode,
  ).toBe(404);
  expect(send).toHaveBeenCalledTimes(1);
});

describe("rolling-hour issuance serialization", () => {
  /** A small transactional DDB substitute: queries snapshot each page and the
   * version condition is checked atomically before any grant write.
   * @param {Array<Record<string, any>>} initial
   */
  function store(initial) {
    const grants = [...initial];
    /** @type {string | undefined} */
    let version;
    let conflicts = 0;
    send.mockImplementation(async (command) => {
      const input = command.input;
      if (command instanceof GetCommand) {
        if (input.Key.sk === "STAFF_GRANT_ISSUANCE#VERSION")
          return { Item: version === undefined ? undefined : { version } };
        if (input.Key.sk === "#META") return { Item: { siteId: "site-1" } };
        return {
          Item: { ...input.Key, status: "active", accessLevel: "manager" },
        };
      }
      if (command instanceof QueryCommand) {
        expect(input.ConsistentRead).toBe(true);
        const start = input.ExpressionAttributeValues[":start"];
        const recent = grants.filter((grant) => grant.sk >= start);
        const offset = input.ExclusiveStartKey?.offset ?? 0;
        return {
          Items: recent.slice(offset, offset + 10),
          ...(offset + 10 < recent.length
            ? { LastEvaluatedKey: { offset: offset + 10 } }
            : {}),
        };
      }
      const guard = input.TransactItems[3].Put;
      const expected = guard.ExpressionAttributeValues?.[":version"];
      if (expected !== version) {
        conflicts++;
        throw Object.assign(new Error("competing issuance"), {
          name: "TransactionCanceledException",
          CancellationReasons: [
            {},
            {},
            {},
            { Code: "ConditionalCheckFailed" },
            {},
          ],
        });
      }
      version = guard.Item.version;
      grants.push(input.TransactItems[0].Put.Item);
      return {};
    });
    return { grants, conflicts: () => conflicts };
  }

  /** @param {number} count @param {(index: number) => string} issuer */
  function recentGrants(count, issuer) {
    const createdAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    return Array.from({ length: count }, (_, index) => ({
      sk: `STAFF_GRANT#${createdAt}#${index}`,
      issuedByBindingId: issuer(index),
      status: index % 2 ? "redeemed" : "cancelled",
    }));
  }

  it.each(["manager", "site"])(
    "admits only the final available grant under concurrent %s issuance",
    async (scope) => {
      const state = store(
        recentGrants(scope === "manager" ? 24 : 39, (index) =>
          scope === "manager" ? "manager-1" : `manager-${index % 3}`,
        ),
      );
      const results = await Promise.all(
        ["manager-1", scope === "manager" ? "manager-1" : "manager-2"].map(
          (actorId) =>
            call(
              createStaffGrant,
              event({ actorId, body: { label: "Tablet" } }),
            ),
        ),
      );
      expect(results.map((result) => result.statusCode).sort()).toEqual([
        201, 429,
      ]);
      expect(
        JSON.parse(
          String(results.find((result) => result.statusCode === 429)?.body),
        ).error,
      ).toBe(`${scope}_grant_rate_limited`);
      expect(state.conflicts()).toBe(1);
      expect(state.grants).toHaveLength(scope === "manager" ? 25 : 40);
    },
  );

  it("counts later pages and terminal statuses before issuing with a new guard", async () => {
    store(recentGrants(25, () => "manager-1"));
    const result = await call(
      createStaffGrant,
      event({ body: { label: "Tablet" } }),
    );
    expect(result.statusCode).toBe(429);
    expect(
      send.mock.calls.filter(([command]) => command instanceof QueryCommand),
    ).toHaveLength(3);
    expect(
      send.mock.calls.some(
        ([command]) => command instanceof TransactWriteCommand,
      ),
    ).toBe(false);
  });

  it("excludes issuances older than the rolling hour", async () => {
    const old = recentGrants(25, () => "manager-1").map((grant, index) => ({
      ...grant,
      sk: `STAFF_GRANT#${new Date(Date.now() - 61 * 60 * 1000).toISOString()}#${index}`,
    }));
    store(old);
    expect(
      (await call(createStaffGrant, event({ body: { label: "Tablet" } })))
        .statusCode,
    ).toBe(201);
  });

  it("keeps the previous clock hour in the rolling window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-22T18:01:00Z"));
    try {
      store(recentGrants(25, () => "manager-1"));
      expect(
        (await call(createStaffGrant, event({ body: { label: "Tablet" } })))
          .statusCode,
      ).toBe(429);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds retries without reporting contention as rate limiting", async () => {
    store([]);
    const implementation = send.getMockImplementation();
    send.mockImplementation(async (command) => {
      if (command instanceof TransactWriteCommand) {
        throw Object.assign(new Error("conflict"), {
          name: "TransactionCanceledException",
          CancellationReasons: [{ Code: "TransactionConflict" }],
        });
      }
      return implementation?.(command);
    });
    expect(
      (await call(createStaffGrant, event({ body: { label: "Tablet" } })))
        .statusCode,
    ).toBe(409);
    expect(
      send.mock.calls.filter(
        ([command]) => command instanceof TransactWriteCommand,
      ),
    ).toHaveLength(5);
  });

  it("does not retry a revoked issuer condition", async () => {
    store([]);
    const implementation = send.getMockImplementation();
    send.mockImplementation(async (command) => {
      if (command instanceof TransactWriteCommand) {
        throw Object.assign(new Error("revoked"), {
          name: "TransactionCanceledException",
          CancellationReasons: [{}, {}, { Code: "ConditionalCheckFailed" }],
        });
      }
      return implementation?.(command);
    });
    expect(
      (await call(createStaffGrant, event({ body: { label: "Tablet" } })))
        .statusCode,
    ).toBe(403);
    expect(
      send.mock.calls.filter(
        ([command]) => command instanceof TransactWriteCommand,
      ),
    ).toHaveLength(1);
  });
});
