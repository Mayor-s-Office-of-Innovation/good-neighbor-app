import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, dataUrlToBlob, waitForAnalyses } from "./api.js";

/**
 * A fetch stub whose responses are driven by successive `getCheck` payloads.
 * `waitForAnalyses` calls GET /v1/checks/{id} once per poll, so each element of
 * `payloads` answers one poll (the last one repeats if polling outlasts it).
 * @param {Array<{ artifacts: any[], analyses: any[] }>} payloads
 */
function stubGetCheck(payloads) {
  let i = 0;
  const fetch = vi.fn(() => {
    const payload = payloads[Math.min(i, payloads.length - 1)];
    i += 1;
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: "OK",
      text: () => Promise.resolve(JSON.stringify({ check: {}, ...payload })),
    });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const artifact = (id) => ({ artifactId: id });
const analysis = (id, status = "analyzed") => ({ artifactId: id, status });

describe("waitForAnalyses", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves immediately when nothing is expected", async () => {
    const fetch = stubGetCheck([{ artifacts: [], analyses: [] }]);
    const res = await waitForAnalyses("chk_01", { expected: 0 });
    expect(res.analyses).toEqual([]);
    // One read to establish state, no polling loop.
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("resolves once every registered artifact has an analysis", async () => {
    const fetch = stubGetCheck([
      // First poll: only art_1 analyzed (art_2 still pending).
      {
        artifacts: [artifact("a1"), artifact("a2")],
        analyses: [analysis("a1")],
      },
      // Second poll: both covered.
      {
        artifacts: [artifact("a1"), artifact("a2")],
        analyses: [analysis("a1"), analysis("a2")],
      },
    ]);

    const res = await waitForAnalyses("chk_01", {
      expected: 2,
      timeoutMs: 5000,
      intervalMs: 1,
    });

    expect(res.analyses).toHaveLength(2);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("counts a failed marker toward coverage (doesn't hang the poll)", async () => {
    stubGetCheck([
      {
        artifacts: [artifact("a1"), artifact("a2")],
        analyses: [analysis("a1"), analysis("a2", "failed")],
      },
    ]);

    await expect(
      waitForAnalyses("chk_01", {
        expected: 2,
        timeoutMs: 5000,
        intervalMs: 1,
      }),
    ).resolves.toMatchObject({ analyses: expect.any(Array) });
  });

  it("throws analyses_pending on the deadline instead of returning partial", async () => {
    // Only 1 of 2 analyzed and it never advances — deadline 0 fires on first check.
    stubGetCheck([
      {
        artifacts: [artifact("a1"), artifact("a2")],
        analyses: [analysis("a1")],
      },
    ]);

    const err = await waitForAnalyses("chk_01", {
      expected: 2,
      timeoutMs: 0,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect(err.body).toMatchObject({
      code: "analyses_pending",
      expected: 2,
      analyzed: 1,
    });
  });
});

describe("dataUrlToBlob", () => {
  it("decodes a base64 JPEG data URL to a Blob of the right type and bytes", async () => {
    // "hi" → base64 "aGk="
    const blob = await dataUrlToBlob("data:image/jpeg;base64,aGk=");
    expect(blob.type).toBe("image/jpeg");
    expect(await blob.text()).toBe("hi");
  });

  it("round-trips arbitrary bytes (not just ASCII-safe input)", async () => {
    const bytes = new Uint8Array([0, 255, 16, 128, 1]);
    const b64 = btoa(String.fromCharCode(...bytes));
    const blob = await dataUrlToBlob(
      `data:application/octet-stream;base64,${b64}`,
    );
    const out = new Uint8Array(await blob.arrayBuffer());
    expect(Array.from(out)).toEqual(Array.from(bytes));
  });

  it("does not use fetch (would be blocked by connect-src CSP)", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await dataUrlToBlob("data:image/jpeg;base64,aGk=");
    expect(fetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("decodes a non-base64 (URL-encoded) data URL as text", async () => {
    const blob = await dataUrlToBlob("data:text/plain,hello%20world");
    expect(blob.type).toBe("text/plain");
    expect(await blob.text()).toBe("hello world");
  });

  it("throws ApiError on a malformed data URL with no comma", async () => {
    await expect(
      dataUrlToBlob("data:image/jpeg;base64"),
    ).rejects.toBeInstanceOf(ApiError);
  });
});
