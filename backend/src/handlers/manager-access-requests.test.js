import {
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
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
    mocks.send
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Items: [] });
    const response = await call("unknown@example.org");
    expect(response.statusCode).toBe(202);
    expect(JSON.parse(String(response.body))).toEqual(generic);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.send.mock.calls[0][0]).toBeInstanceOf(UpdateCommand);
    expect(mocks.send.mock.calls[2][0]).toBeInstanceOf(PutCommand);
    expect(mocks.send.mock.calls[3][0]).toBeInstanceOf(QueryCommand);
  });

  it("issues one single-Site link per active membership in one email", async () => {
    mocks.send
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
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
    const transaction = mocks.send.mock.calls[7][0];
    expect(transaction).toBeInstanceOf(TransactWriteCommand);
    expect(JSON.stringify(response)).not.toContain("enrollment_token");
  });

  it("silently absorbs an IP rate limit without looking up memberships", async () => {
    const limited = new Error("limited");
    limited.name = "ConditionalCheckFailedException";
    mocks.send.mockRejectedValueOnce(limited);
    const response = await call("alex@example.org");
    expect(response.statusCode).toBe(202);
    expect(JSON.parse(String(response.body))).toEqual(generic);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(
      JSON.stringify({
        marker: "ManagerAccessThrottled",
        limitedBy: "ip_hour",
      }),
    );
  });
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
