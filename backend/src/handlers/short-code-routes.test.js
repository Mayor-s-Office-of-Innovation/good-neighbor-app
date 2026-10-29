import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../db.js", () => ({ ddb: { send } }));
const { handler: lookup } = await import("./site-code.js");
const { registerDevice } = await import("./devices.js");
const { redeemEnrollmentGrant } = await import("./enrollment.js");

let count = 0;
let credentialReads = 0;
beforeEach(() => {
  count = 0;
  credentialReads = 0;
  vi.stubEnv("DYNAMO_TABLE", "synthetic-table");
  vi.stubEnv("SETUP_CODE_VERIFIER_SECRET", "test-setup-secret");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-28T12:00:00Z"));
  vi.spyOn(console, "info").mockImplementation(() => {});
  send.mockReset().mockImplementation(
    /**
     * @param {GetCommand | TransactWriteCommand} command
     * @returns {Promise<object>} Simulated database result.
     */
    async (command) => {
      if (command instanceof GetCommand) {
        credentialReads++;
        return {};
      }
      const updates = command.input.TransactItems ?? [];
      expect(updates).toHaveLength(4);
      expect(updates[0].Update?.Key?.pk).toBe("SHORT_CODE_ATTEMPTS");
      const limit = Number(
        updates[0].Update?.ExpressionAttributeValues?.[":limit"],
      );
      if (count >= limit)
        throw Object.assign(new Error("budget exhausted"), {
          name: "TransactionCanceledException",
          CancellationReasons: [
            { Code: "ConditionalCheckFailed" },
            { Code: "None" },
          ],
        });
      count++;
      return {};
    },
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

/**
 * @param {import("aws-lambda").APIGatewayProxyHandlerV2} handler
 * @param {Record<string, string>} [body]
 * @returns {Promise<{statusCode: number}>} Handler response.
 */
async function invoke(handler, body = { code: "ABC123" }) {
  return /** @type {{statusCode: number}} */ (
    await handler(
      /** @type {import("aws-lambda").APIGatewayProxyEventV2} */ ({
        body: JSON.stringify(body),
        requestContext: {
          requestId: "synthetic-request",
          http: {
            sourceIp: `192.0.${Math.floor(count / 250)}.${(count % 250) + 1}`,
          },
        },
      }),
      /** @type {import("aws-lambda").Context} */ ({}),
      () => {},
    )
  );
}

it("shares the actual guard across lookup, redemption and direct registration", async () => {
  const routes = [lookup, redeemEnrollmentGrant, registerDevice];
  await Promise.all(
    Array.from({ length: 999 }, (_, index) => invoke(routes[index % 3])),
  );
  expect(count).toBe(999);
  const results = await Promise.all(routes.map((handler) => invoke(handler)));
  expect(results.filter((result) => result.statusCode === 401)).toHaveLength(1);
  expect(results.filter((result) => result.statusCode === 429)).toHaveLength(2);
  expect(count).toBe(1000);
  const reads = credentialReads;
  for (const handler of routes)
    expect((await invoke(handler)).statusCode).toBe(429);
  expect(credentialReads).toBe(reads);
});

it("does not charge long-token redemption against an exhausted short-code budget", async () => {
  count = 1000;
  expect(
    (
      await invoke(redeemEnrollmentGrant, {
        grantId: "synthetic-grant",
        token: "synthetic-long-token",
      })
    ).statusCode,
  ).toBe(401);
  expect(count).toBe(1000);
  expect(credentialReads).toBe(1);
  expect(
    send.mock.calls.every(([command]) => command instanceof GetCommand),
  ).toBe(true);
});
