import { beforeEach, expect, it, vi } from "vitest";
const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../db.js", () => ({ ddb: { send } }));
vi.mock("../config.js", () => ({
  getConfig: () => ({ dynamoTable: "table" }),
}));
import { getSystemControls, putSystemControls } from "./system-controls.js";
const event = (body = {}, role = "compliance-supervisor") =>
  /** @type {any} */ ({
    body: JSON.stringify(body),
    requestContext: {
      authorizer: {
        jwt: {
          claims: { "cognito:groups": role, sub: "synthetic-supervisor" },
        },
      },
    },
  });
const invoke = (/** @type {any} */ handler, /** @type {any} */ ev) =>
  handler(ev, {}, () => {});
beforeEach(() => {
  send.mockReset().mockResolvedValue({});
});
it("rejects non-supervisors before touching controls", async () => {
  for (const handler of [getSystemControls, putSystemControls])
    expect(
      (await invoke(handler, event({}, "compliance-manager"))).statusCode,
    ).toBe(403);
  expect(send).not.toHaveBeenCalled();
});
it("returns the enabled default", async () => {
  const response = await invoke(getSystemControls, event());
  expect(JSON.parse(response.body).silent311).toMatchObject({
    enabled: true,
    revision: 0,
  });
});
it.each([
  {},
  { enabled: "false", revision: 0 },
  { enabled: false, revision: -1 },
  { enabled: false, revision: "0" },
])("rejects malformed control %j", async (body) => {
  expect((await invoke(putSystemControls, event(body))).statusCode).toBe(400);
  expect(send).not.toHaveBeenCalled();
});
it("atomically disables, advances the epoch and records the supervisor", async () => {
  const response = await invoke(
    putSystemControls,
    event({ enabled: false, revision: 0 }),
  );
  expect(response.statusCode).toBe(200);
  expect(JSON.parse(response.body).silent311).toMatchObject({
    enabled: false,
    revision: 1,
  });
  expect(send.mock.calls[1][0].input.ExpressionAttributeValues).toMatchObject({
    ":enabled": false,
    ":next": 1,
    ":actor": "synthetic-supervisor",
  });
});
it("rejects stale edits and conditional-write races", async () => {
  send.mockResolvedValueOnce({ Item: { enabled: false, revision: 2 } });
  expect(
    (await invoke(putSystemControls, event({ enabled: true, revision: 0 })))
      .statusCode,
  ).toBe(409);
  send
    .mockReset()
    .mockResolvedValueOnce({})
    .mockRejectedValueOnce(
      Object.assign(new Error("race"), {
        name: "ConditionalCheckFailedException",
      }),
    );
  expect(
    (await invoke(putSystemControls, event({ enabled: false, revision: 0 })))
      .statusCode,
  ).toBe(409);
});
it("a no-op save preserves the epoch", async () => {
  expect(
    (await invoke(putSystemControls, event({ enabled: true, revision: 0 })))
      .statusCode,
  ).toBe(200);
  expect(send).toHaveBeenCalledTimes(1);
});
