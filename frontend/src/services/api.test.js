import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, waitForAnalyses } from "./api.js";

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
