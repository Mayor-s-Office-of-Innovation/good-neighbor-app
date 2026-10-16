import { beforeEach, expect, it, vi } from "vitest";
const { send, create, preview, apply } = vi.hoisted(() => ({
  send: vi.fn(),
  create: vi.fn(),
  preview: vi.fn(),
  apply: vi.fn(),
}));
vi.mock("../../src/db.js", () => ({ ddb: { send } }));
vi.mock("../../src/handlers/admin-oversight.js", () => ({
  createOversightOption: create,
}));
vi.mock("../../src/handlers/admin-site-imports.js", () => ({
  previewSiteImport: preview,
  applySiteImport: apply,
}));
import { seedLocalSiteAdmin } from "./site-admin-seed.mjs";
const response = (statusCode, body) => ({
  statusCode,
  body: JSON.stringify(body),
});
beforeEach(() => {
  for (const name of [
    "AWS_ENDPOINT_URL_DYNAMODB",
    "AWS_ENDPOINT_URL_SQS",
    "AWS_ENDPOINT_URL_S3",
  ])
    vi.stubEnv(name, "http://localhost:8000");
  vi.stubEnv("DYNAMO_TABLE", "gnp-local-app");
  send.mockReset().mockResolvedValue({});
  create
    .mockReset()
    .mockResolvedValue(response(409, { error: "oversight_option_exists" }));
  preview.mockReset().mockResolvedValue(
    response(200, {
      counts: { create: 1 },
      previewVersion: 1,
      importId: "one",
    }),
  );
  apply
    .mockReset()
    .mockResolvedValue(
      response(200, { resultStatus: "succeeded", outcomes: { applied: 1 } }),
    );
});
it("resumes after department creation and writes the completion marker", async () => {
  await seedLocalSiteAdmin();
  expect(apply).toHaveBeenCalledOnce();
  expect(send.mock.calls.at(-1)[0].input.Item.importId).toBe("one");
});
it("does not swallow unrelated department errors", async () => {
  create.mockResolvedValue(response(403, { error: "forbidden" }));
  await expect(seedLocalSiteAdmin()).rejects.toThrow("forbidden");
  expect(preview).not.toHaveBeenCalled();
});
