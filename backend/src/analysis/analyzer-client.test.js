import { describe, expect, it } from "vitest";
import {
  AnalyzerError,
  buildAnalyzeRequest,
  createAnalyzerClient,
} from "./analyzer-client.js";
import { RUBRIC_ID, RUBRIC_VERSION } from "./contract.js";
import { excellentResponse } from "./fixtures/excellent.js";

/** A minimal wire metadata block used across the request tests. */
const metadata = {
  reported_at: "2026-08-14T15:04:00.000Z",
  latitude: 37.7749,
  longitude: -122.4194,
  position_descriptor: "north gate",
};

/** @type {import("./analyzer-client.js").AnalyzeMedia[]} */
const media = [{ type: "text", text: "gate looks clear" }];

/**
 * Build a stub `fetch` that returns queued responses in order and records every
 * call. Each queued entry is `{ ok, status, body }`; `body` is returned from
 * `.json()`. A queued `Error` instance is thrown instead (transport failure).
 * @param {Array<{ ok: boolean, status: number, body?: unknown } | Error>} queue
 * @returns {{ fetchImpl: typeof fetch, calls: Array<{ url: unknown, init: any }> }}
 */
function stubFetch(queue) {
  /** @type {Array<{ url: unknown, init: any }>} */
  const calls = [];
  /**
   * @param {any} url
   * @param {any} init
   * @returns {Promise<{ ok: boolean, status: number, json: () => Promise<unknown> }>}
   */
  const impl = async (url, init) => {
    calls.push({ url, init });
    const next = queue.shift();
    if (next instanceof Error) throw next;
    if (!next) throw new Error("stubFetch: no queued response");
    return {
      ok: next.ok,
      status: next.status,
      json: async () => next.body,
    };
  };
  return { fetchImpl: /** @type {typeof fetch} */ (impl), calls };
}

/** No-op sleep so retry tests don't wait on real timers. */
const noSleep = async () => {};

describe("buildAnalyzeRequest", () => {
  it("pins the rubric and forces store_input:false", () => {
    const body = buildAnalyzeRequest({ metadata, media });
    expect(body.rubric_id).toBe(RUBRIC_ID);
    expect(body.rubric_version).toBe(RUBRIC_VERSION);
    expect(body.storage).toEqual({
      store_input: false,
      return_signed_urls: false,
    });
    expect(body.metadata).toBe(metadata);
    expect(body.media).toBe(media);
  });

  it("omits caller when no ids are given", () => {
    const body = buildAnalyzeRequest({ metadata, media });
    expect(body).not.toHaveProperty("caller");
  });

  it("threads requestId and appId into caller", () => {
    const body = buildAnalyzeRequest({
      metadata,
      media,
      requestId: "chk_01#art_02",
      appId: "good-neighbor-app",
    });
    expect(body.caller).toEqual({
      app_id: "good-neighbor-app",
      request_id: "chk_01#art_02",
    });
  });
});

describe("createAnalyzerClient", () => {
  it("requires baseUrl and apiKey", () => {
    expect(() =>
      createAnalyzerClient(/** @type {any} */ ({ apiKey: "k" })),
    ).toThrow(/baseUrl/);
    expect(() =>
      createAnalyzerClient(/** @type {any} */ ({ baseUrl: "https://x/" })),
    ).toThrow(/apiKey/);
  });

  it("analyze() posts to /v1/analyses with the api key and returns the parsed response", async () => {
    const { fetchImpl, calls } = stubFetch([
      { ok: true, status: 200, body: excellentResponse },
    ]);
    const client = createAnalyzerClient({
      baseUrl: "https://analysis.example.org", // no trailing slash on purpose
      apiKey: "secret-key",
      fetchImpl,
    });

    const result = await client.analyze({
      metadata,
      media,
      requestId: "chk_01#art_02",
    });

    expect(result).toBe(excellentResponse);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(String(call.url)).toBe("https://analysis.example.org/v1/analyses");
    expect(call.init.method).toBe("POST");
    expect(call.init.headers["x-api-key"]).toBe("secret-key");
    expect(call.init.headers["content-type"]).toMatch(/application\/json/);
    const sent = JSON.parse(call.init.body);
    expect(sent.rubric_id).toBe(RUBRIC_ID);
    expect(sent.storage.store_input).toBe(false);
    expect(sent.caller.request_id).toBe("chk_01#art_02");
  });

  it("listRubrics() hits /v1/rubrics without the api key", async () => {
    const { fetchImpl, calls } = stubFetch([
      { ok: true, status: 200, body: { rubrics: [] } },
    ]);
    const client = createAnalyzerClient({
      baseUrl: "https://analysis.example.org/",
      apiKey: "secret-key",
      fetchImpl,
    });

    await client.listRubrics();
    const [call] = calls;
    expect(String(call.url)).toBe("https://analysis.example.org/v1/rubrics");
    expect(call.init.headers["x-api-key"]).toBeUndefined();
  });

  it("maps a non-retryable error body to AnalyzerError and does not retry", async () => {
    const { fetchImpl, calls } = stubFetch([
      {
        ok: false,
        status: 400,
        body: {
          error: {
            code: "invalid_request",
            message: "media must not be empty",
            details: ["media: minItems 1"],
          },
        },
      },
    ]);
    const client = createAnalyzerClient({
      baseUrl: "https://analysis.example.org/",
      apiKey: "k",
      fetchImpl,
      sleep: noSleep,
    });

    await expect(client.analyze({ metadata, media })).rejects.toMatchObject({
      name: "AnalyzerError",
      status: 400,
      code: "invalid_request",
      retryable: false,
    });
    expect(calls).toHaveLength(1); // no retry on 4xx
  });

  it("retries a 429 then succeeds", async () => {
    const { fetchImpl, calls } = stubFetch([
      {
        ok: false,
        status: 429,
        body: { error: { code: "x", message: "slow down" } },
      },
      { ok: true, status: 200, body: excellentResponse },
    ]);
    let slept = 0;
    const client = createAnalyzerClient({
      baseUrl: "https://analysis.example.org/",
      apiKey: "k",
      fetchImpl,
      sleep: async () => {
        slept += 1;
      },
    });

    const result = await client.analyze({ metadata, media });
    expect(result).toBe(excellentResponse);
    expect(calls).toHaveLength(2);
    expect(slept).toBe(1);
  });

  it("gives up after maxRetries on persistent 503", async () => {
    const { fetchImpl, calls } = stubFetch([
      { ok: false, status: 503, body: {} },
      { ok: false, status: 503, body: {} },
      { ok: false, status: 503, body: {} },
    ]);
    const client = createAnalyzerClient({
      baseUrl: "https://analysis.example.org/",
      apiKey: "k",
      fetchImpl,
      maxRetries: 2,
      sleep: noSleep,
    });

    await expect(client.analyze({ metadata, media })).rejects.toMatchObject({
      status: 503,
      retryable: true,
    });
    expect(calls).toHaveLength(3); // initial + 2 retries
  });

  it("retries a transport failure then rethrows as retryable", async () => {
    const { fetchImpl, calls } = stubFetch([
      new Error("ECONNRESET"),
      new Error("ECONNRESET"),
      new Error("ECONNRESET"),
    ]);
    const client = createAnalyzerClient({
      baseUrl: "https://analysis.example.org/",
      apiKey: "k",
      fetchImpl,
      maxRetries: 2,
      sleep: noSleep,
    });

    const error = await client.analyze({ metadata, media }).catch((e) => e);
    expect(error).toBeInstanceOf(AnalyzerError);
    expect(error.retryable).toBe(true);
    expect(calls).toHaveLength(3);
  });
});
