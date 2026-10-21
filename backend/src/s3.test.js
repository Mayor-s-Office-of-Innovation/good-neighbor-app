import {
  CopyObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { send, getSignedUrl } = vi.hoisted(() => ({
  send: vi.fn(),
  getSignedUrl: vi.fn(),
}));
vi.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl }));

vi.mock("@aws-sdk/client-s3", async (importOriginal) => {
  const original = /** @type {typeof import("@aws-sdk/client-s3")} */ (
    await importOriginal()
  );
  return {
    ...original,
    S3Client: class {
      /** @param {any} options */
      constructor(options) {
        this.options = options;
      }
      middlewareStack = { use: vi.fn() };
      send = send;
    },
  };
});

const { putObject, copyObject } = await import("./s3.js");

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

  it("applies lifecycle tags in the same request when asked", async () => {
    await putObject({
      bucket: "uploads",
      key: "checks/site-1/chk_01/art_1.thumb.webp",
      body: Buffer.from("webp"),
      contentType: "image/webp",
      tagging: "state=active",
    });

    const command = send.mock.calls[0][0];
    expect(command.input).toMatchObject({
      ContentType: "image/webp",
      Tagging: "state=active",
    });
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  getSignedUrl.mockReset();
});

describe("311 attachment copies", () => {
  it("copies an old source to a new key without inheriting one-day deletion tags", async () => {
    await copyObject({
      bucket: "uploads",
      sourceKey: "checks/site/old image+#.jpg",
      key: "sf311-media/fresh",
    });
    const command = send.mock.calls[0][0];
    expect(command).toBeInstanceOf(CopyObjectCommand);
    expect(command.input).toEqual({
      Bucket: "uploads",
      Key: "sf311-media/fresh",
      CopySource: "uploads/checks/site/old%20image%2B%23.jpg",
      TaggingDirective: "REPLACE",
      Tagging: "",
      MetadataDirective: "COPY",
    });
  });
});

describe("presignGet endpoints", () => {
  it("signs remote local-development redirects with the configured public endpoint", async () => {
    vi.resetModules();
    vi.stubEnv("AWS_ENDPOINT_URL_S3", "http://127.0.0.1:9000");
    vi.stubEnv("S3_PUBLIC_PRESIGN_ENDPOINT", "https://tunnel.example");
    const { presignGet } = await import("./s3.js");
    getSignedUrl.mockImplementation(
      (client, command) =>
        `${client.options.endpoint}/${command.input.Bucket}/${command.input.Key}`,
    );
    const url = await presignGet({
      bucket: "uploads",
      key: "sf311-media/image",
      expiresIn: 120,
    });
    expect(url).toBe("https://tunnel.example/uploads/sf311-media/image");
    expect(getSignedUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        options: { endpoint: "https://tunnel.example", forcePathStyle: true },
      }),
      expect.any(GetObjectCommand),
      { expiresIn: 120 },
    );
  });

  it("keeps the ordinary AWS client when no public endpoint is configured", async () => {
    vi.resetModules();
    vi.stubEnv("AWS_ENDPOINT_URL_S3", "");
    vi.stubEnv("S3_PUBLIC_PRESIGN_ENDPOINT", "");
    const { presignGet } = await import("./s3.js");
    getSignedUrl.mockResolvedValue("https://s3.example/signed");
    expect(await presignGet({ bucket: "uploads", key: "image" })).toBe(
      "https://s3.example/signed",
    );
    expect(getSignedUrl).toHaveBeenCalledWith(
      expect.objectContaining({ options: {} }),
      expect.any(GetObjectCommand),
      { expiresIn: 300 },
    );
  });
});
