import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  dataUrlToBlob,
  editAnalysisCondition,
  getSiteSettings,
  getMediaUrl,
  getTaskUpdates,
  get311RequestDetails,
  getCaptureGuidance,
  rejectAnalysisCondition,
  toDevUploadUrl,
  waitForAnalyses,
  uploadTaskUpdatePhoto,
  uploadArtifact,
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

describe("uploadTaskUpdatePhoto", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("uploads the original file and registers its type and byte length", async () => {
    const file = new File([new Uint8Array([0, 255, 16, 128])], "result.jpg", {
      type: "image/jpeg",
    });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            artifactId: "photo-1",
            s3Key: "photos/photo-1",
            uploadUrl: "https://upload.example.test/photo-1",
            uploadHeaders: {},
          }),
        ),
      )
      .mockResolvedValueOnce(new Response(""))
      .mockResolvedValueOnce(new Response("{}"));
    vi.stubGlobal("fetch", fetch);
    await expect(
      uploadTaskUpdatePhoto("task-1", "check-1", {
        file,
        capturedAt: "2026-10-08T12:00:00Z",
      }),
    ).resolves.toEqual({ artifactId: "photo-1", s3Key: "photos/photo-1" });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls[1][1]).toMatchObject({ method: "PUT", body: file });
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({
      contentType: "image/jpeg",
      contentLength: 4,
    });
    expect(JSON.parse(fetch.mock.calls[2][1].body)).toMatchObject({
      artifactId: "photo-1",
      contentType: "image/jpeg",
      contentLength: 4,
      capturedAt: "2026-10-08T12:00:00Z",
    });
  });
});

describe("capture guidance requests", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("passes the abort signal and preserves cancellation errors", async () => {
    const controller = new AbortController();
    const aborted = new DOMException("Canceled", "AbortError");
    const fetch = vi.fn(async (url, options) => {
      expect(url).toContain("/v1/checks:capture-guidance?");
      expect(options.signal).toBe(controller.signal);
      controller.abort();
      throw aborted;
    });
    vi.stubGlobal("fetch", fetch);
    await expect(
      getCaptureGuidance({
        checkId: "new",
        startedAt: "2026-10-13T19:00:00Z",
        signal: controller.signal,
      }),
    ).rejects.toBe(aborted);
    expect(fetch.mock.calls[0][1].signal).toBe(controller.signal);
  });
});

describe("toDevUploadUrl (dev-server S3 upload proxy)", () => {
  const presigned =
    "https://good-neighbor-app-dev-uploads-2026.s3.us-west-2.amazonaws.com/sites/city-hall/checks/c1/a1.jpg?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abc&X-Amz-SignedHeaders=host%3Bcontent-type";

  it("is a no-op when the proxy is disabled (production, local harness)", () => {
    expect(toDevUploadUrl(presigned, false)).toBe(presigned);
  });

  it("defaults to disabled outside a dev server with a remote API target", () => {
    // No `__S3_UPLOAD_PROXY__` define under vitest → the guarded read is false.
    expect(toDevUploadUrl(presigned)).toBe(presigned);
  });

  it("rewrites a virtual-hosted S3 URL onto /__s3/<host>, keeping path + query", () => {
    expect(toDevUploadUrl(presigned, true)).toBe(
      "/__s3/good-neighbor-app-dev-uploads-2026.s3.us-west-2.amazonaws.com/sites/city-hall/checks/c1/a1.jpg?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abc&X-Amz-SignedHeaders=host%3Bcontent-type",
    );
  });

  it("leaves non-S3 hosts alone even when enabled", () => {
    const minio = "http://localhost:9000/gnp-local-uploads/k?X-Amz-Signature=x";
    expect(toDevUploadUrl(minio, true)).toBe(minio);
    const other = "https://evil.example.com/s3.us-west-2.amazonaws.com/k";
    expect(toDevUploadUrl(other, true)).toBe(other);
    const lookalike =
      "https://bucket.s3.us-west-2.amazonaws.com.evil.example/k";
    expect(toDevUploadUrl(lookalike, true)).toBe(lookalike);
  });

  it("requires https", () => {
    const plain = "http://bucket.s3.us-west-2.amazonaws.com/k?sig=1";
    expect(toDevUploadUrl(plain, true)).toBe(plain);
  });

  it("returns unparseable input unchanged", () => {
    expect(toDevUploadUrl("not a url", true)).toBe("not a url");
    expect(toDevUploadUrl("/already/relative?x=1", true)).toBe(
      "/already/relative?x=1",
    );
  });
});

describe("get311RequestDetails", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const pair = (n) => ({ taskId: `t${n}`, srNum: `SR-${n}` });
  const pairs = (count) => Array.from({ length: count }, (_, i) => pair(i));

  /** Echo each posted pair back with a status, failing batches on request. */
  function stubBatch({ failWhenIncludes = [] } = {}) {
    const fetch = vi.fn((_url, init) => {
      const { requests } = JSON.parse(init.body);
      const fail = requests.some(({ taskId }) =>
        failWhenIncludes.includes(taskId),
      );
      return Promise.resolve({
        ok: !fail,
        status: fail ? 500 : 200,
        statusText: fail ? "Internal Server Error" : "OK",
        text: () =>
          Promise.resolve(
            JSON.stringify(
              fail
                ? { error: "boom" }
                : {
                    requests: requests.map(({ taskId }) => ({
                      taskId,
                      request: { status: "Open" },
                    })),
                  },
            ),
          ),
      });
    });
    vi.stubGlobal("fetch", fetch);
    return fetch;
  }

  it("sends one batch when the list fits the backend cap", async () => {
    const fetch = stubBatch();
    const res = await get311RequestDetails(pairs(50));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(res.requests).toHaveLength(50);
  });

  it("splits more than 50 pairs into capped batches and merges them", async () => {
    const fetch = stubBatch();
    const res = await get311RequestDetails(pairs(120));
    expect(fetch).toHaveBeenCalledTimes(3);
    const sizes = fetch.mock.calls.map(
      ([, init]) => JSON.parse(init.body).requests.length,
    );
    expect(sizes).toEqual([50, 50, 20]);
    expect(res.requests.map((r) => r.taskId)).toEqual(
      pairs(120).map((p) => p.taskId),
    );
  });

  it("keeps the batches that succeeded when one fails", async () => {
    stubBatch({ failWhenIncludes: ["t60"] });
    const res = await get311RequestDetails(pairs(120));
    expect(res.requests).toHaveLength(70);
    expect(res.requests.some((r) => r.taskId === "t60")).toBe(false);
  });

  it("rejects when every batch fails", async () => {
    stubBatch({ failWhenIncludes: ["t0", "t50"] });
    await expect(get311RequestDetails(pairs(60))).rejects.toBeInstanceOf(
      ApiError,
    );
  });

  it("does nothing for an empty list", async () => {
    const fetch = stubBatch();
    expect(await get311RequestDetails([])).toEqual({ requests: [] });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("duplicate separation invalidation", () => {
  it.each(["one", "restored"])(
    "clears overrides before notifying pollers when separation returns %s",
    async (restoredId) => {
      const { separateDuplicate } = await import("./api.js");
      const { onDuplicateInvalidation } = await import(
        "./duplicate-invalidation.js"
      );
      const { readTaskStatusOverrides, writeTaskStatusOverrides } =
        await import("../state/task-status-overrides.js");
      let stored = "{}";
      vi.stubGlobal("localStorage", {
        getItem: () => stored,
        setItem: (_key, value) => {
          stored = value;
        },
      });
      writeTaskStatusOverrides({
        one: { status: "in_progress" },
        ...(restoredId !== "one"
          ? { [restoredId]: { status: "resolved" } }
          : {}),
        old: { status: "in_progress" },
      });
      const changed = vi.fn(() => {
        expect(readTaskStatusOverrides()).toEqual({
          old: { status: "in_progress" },
        });
      });
      const stop = onDuplicateInvalidation(changed);
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(new Response("{}", { status: 409 }))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              taskId: restoredId,
              task: { taskId: restoredId, status: "open" },
            }),
            { status: 200 },
          ),
        );
      vi.stubGlobal("fetch", fetch);
      try {
        const expected = { sourceRevision: "r1", originalTaskId: "old" };
        await expect(separateDuplicate("one", expected)).rejects.toBeInstanceOf(
          ApiError,
        );
        expect(changed).not.toHaveBeenCalled();
        expect(readTaskStatusOverrides().one.status).toBe("in_progress");
        await expect(separateDuplicate("one", expected)).resolves.toEqual({
          taskId: restoredId,
          task: { taskId: restoredId, status: "open" },
        });
        expect(changed).toHaveBeenCalledOnce();
      } finally {
        stop();
        vi.unstubAllGlobals();
      }
    },
  );
});

describe("timeline read cancellation", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("passes the caller signal to core, media, and every City batch fetch", async () => {
    const controller = new AbortController();
    const fetch = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(new Response('{"requests":[]}', { status: 200 })),
      );
    vi.stubGlobal("fetch", fetch);
    await getTaskUpdates("task", undefined, { signal: controller.signal });
    await getMediaUrl("check", "photo", { signal: controller.signal });
    await get311RequestDetails(
      Array.from({ length: 51 }, (_, i) => ({
        taskId: `t${i}`,
        srNum: `s${i}`,
      })),
      { signal: controller.signal },
    );
    expect(fetch).toHaveBeenCalledTimes(4);
    for (const [, options] of fetch.mock.calls) {
      expect(options.signal).toBe(controller.signal);
    }
  });
});

it("cancels the progress upload without registering incomplete media", async () => {
  const controller = new AbortController();
  const file = new File(["photo"], "photo.jpg", { type: "image/jpeg" });
  const fetch = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        artifactId: "photo",
        s3Key: "photo",
        uploadUrl: "https://upload.example.test/photo",
      }),
    ),
  );
  const sent = vi.fn();
  class Upload extends EventTarget {
    upload = new EventTarget();
    open() {}
    setRequestHeader() {}
    send(body) {
      sent(body);
      controller.abort();
    }
    abort() {
      this.dispatchEvent(new Event("abort"));
    }
  }
  vi.stubGlobal("fetch", fetch);
  vi.stubGlobal("XMLHttpRequest", Upload);
  try {
    await expect(
      uploadTaskUpdatePhoto(
        "task",
        "check",
        { file },
        { signal: controller.signal, onProgress: () => {} },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(sent).toHaveBeenCalledWith(file);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1].signal).toBe(controller.signal);
  } finally {
    vi.unstubAllGlobals();
  }
});

it.each([
  undefined,
  {
    randomUUID() {
      throw new Error("unavailable");
    },
  },
])(
  "uploads and registers photos without a working UUID API (%s)",
  async (cryptoApi) => {
    vi.stubGlobal("crypto", cryptoApi);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            artifactId: "artifact",
            s3Key: "synthetic-key",
            uploadUrl: "https://example.test/upload",
          }),
        ),
      )
      .mockResolvedValueOnce(new Response(""))
      .mockResolvedValueOnce(new Response("{}"));
    vi.stubGlobal("fetch", fetch);
    try {
      await expect(
        uploadArtifact("check", { dataUrl: "data:image/jpeg;base64,aGk=" }),
      ).resolves.toMatchObject({ artifactId: "artifact" });
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(fetch.mock.calls[1][1].method).toBe("PUT");
      expect(fetch.mock.calls[2][0]).toBe("/v1/checks/check/artifacts");
    } finally {
      vi.unstubAllGlobals();
    }
  },
);
