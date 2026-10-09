import { afterEach, describe, expect, it, vi } from "vitest";
import { elapsedMs, emitMetrics } from "./metrics.js";

/** @returns {import("vitest").MockInstance} */
function spyLog() {
  return vi.spyOn(console, "log").mockImplementation(() => {});
}

/**
 * @param {import("vitest").MockInstance} log
 * @returns {any}
 */
function lastLine(log) {
  return JSON.parse(/** @type {string} */ (log.mock.calls.at(-1)?.[0]));
}

describe("emitMetrics", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits one single-line EMF record when a namespace is configured", () => {
    const log = spyLog();

    emitMetrics(
      {
        marker: "AnalysisCompleted",
        dimensions: { Kind: "photo" },
        metrics: [
          { name: "AnalysisCompleted", value: 1 },
          { name: "AnalyzerLatencyMs", value: 4210, unit: "Milliseconds" },
        ],
        props: { checkId: "chk_01", artifactId: "art_1", siteId: "site-1" },
      },
      { namespace: "gnp-test-app", now: () => 1_760_000_000_000 },
    );

    expect(log).toHaveBeenCalledTimes(1);
    const raw = /** @type {string} */ (log.mock.calls[0]?.[0]);
    expect(raw.split("\n")).toHaveLength(1);
    expect(JSON.parse(raw)).toEqual({
      _aws: {
        Timestamp: 1_760_000_000_000,
        CloudWatchMetrics: [
          {
            Namespace: "gnp-test-app",
            Dimensions: [["Kind"]],
            Metrics: [
              { Name: "AnalysisCompleted", Unit: "Count" },
              { Name: "AnalyzerLatencyMs", Unit: "Milliseconds" },
            ],
          },
        ],
      },
      marker: "AnalysisCompleted",
      Kind: "photo",
      checkId: "chk_01",
      artifactId: "art_1",
      siteId: "site-1",
      AnalysisCompleted: 1,
      AnalyzerLatencyMs: 4210,
    });
  });

  it("reads the namespace from METRICS_NAMESPACE", () => {
    const log = spyLog();

    emitMetrics(
      { marker: "CheckStarted", metrics: [{ name: "CheckStarted", value: 1 }] },
      { env: { METRICS_NAMESPACE: "gnp-dev-app" } },
    );

    const line = lastLine(log);
    expect(line._aws.CloudWatchMetrics[0].Namespace).toBe("gnp-dev-app");
    // No dimensions → one empty dimension set (a plain, undimensioned metric).
    expect(line._aws.CloudWatchMetrics[0].Dimensions).toEqual([[]]);
  });

  it("logs the line without the _aws envelope when no namespace is set", () => {
    const log = spyLog();

    emitMetrics(
      {
        marker: "CheckStarted",
        metrics: [{ name: "CheckStarted", value: 1 }],
        props: { checkId: "chk_01" },
      },
      { env: {} },
    );

    expect(lastLine(log)).toEqual({
      marker: "CheckStarted",
      checkId: "chk_01",
      CheckStarted: 1,
    });
  });

  it("materializes several dimension roll-ups from one line", () => {
    const log = spyLog();

    emitMetrics(
      {
        marker: "CheckCompleted",
        dimensions: { FlowType: "perimeter", EvidenceKind: "photos" },
        dimensionSets: [["FlowType"], ["FlowType", "EvidenceKind"]],
        metrics: [{ name: "CheckCompleted", value: 1 }],
      },
      { namespace: "ns" },
    );

    expect(lastLine(log)._aws.CloudWatchMetrics[0].Dimensions).toEqual([
      ["FlowType"],
      ["FlowType", "EvidenceKind"],
    ]);
  });

  it("drops dimension-set keys that are not present as dimensions", () => {
    const log = spyLog();

    emitMetrics(
      {
        marker: "X",
        dimensions: { Kind: "text" },
        dimensionSets: [["Kind", "Missing"]],
        metrics: [{ name: "X", value: 1 }],
      },
      { namespace: "ns" },
    );

    expect(lastLine(log)._aws.CloudWatchMetrics[0].Dimensions).toEqual([
      ["Kind"],
    ]);
  });

  it("drops non-finite values and skips the envelope when nothing is left", () => {
    const log = spyLog();

    emitMetrics(
      {
        marker: "AnalyzerCall",
        metrics: [
          {
            name: "AnalyzerLatencyMs",
            value: Number.NaN,
            unit: "Milliseconds",
          },
        ],
      },
      { namespace: "ns" },
    );

    const line = lastLine(log);
    expect(line).not.toHaveProperty("_aws");
    expect(line).not.toHaveProperty("AnalyzerLatencyMs");
    expect(line.marker).toBe("AnalyzerCall");
  });

  it("never throws, even on an unserializable payload", () => {
    const log = spyLog();
    /** @type {any} */
    const circular = {};
    circular.self = circular;

    expect(() =>
      emitMetrics(
        { marker: "X", metrics: [{ name: "X", value: 1 }], props: circular },
        { namespace: "ns" },
      ),
    ).not.toThrow();
    expect(log).not.toHaveBeenCalled();
  });
});

describe("elapsedMs", () => {
  it("rounds and never goes negative", () => {
    expect(elapsedMs(1000, () => 1234.6)).toBe(235);
    expect(elapsedMs(2000, () => 1000)).toBe(0);
  });
});
