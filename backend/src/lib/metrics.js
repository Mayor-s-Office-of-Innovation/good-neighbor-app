/*
  emitMetrics — the repo's business-metric convention (see
  docs/runbooks/observability.md for the metric catalog and dashboard).

  One single-line JSON `console.log` per notable event, in CloudWatch
  Embedded Metric Format (EMF): the `_aws` envelope tells CloudWatch Logs to
  turn the named numeric fields into real metrics on ingest, and the line
  itself stays a normal log event so Logs Insights can group on `marker`,
  `checkId`, `siteId`, … exactly like the logServerError / marker lines.

  Why EMF rather than PutMetricData: no SDK call on the request path, no
  extra latency or IAM, and the metric and its log context are the same
  record. Why not a Streams consumer: the two emission points (analyze
  worker, completeCheck) already know kind, outcome and timing.

  Rules:
  - Never throws (same posture as logServerError).
  - Dimensions stay TINY (`Kind`, `EvidenceKind`, `FlowType`): every
    distinct dimension-value combination is a billed metric. Ids such as
    siteId / checkId / artifactId go in `props`, never in `dimensions`.
  - Namespace comes from METRICS_NAMESPACE (lambda.tf). When it is unset
    (local dev, tests) the line is printed WITHOUT the `_aws` envelope, so
    the same code logs but nothing is ingested as a metric.
*/

const NAMESPACE_ENV = "METRICS_NAMESPACE";

/** @typedef {"Count" | "Milliseconds" | "Bytes" | "None"} MetricUnit */

/**
 * @typedef {object} MetricValue
 * @property {string} name metric name, PascalCase (e.g. "AnalysisCompleted")
 * @property {number} value finite number; non-finite values are dropped
 * @property {MetricUnit} [unit] defaults to "Count"
 */

/**
 * @typedef {object} MetricEvent
 * @property {string} marker Logs Insights grouping key, usually the main metric name
 * @property {MetricValue[]} metrics one or more metric values for this event
 * @property {Record<string, string>} [dimensions] low-cardinality only
 * @property {string[][]} [dimensionSets] which dimension roll-ups CloudWatch
 *   should materialize; defaults to one set holding every key in `dimensions`.
 *   Every key named here must exist in `dimensions`.
 * @property {Record<string, unknown>} [props] searchable context (ids, reasons)
 */

/**
 * Emit one EMF line. Safe to call anywhere; a logging failure is swallowed.
 * @param {MetricEvent} event
 * @param {{ namespace?: string, now?: () => number, env?: NodeJS.ProcessEnv }} [opts]
 *   test seams: namespace override, clock, environment
 * @returns {void}
 */
export function emitMetrics(event, opts = {}) {
  try {
    const env = opts.env ?? process.env;
    const namespace = opts.namespace ?? env[NAMESPACE_ENV];
    const dimensions = event.dimensions ?? {};
    const metrics = (event.metrics ?? []).filter((m) =>
      Number.isFinite(m.value),
    );

    /** @type {Record<string, unknown>} */
    const line = {};
    if (namespace && metrics.length > 0) {
      const dimensionSets = (
        event.dimensionSets ?? [Object.keys(dimensions)]
      ).map((set) => set.filter((key) => key in dimensions));
      line._aws = {
        Timestamp: (opts.now ?? Date.now)(),
        CloudWatchMetrics: [
          {
            Namespace: namespace,
            Dimensions: dimensionSets,
            Metrics: metrics.map((m) => ({
              Name: m.name,
              Unit: m.unit ?? "Count",
            })),
          },
        ],
      };
    }
    line.marker = event.marker;
    Object.assign(line, dimensions, event.props ?? {});
    for (const m of metrics) line[m.name] = m.value;
    console.log(JSON.stringify(line));
  } catch {
    // Metrics must never break the request or the worker.
  }
}

/**
 * Milliseconds elapsed since `startedAt` (a `Date.now()` stamp), rounded.
 * @param {number} startedAt
 * @param {() => number} [now]
 * @returns {number}
 */
export function elapsedMs(startedAt, now = Date.now) {
  return Math.max(0, Math.round(now() - startedAt));
}
