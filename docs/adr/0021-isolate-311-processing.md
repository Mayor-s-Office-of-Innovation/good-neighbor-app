# ADR 0021: Isolate background 311 processing and alarms

## Status

Accepted (2026-10-29). Deployment follows the environment promotion pipeline.

## Context

311 filing and closure jobs shared the submissions queue, worker capacity and
DLQ with unrelated background work. A submissions DLQ alarm could therefore
describe failed 311 reconciliation rather than a broken submission pipeline.
Queue depth alone also misses terminal failures acknowledged by the worker.

## Decision

Route new `SF311_OUTBOX` jobs through a dedicated SQS queue, DLQ and Lambda with
its own IAM role and five concurrent executions. Reuse the existing job executor,
durable checkpoints and retry policy. Retain the general worker's 311 handler
for messages already dispatched to the old queue. Preserve the single-queue
fallback in local development.

Separate operation failures from action outcomes using bounded, payload-free
EMF events. Alarm independently on connection failures, reconciliation needing
attention, other terminal action failures, DLQ depth and queue delay. Known 311
errors no longer inflate the generic server-error metric; uncaught API and
platform failures still retain their alarms. Include inline 311 operations in
the metrics without moving their execution paths.

## Consequences

Additional resources and reserved capacity provide clear operational ownership
and keep queued 311 calls from occupying the general worker. A metrics-only split
would leave mixed DLQs and shared capacity. Event alarms identify observed
failures rather than a durable backlog, so quiet periods cannot prove recovery.

The change does not fix feed parsing, modify City ticket semantics or replay
existing jobs. Legacy DLQ entries require separate, diagnosed recovery. CI must
retain queues with pending work during rollback. Thresholds, metric populations,
queries and rollout checks are documented in the [311 runbook](../runbooks/sf311.md).
