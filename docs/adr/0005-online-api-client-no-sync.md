# ADR 0005: Thin Online API Client, No Sync Layer

## Status

Accepted (2026-08-15). Refines the frontend↔backend contract left open by
[ADR 0001](0001-architecture-stack.md); the offline/sync system it defers is a post-MVP
"offline pass".

## Context

ADR 0001's stack assumed offline capture with a client-side sync system. As the MVP was built,
the field-app flow reduced to plain request/response: writes happen when the user acts, reads
happen when a screen loads, and only the in-progress walk needs to stay local. A full sync
layer (write queue, background replay, conflict handling) is real complexity that would iterate
against still-moving screens, so it is not worth building for the MVP.

## Decision

The field app talks to the backend through a **thin online API client** (`api.js`) — plain
request/response, **not** a sync layer. Full cutover: `api.js` replaces the mock analyzer and
local `checks` persistence, with **no config-flagged coexistence** and **no silent local
fallback** — when the backend is unavailable, the submit/review path **shows an error**. There
is no `sync.js`. The in-browser photo leg is a presigned `PUT` to S3, then register → SQS →
worker → analyzer. The idempotency design (client-generated ULID as a conditional-write key)
still carries the offline story when it is turned on later.

## Consequences

- No write queue, replay, or conflict-resolution code in the MVP; the sync *system* is deferred
  together with PWA/service-worker offline support as one later pass.
- Backend availability is a hard dependency for submit/review — surfaced as an error, never
  masked by a local demo mode.
- Turning offline on later is additive (queue + replay in front of the same `api.js`), not a
  rewrite, because writes are already idempotent.
