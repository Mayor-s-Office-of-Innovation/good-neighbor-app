// @ts-nocheck -- handler tests call the lambda with minimal event stubs.
import { afterEach, describe, expect, it, vi } from "vitest";

const env = { ...process.env };

describe("transcribe-credentials handler", () => {
  afterEach(() => {
    process.env = { ...env };
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("rejects requests when passthrough mode is disabled", async () => {
    const { handler } = await import("./transcribe-credentials.js");

    const result = await handler(
      {
        body: JSON.stringify({ siteId: "site-123" }),
        isBase64Encoded: false,
      },
      {},
      () => {},
    );

    expect(result.statusCode).toBe(501);
    expect(JSON.parse(result.body)).toMatchObject({
      error: "transcribe_not_configured",
    });
  });

  it("returns browser-usable credentials in passthrough mode", async () => {
    process.env.TRANSCRIBE_CREDENTIALS_MODE = "passthrough";
    const { createHandler } = await import("./transcribe-credentials.js");
    const handler = createHandler({
      region: "us-west-2",
      credentialProvider: async () => ({
        accessKeyId: "AKIA...",
        secretAccessKey: "secret",
        sessionToken: "token",
        expiration: new Date("2026-08-21T22:00:00.000Z"),
      }),
    });

    const result = await handler(
      {
        body: JSON.stringify({ siteId: "site-123" }),
        isBase64Encoded: false,
      },
      {},
      () => {},
    );

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({
      accessKeyId: "AKIA...",
      secretAccessKey: "secret",
      sessionToken: "token",
      expiration: "2026-08-21T22:00:00.000Z",
      region: "us-west-2",
    });
  });
});
