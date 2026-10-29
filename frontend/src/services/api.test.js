import { afterEach, describe, expect, it, vi } from "vitest";
import { getUploadRequestId } from "../db.js";
import { trackEvent } from "./analytics.js";
vi.mock("./analytics.js", () => ({
  trackEvent: vi.fn().mockResolvedValue(undefined),
}));
import {
  ApiError,
  dataUrlToBlob,
  editAnalysisCondition,
  getSiteSettings,
  getMediaUrl,
  getTaskUpdates,
  get311RequestDetails,
  getCaptureGuidance,
  putMedia,
  putMediaWithProgress,
  rejectAnalysisCondition,
  REQUEST_TIMEOUT_MS,
  UPLOAD_STALL_MS,
  toDevUploadUrl,
  waitForAnalyses,
  uploadTaskUpdatePhoto,
  uploadArtifact,
} from "./api.js";

vi.mock("../db.js", async (importOriginal) => ({
  ...(await importOriginal()),
  getUploadRequestId: vi.fn().mockResolvedValue("durable-request-1"),
}));

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
      uploadRequestId: "durable-request-1",
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
      expect(options.signal.aborted).toBe(false);
      controller.abort();
      // The request's own signal (caller + time limit) follows the caller.
      expect(options.signal.aborted).toBe(true);
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
    // Each request's signal adds a time limit, so it is not the caller's
    // object; it must abort when the caller's does. The fetch stub hangs
    // until its signal aborts.
    const fetch = vi.fn(
      (_url, /** @type {any} */ options) =>
        new Promise((_resolve, reject) =>
          options.signal.addEventListener("abort", () =>
            reject(new DOMException("Canceled", "AbortError")),
          ),
        ),
    );
    vi.stubGlobal("fetch", fetch);
    const reads = [
      (/** @type {AbortSignal} */ signal) =>
        getTaskUpdates("task", undefined, { signal }),
      (/** @type {AbortSignal} */ signal) =>
        getMediaUrl("check", "photo", { signal }),
      (/** @type {AbortSignal} */ signal) =>
        get311RequestDetails(
          Array.from({ length: 51 }, (_, i) => ({
            taskId: `t${i}`,
            srNum: `s${i}`,
          })),
          { signal },
        ),
    ];
    for (const read of reads) {
      fetch.mockClear();
      const controller = new AbortController();
      const pending = read(controller.signal);
      await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      for (const [, options] of fetch.mock.calls)
        expect(/** @type {any} */ (options).signal.aborted).toBe(true);
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
    // request() wraps the caller's signal with its time limit; forwarding a
    // cancel mid-request is covered by "timeline read cancellation".
    expect(fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
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
    // Durable upload fingerprinting needs Web Crypto; only the optional
    // telemetry UUID API is unavailable in this scenario.
    vi.stubGlobal("crypto", {
      subtle: globalThis.crypto.subtle,
      randomUUID: cryptoApi?.randomUUID,
    });
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

describe("time limits on a weak connection", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** A fetch that never answers; it rejects only when its signal aborts. */
  const hangingFetch = () =>
    vi.fn(
      (_url, /** @type {any} */ options) =>
        new Promise((_resolve, reject) =>
          options.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          ),
        ),
    );

  it("turns a request that never finishes into a lost connection", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("fetch", hangingFetch());
    const pending = getMediaUrl("check", "photo");
    const outcome = expect(pending).rejects.toMatchObject({
      name: "ApiError",
      status: 0,
    });
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    await outcome;
  });

  it("keeps waiting on a request that is slow but inside the limit", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise((resolve) =>
            setTimeout(
              () => resolve(new Response('{"ok":true}', { status: 200 })),
              REQUEST_TIMEOUT_MS - 1000,
            ),
          ),
      ),
    );
    const pending = getMediaUrl("check", "photo");
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS - 1000);
    await expect(pending).resolves.toEqual({ ok: true });
  });

  it("gives a large photo upload more time than a small one", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("fetch", hangingFetch());
    let settled = false;
    const big = new Blob([new Uint8Array(2_000_000)], { type: "image/jpeg" });
    const pending = putMedia("https://bucket.example/a.jpg", big, "image/jpeg");
    void pending.catch(() => {}).finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(UPLOAD_STALL_MS);
    expect(settled).toBe(false);
    // 2 MB at the 20 kB/s floor adds 100 s on top of the stall window.
    await vi.advanceTimersByTimeAsync(100_000);
    await expect(pending).rejects.toMatchObject({
      name: "ApiError",
      status: 0,
    });
  });

  describe("progress uploads", () => {
    /** @type {any[]} */
    let xhrs;
    class FakeXhr {
      constructor() {
        this.listeners = /** @type {Record<string, Function[]>} */ ({});
        this.upload = {
          listeners: /** @type {Function[]} */ ([]),
          addEventListener: (
            /** @type {string} */ _type,
            /** @type {Function} */ fn,
          ) => this.upload.listeners.push(fn),
        };
        this.status = 0;
        xhrs.push(this);
      }
      open() {}
      setRequestHeader() {}
      send() {}
      /** @param {string} type @param {Function} fn */
      addEventListener(type, fn) {
        (this.listeners[type] ||= []).push(fn);
      }
      /** @param {string} type */
      fire(type) {
        for (const fn of this.listeners[type] || []) fn();
      }
      abort() {
        this.fire("abort");
        this.fire("loadend");
      }
      /** @param {number} loaded */
      progress(loaded) {
        for (const fn of this.upload.listeners)
          fn({ lengthComputable: true, loaded, total: 100 });
      }
    }

    it("aborts as a lost connection when no bytes move", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      xhrs = [];
      vi.stubGlobal("XMLHttpRequest", FakeXhr);
      const blob = new Blob(["x"], { type: "image/jpeg" });
      const pending = putMediaWithProgress("https://bucket.example/a", blob);
      const outcome = expect(pending).rejects.toMatchObject({
        name: "ApiError",
        status: 0,
      });
      // Progress keeps it alive past one stall window...
      await vi.advanceTimersByTimeAsync(UPLOAD_STALL_MS - 1000);
      xhrs[0].progress(40);
      await vi.advanceTimersByTimeAsync(UPLOAD_STALL_MS - 1000);
      // ...then silence for a full window ends it.
      await vi.advanceTimersByTimeAsync(1000);
      await outcome;
    });

    it("still reports a cancel by the caller as a cancel", async () => {
      xhrs = [];
      vi.stubGlobal("XMLHttpRequest", FakeXhr);
      const controller = new AbortController();
      const blob = new Blob(["x"], { type: "image/jpeg" });
      const pending = putMediaWithProgress(
        "https://bucket.example/a",
        blob,
        {},
        () => {},
        controller.signal,
      );
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    });
  });
});

describe("uncertain media uploads", () => {
  afterEach(() => vi.unstubAllGlobals());
  it.each(["check", "task"])(
    "reuses %s upload identity after a lost registration response and accepts an existing object",
    async (kind) => {
      const signed = {
        artifactId: "photo-1",
        s3Key: "photos/photo-1",
        uploadUrl: "https://upload.example.test/photo-1",
        uploadHeaders: {},
      };
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify(signed)))
        .mockResolvedValueOnce(new Response(""))
        .mockRejectedValueOnce(new Error("lost registration response"))
        .mockResolvedValueOnce(new Response(JSON.stringify(signed)))
        .mockResolvedValueOnce(new Response("", { status: 412 }))
        .mockResolvedValueOnce(
          kind === "check"
            ? new Response(
                JSON.stringify({ error: "artifact already registered" }),
                {
                  status: 409,
                  headers: { "content-type": "application/json" },
                },
              )
            : new Response("{}"),
        );
      vi.stubGlobal("fetch", fetch);
      const file = new File(["test"], "synthetic.jpg", { type: "image/jpeg" });
      const upload = () =>
        kind === "check"
          ? uploadArtifact("check-1", {
              dataUrl: "data:image/jpeg;base64,dGVzdA==",
              tag: "evidence-1",
            })
          : uploadTaskUpdatePhoto("task-1", "check-1", { file });
      await expect(upload()).rejects.toMatchObject({ status: 0 });
      await expect(upload()).resolves.toMatchObject({ artifactId: "photo-1" });
      expect(JSON.parse(fetch.mock.calls[0][1].body).uploadRequestId).toBe(
        "durable-request-1",
      );
      expect(JSON.parse(fetch.mock.calls[3][1].body).uploadRequestId).toBe(
        "durable-request-1",
      );
      expect(JSON.parse(fetch.mock.calls[5][1].body).artifactId).toBe(
        "photo-1",
      );
      if (kind === "check") {
        expect(
          vi
            .mocked(trackEvent)
            .mock.calls.slice(-6)
            .map(([, props]) => [props.stage, props.outcome]),
        ).toEqual([
          ["presign", "started"],
          ["presign", "completed"],
          ["put", "started"],
          ["put", "completed"],
          ["register", "started"],
          ["register", "completed"],
        ]);
      }
    },
  );
});

describe("upload reservation boundaries", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("keeps distinct same-content task attachments separate while reusing each retry scope", async () => {
    vi.mocked(getUploadRequestId).mockClear();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (url) =>
          new Response(
            JSON.stringify(
              String(url).endsWith("artifacts:presign")
                ? {
                    artifactId: "a",
                    s3Key: "k",
                    uploadUrl: "https://upload.example.test/a",
                    uploadHeaders: {},
                  }
                : {},
            ),
          ),
      ),
    );
    const first = new File(["identical"], "same.jpg", { type: "image/jpeg" });
    const second = new File(["identical"], "same.jpg", { type: "image/jpeg" });
    for (const file of [first, second, first])
      await uploadTaskUpdatePhoto("task", "check", { file });
    const calls = vi.mocked(getUploadRequestId).mock.calls;
    expect(calls[0][0]).not.toBe(calls[1][0]);
    expect(calls[0][0]).toBe(calls[2][0]);
    expect(calls[0][1]).toBe(calls[1][1]);
  });
  it.each(["upload_reservation_conflict", "Check already completed"])(
    "does not hide a registration conflict: %s",
    async (error) => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce(
            new Response(
              JSON.stringify({
                artifactId: "a",
                s3Key: "k",
                uploadUrl: "https://upload.example.test/a",
              }),
            ),
          )
          .mockResolvedValueOnce(new Response(""))
          .mockResolvedValueOnce(
            new Response(JSON.stringify({ error }), {
              status: 409,
              headers: { "content-type": "application/json" },
            }),
          ),
      );
      await expect(
        uploadArtifact("check", {
          dataUrl: "data:image/jpeg;base64,dGVzdA==",
          tag: "attachment",
        }),
      ).rejects.toMatchObject({ status: 409, body: { error } });
    },
  );
});
