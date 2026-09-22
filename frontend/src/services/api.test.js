import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  dataUrlToBlob,
  editAnalysisCondition,
  getSiteSettings,
  getMediaUrl,
  rejectAnalysisCondition,
  waitForAnalyses,
} from "./api.js";

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

describe("analysis amendments", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Minimal ok JSON response for the amendment routes. */
  const okJson = (body) =>
    Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify(body)),
    });

  it("editAnalysisCondition posts to the artifact-scoped conditions route", async () => {
    /** @type {any} */ const fetch = vi.fn(() =>
      okJson({ analysis_id: "ana_1" }),
    );
    vi.stubGlobal("fetch", fetch);
    await editAnalysisCondition("chk_01", "art_1", "cond-1", {
      description: "Corrected description",
    });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("/v1/checks/chk_01/artifacts/art_1/conditions/cond-1");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      description: "Corrected description",
    });
  });

  it("encodes path segments so IDs with special chars can't reshape the URL", async () => {
    /** @type {any} */ const fetch = vi.fn(() => okJson(null));
    vi.stubGlobal("fetch", fetch);
    await rejectAnalysisCondition("ch k", "art/1", "cond#1", {});
    const [url] = fetch.mock.calls[0];
    expect(url).toBe(
      "/v1/checks/ch%20k/artifacts/art%2F1/conditions/cond%231/reject",
    );
  });
});

describe("non-JSON response handling (api-response-integrity plan §2a)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Raw-body fetch stub: `body` is returned verbatim (no JSON shaping). */
  const rawResponse = (status, body, ok = status >= 200 && status < 300) =>
    Promise.resolve({
      ok,
      status,
      statusText: "Status",
      text: () => Promise.resolve(body),
    });

  it("throws ApiError (never a value) when a 2xx carries an HTML body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => rawResponse(200, "<!doctype html><html></html>")),
    );

    const err = await getSiteSettings().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(200);
    expect(err.body).toMatchObject({ code: "non_json_response" });
    expect(err.message).toContain("Non-JSON");
  });

  it("preserves the origin status when a 403 carries an HTML body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => rawResponse(403, "<html>denied</html>", false)),
    );

    const err = await getSiteSettings().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(403);
    expect(err.body).toMatchObject({ code: "non_json_response" });
  });

  it("treats an empty 204 body as legal (resolves null)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => rawResponse(204, "")),
    );

    await expect(getSiteSettings()).resolves.toBeNull();
  });

  it("still parses a normal JSON 200 (control)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => rawResponse(200, JSON.stringify({ site: {} }))),
    );

    await expect(getSiteSettings()).resolves.toMatchObject({ site: {} });
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

it("requests thumbnail media explicitly while leaving original reads unchanged", async () => {
  const fetch = stubGetCheck([{ artifacts: [], analyses: [] }]);
  await getMediaUrl("check-1", "photo-1", "thumbnail");
  expect(/** @type {any} */ (fetch.mock.calls)[0][0]).toContain(
    "/artifacts/photo-1/media?variant=thumbnail",
  );
  await getMediaUrl("check-1", "photo-1");
  expect(/** @type {any} */ (fetch.mock.calls)[1][0]).toMatch(
    /\/artifacts\/photo-1\/media$/,
  );
});
