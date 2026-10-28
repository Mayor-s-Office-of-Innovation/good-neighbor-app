import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  GetCommand,
  PutCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { initialPolicyDocument } from "../analysis/guidance/policy-import.js";
import { policyTexts } from "../analysis/guidance/policy-document.js";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../db.js", () => ({ ddb: { send } }));
const handlers = await import("./admin-policies.js");

/** @param {unknown} body @param {string} [role] @param {Record<string,string>} [pathParameters] */
function event(body, role = "compliance-supervisor", pathParameters = {}) {
  return {
    body: JSON.stringify(body),
    pathParameters,
    requestContext: {
      authorizer: {
        jwt: {
          claims: { "cognito:groups": role, sub: "synthetic-supervisor" },
        },
      },
    },
  };
}
/** @param {Function} handler @param {any} request */
async function call(handler, request) {
  const response = await handler(request);
  return { status: response.statusCode, body: JSON.parse(response.body) };
}
beforeEach(() => {
  send.mockReset();
  vi.stubEnv("DYNAMO_TABLE", "synthetic-policy-table");
});

describe("supervisor policy authoring", () => {
  it("denies managers on every read and mutation before database access", async () => {
    for (const handler of Object.values(handlers))
      expect(
        (await call(handler, event({}, "compliance-manager"))).status,
      ).toBe(403);
    expect(send).not.toHaveBeenCalled();
  });
  it("returns a read-only initial draft without writing or switching the active catalog", async () => {
    send.mockResolvedValue({});
    const result = await call(handlers.getPolicyDraft, event({}));
    expect(result.status).toBe(200);
    expect(result.body.activationAvailable).toBe(false);
    expect(result.body.draft.revision).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBeInstanceOf(GetCommand);
  });
  it("saves incomplete drafts with optimistic concurrency and normalizes category rename aliases", async () => {
    const before = initialPolicyDocument(),
      next = structuredClone(before);
    next.categories[0].name = "New example name";
    next.categories[0].definition = "";
    send
      .mockResolvedValueOnce({ Item: { revision: 3, document: before } })
      .mockResolvedValueOnce({});
    const result = await call(
      handlers.savePolicyDraft,
      event({ revision: 3, document: next }),
    );
    expect(result.status).toBe(200);
    expect(result.body.draft.document.categories[0].aliases).toContain(
      before.categories[0].name,
    );
    expect(result.body.draft.revision).toBe(4);
    expect(send.mock.calls[1][0]).toBeInstanceOf(PutCommand);
    expect(send.mock.calls[1][0].input.ConditionExpression).toBe(
      "revision = :revision",
    );
  });
  it("rejects stale writes and database races without retrying over another editor", async () => {
    const document = initialPolicyDocument();
    send.mockResolvedValueOnce({ Item: { revision: 4, document } });
    expect(
      (await call(handlers.savePolicyDraft, event({ revision: 3, document })))
        .status,
    ).toBe(409);
    expect(send).toHaveBeenCalledTimes(1);
    send.mockReset();
    send.mockResolvedValueOnce({}).mockRejectedValueOnce(
      Object.assign(new Error("race"), {
        name: "ConditionalCheckFailedException",
      }),
    );
    expect(
      (await call(handlers.savePolicyDraft, event({ revision: 0, document })))
        .status,
    ).toBe(409);
  });
  it("rejects invalid and oversized documents before persistence", async () => {
    expect(
      (
        await call(
          handlers.savePolicyDraft,
          event({ revision: 0, document: {} }),
        )
      ).status,
    ).toBe(400);
    const document = initialPolicyDocument();
    document.categories[0].definition = "x".repeat(9000);
    expect(
      (await call(handlers.savePolicyDraft, event({ revision: 0, document })))
        .status,
    ).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });
  it("clears unchanged stale translations when their source changes", async () => {
    const before = initialPolicyDocument(),
      key = `category.${before.categories[0].id}.name`;
    before.translations = { es: { [key]: "Synthetic translation" } };
    const next = structuredClone(before);
    next.categories[0].name = "New example";
    send
      .mockResolvedValueOnce({ Item: { revision: 1, document: before } })
      .mockResolvedValueOnce({});
    const result = await call(
      handlers.savePolicyDraft,
      event({ revision: 1, document: next }),
    );
    expect(result.body.draft.document.translations.es[key]).toBeUndefined();
  });
  it("blocks release preparation for overlapping source rules", async () => {
    send.mockResolvedValueOnce({
      Item: { revision: 2, document: initialPolicyDocument() },
    });
    const result = await call(
      handlers.createPolicyRelease,
      event({ revision: 2, reason: "Synthetic review" }),
    );
    expect(result.status).toBe(422);
    expect(result.body.report.valid).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("atomically freezes a validated release while leaving runtime activation unavailable", async () => {
    const document = initialPolicyDocument();
    // Synthetic release fixture only: isolate one complete category instead of changing policy source.
    document.categories = document.categories.filter(
      (c) => c.name === "Litter",
    );
    document.rules = document.rules.filter(
      (r) => r.categoryId === document.categories[0].id,
    );
    document.questions = [];
    document.translations = Object.fromEntries(
      ["es", "fil", "vi", "zh-Hant"].map((locale) => [
        locale,
        policyTexts(document),
      ]),
    );
    send
      .mockResolvedValueOnce({ Item: { revision: 2, document } })
      .mockResolvedValueOnce({});
    const result = await call(
      handlers.createPolicyRelease,
      event({ revision: 2, reason: "Synthetic review" }),
    );
    expect(result.status).toBe(201);
    expect(result.body.release).toMatchObject({
      status: "prepared",
      activationAvailable: false,
      createdBy: "synthetic-supervisor",
    });
    const transaction = send.mock.calls[1][0];
    expect(transaction).toBeInstanceOf(TransactWriteCommand);
    expect(transaction.input.TransactItems).toHaveLength(2);
    expect(transaction.input.TransactItems[1].Update.ConditionExpression).toBe(
      "revision = :revision",
    );
    expect(JSON.stringify(transaction.input)).not.toContain('"sk":"ACTIVE"');
  });
  it("prevents releases based on an older running policy", async () => {
    const document = initialPolicyDocument();
    document.categories = document.categories.filter(
      (c) => c.name === "Litter",
    );
    document.rules = document.rules.filter(
      (r) => r.categoryId === document.categories[0].id,
    );
    document.questions = [];
    document.baseVersion = "old-policy";
    document.translations = Object.fromEntries(
      ["es", "fil", "vi", "zh-Hant"].map((locale) => [
        locale,
        policyTexts(document),
      ]),
    );
    send.mockResolvedValueOnce({ Item: { revision: 2, document } });
    expect(
      (
        await call(
          handlers.createPolicyRelease,
          event({ revision: 2, reason: "Synthetic review" }),
        )
      ).status,
    ).toBe(409);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("downloads the frozen compiled artifacts instead of rebuilding them with newer code", async () => {
    const id = "00000000-0000-4000-8000-000000000000";
    const frozen = {
      releaseId: id,
      document: { schemaVersion: 1 },
      catalog: { policyVersion: "frozen-example" },
      categoriesCsv: "frozen categories",
      rulesCsv: "frozen rules",
      analyzerBase: { id: "example", version: "1.0.0" },
      activationPrerequisites: ["example_gate"],
      digest: "example-digest",
    };
    send.mockResolvedValueOnce({ Item: frozen });
    const result = await call(
      handlers.getPolicyRelease,
      event({}, "compliance-supervisor", { releaseId: id }),
    );
    expect(result.status).toBe(200);
    expect(result.body.package).toMatchObject({
      catalog: frozen.catalog,
      categoriesCsv: frozen.categoriesCsv,
      rulesCsv: frozen.rulesCsv,
      analyzerBase: frozen.analyzerBase,
    });
  });
});
