import { afterEach, describe, expect, it, vi } from "vitest";
const { send, presignGet, copyObject } = vi.hoisted(() => ({
  send: vi.fn(),
  presignGet: vi.fn(),
  copyObject: vi.fn(),
}));
vi.mock("../db.js", () => ({ ddb: { send } }));
vi.mock("../s3.js", () => ({ presignGet, copyObject }));
import { create311MediaLink, get311Media } from "./sf311-media.js";

const config = {
  uploadBucket: "uploads",
  dynamoTable: "table",
  queueUrl: "queue",
  sf311MediaBaseUrl: "https://api.example",
};
const now = new Date("2026-10-21T12:00:00Z");
/** @param {string} token */
const event = (token) =>
  /** @type {any} */ ({ queryStringParameters: { token } });
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

describe("311 media lease", () => {
  it("stores only the token hash and serves the same image through fresh credentials until 48 hours", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    vi.stubEnv("S3_UPLOAD_BUCKET", "uploads");
    vi.stubEnv("DYNAMO_TABLE", "table");
    vi.stubEnv("SQS_QUEUE_URL", "queue");
    send.mockResolvedValueOnce({});
    const url = new URL(
      await create311MediaLink({ config, key: "checks/site/check/image" }),
    );
    const token = url.searchParams.get("token");
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    const stored = send.mock.calls[0][0].input.Item;
    expect(stored.pk).toMatch(/^SF311_MEDIA#[a-f0-9]{64}$/);
    expect(stored.sk).toBe("LEASE");
    expect(stored).not.toHaveProperty("PK");
    expect(stored).not.toHaveProperty("SK");
    expect(send.mock.calls[0][0].input.ConditionExpression).toBe(
      "attribute_not_exists(pk)",
    );
    expect(stored.sourceS3Key).toBe("checks/site/check/image");
    expect(stored.s3Key).toMatch(/^sf311-media\/[a-f0-9]{64}$/);
    expect(copyObject).toHaveBeenCalledWith({
      bucket: "uploads",
      sourceKey: stored.sourceS3Key,
      key: stored.s3Key,
    });
    expect(copyObject.mock.invocationCallOrder[0]).toBeLessThan(
      send.mock.invocationCallOrder[0],
    );
    expect(stored.expiresAt).toBe(now.getTime() / 1000 + 172800);
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(url.origin + url.pathname).toBe("https://api.example/v1/311-media");
    send.mockResolvedValue({ Item: stored });
    presignGet.mockResolvedValue("https://s3.example/fresh");
    vi.setSystemTime(now.getTime() + 47 * 3600 * 1000);
    const response = await get311Media(event(String(token)));
    expect(response.statusCode).toBe(302);
    expect(response.headers).toMatchObject({
      location: "https://s3.example/fresh",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "strict-transport-security":
        "max-age=31536000; includeSubDomains; preload",
      "content-security-policy":
        "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    });
    expect(send.mock.calls[1][0].input.Key).toEqual({
      pk: stored.pk,
      sk: stored.sk,
    });
    expect(presignGet).toHaveBeenLastCalledWith({
      bucket: "uploads",
      key: stored.s3Key,
      expiresIn: 300,
    });
    vi.setSystemTime(now.getTime() + (172800 - 30) * 1000);
    await get311Media(event(String(token)));
    expect(presignGet).toHaveBeenLastCalledWith(
      expect.objectContaining({ expiresIn: 30 }),
    );
    presignGet.mockClear();
    vi.setSystemTime(now.getTime() + 172800 * 1000);
    expect((await get311Media(event(String(token)))).statusCode).toBe(404);
    expect(presignGet).not.toHaveBeenCalled();
  });

  it("snapshots a near-expiry source and serves its copy even after the source expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    vi.stubEnv("S3_UPLOAD_BUCKET", "uploads");
    vi.stubEnv("DYNAMO_TABLE", "table");
    vi.stubEnv("SQS_QUEUE_URL", "queue");
    copyObject.mockResolvedValueOnce({});
    send.mockResolvedValueOnce({});
    const url = new URL(
      await create311MediaLink({ config, key: "checks/day-29/image" }),
    );
    const stored = send.mock.calls[0][0].input.Item;
    vi.setSystemTime(now.getTime() + 47 * 3600 * 1000);
    send.mockResolvedValueOnce({ Item: stored });
    presignGet.mockResolvedValueOnce("https://s3.example/copy");
    expect(
      (await get311Media(event(String(url.searchParams.get("token")))))
        .statusCode,
    ).toBe(302);
    expect(presignGet).toHaveBeenCalledWith({
      bucket: "uploads",
      key: stored.s3Key,
      expiresIn: 300,
    });
    expect(stored.s3Key).not.toBe(stored.sourceS3Key);
  });

  it("does not issue a lease if its source image cannot be copied", async () => {
    copyObject.mockRejectedValueOnce(new Error("NoSuchKey"));
    await expect(
      create311MediaLink({ config, key: "missing" }),
    ).rejects.toThrow("NoSuchKey");
    expect(send).not.toHaveBeenCalled();
  });

  it.each(["database", "presign"])(
    "protects direct-origin %s failures without logging bearer data",
    async (failure) => {
      vi.stubEnv("S3_UPLOAD_BUCKET", "uploads");
      vi.stubEnv("DYNAMO_TABLE", "table");
      vi.stubEnv("SQS_QUEUE_URL", "queue");
      const token = "b".repeat(64);
      const error = new Error(
        `Failed https://media.example/v1/311-media?token=${token}`,
      );
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      if (failure === "database") send.mockRejectedValueOnce(error);
      else {
        send.mockResolvedValueOnce({
          Item: {
            s3Key: "sf311-media/image",
            expiresAt: Date.now() / 1000 + 3600,
          },
        });
        presignGet.mockRejectedValueOnce(error);
      }
      const response = await get311Media(event(token));
      expect(response.statusCode).toBe(500);
      expect(response.headers).toMatchObject({
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "strict-transport-security":
          "max-age=31536000; includeSubDomains; preload",
        "content-security-policy":
          expect.stringContaining("default-src 'none'"),
      });
      expect(JSON.stringify(response)).not.toContain(token);
      expect(log).toHaveBeenCalledOnce();
      expect(JSON.stringify(log.mock.calls)).not.toContain(token);
    },
  );

  it("rejects an unknown token without signing an image", async () => {
    vi.stubEnv("S3_UPLOAD_BUCKET", "uploads");
    vi.stubEnv("DYNAMO_TABLE", "table");
    vi.stubEnv("SQS_QUEUE_URL", "queue");
    send.mockResolvedValueOnce({});
    expect((await get311Media(event("a".repeat(64)))).statusCode).toBe(404);
    expect(presignGet).not.toHaveBeenCalled();
  });

  it("rejects malformed tokens before reading storage", async () => {
    const response = await get311Media(event("bad"));
    expect(response.statusCode).toBe(404);
    expect(response.headers).toMatchObject({
      "referrer-policy": "no-referrer",
      "strict-transport-security":
        "max-age=31536000; includeSubDomains; preload",
      "content-security-policy": expect.stringContaining("default-src 'none'"),
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("fails before writing a lease when the public base URL is missing", async () => {
    await expect(
      create311MediaLink({
        config: { ...config, sf311MediaBaseUrl: undefined },
        key: "image",
      }),
    ).rejects.toThrow("SF311_MEDIA_BASE_URL");
    expect(send).not.toHaveBeenCalled();
  });
});
