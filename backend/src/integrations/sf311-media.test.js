import { afterEach, describe, expect, it, vi } from "vitest";
const { send, presignGet } = vi.hoisted(() => ({
  send: vi.fn(),
  presignGet: vi.fn(),
}));
vi.mock("../db.js", () => ({ ddb: { send } }));
vi.mock("../s3.js", () => ({ presignGet }));
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
    });
    expect(send.mock.calls[1][0].input.Key).toEqual({
      PK: stored.PK,
      SK: stored.SK,
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

  it("rejects an unknown token without signing an image", async () => {
    vi.stubEnv("S3_UPLOAD_BUCKET", "uploads");
    vi.stubEnv("DYNAMO_TABLE", "table");
    vi.stubEnv("SQS_QUEUE_URL", "queue");
    send.mockResolvedValueOnce({});
    expect((await get311Media(event("a".repeat(64)))).statusCode).toBe(404);
    expect(presignGet).not.toHaveBeenCalled();
  });

  it("rejects malformed tokens before reading storage", async () => {
    expect((await get311Media(event("bad"))).statusCode).toBe(404);
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
