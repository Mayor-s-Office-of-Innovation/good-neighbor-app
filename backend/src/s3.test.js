import { PutObjectCommand } from "@aws-sdk/client-s3";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock("@aws-sdk/client-s3", async (importOriginal) => {
  const original = /** @type {typeof import("@aws-sdk/client-s3")} */ (
    await importOriginal()
  );
  return {
    ...original,
    S3Client: class {
      middlewareStack = { use: vi.fn() };
      send = send;
    },
  };
});

const { putObject } = await import("./s3.js");

beforeEach(() => {
  send.mockReset().mockResolvedValue({});
});

describe("putObject", () => {
  it("stores generated objects without lifecycle tags", async () => {
    await putObject({
      bucket: "durable-records",
      key: "compliance-letters/site-1/v1.pdf",
      body: Buffer.from("pdf"),
      contentType: "application/pdf",
    });

    const command = send.mock.calls[0][0];
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input).not.toHaveProperty("Tagging");
  });
});
