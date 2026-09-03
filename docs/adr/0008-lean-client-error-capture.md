# ADR 0008: Lean client error capture via own endpoint → PostHog

## Status

Accepted (2026-08-31). Build state: phases 1–4 built + green (2026-08-31,
branch `feature/error-tracking`) — intake handler (validate + double-scrub +
`ClientErrorDropped` marker), forwarder (**log-only until MOI/COIT egress sign-off**; Secrets
Manager key, module-cached, 3 s timeout), `logServerError` structured-logging convention,
WAF rate rule, sourcemaps (CI upload to PostHog, excluded from public S3), metric-filter
alarms. MOI egress sign-off granted 2026-08-31; rollout completion (PostHog keys, alarm
recipients, first dev apply) is tracked on the issue tracker. A sibling DIY-first proposal
(same date, since removed) was reviewed and folded in — its governance gate, scrub-twice
approach, digest fallback, structured server logging, and `instrument.js` toggle
conventions were adopted, while its DIY-first posture (tracker conditional) and offline
error queue were declined.

## Context

We need to know when client- or server-side errors occur in the field app, and
**contributors need to see those errors without AWS access** (contractors, PMs,
MOI stakeholders — account-based access is a decided need, and CloudWatch's
access model is IAM, so no CloudWatch surface can grant it).

Three hard constraints shaped the decision:

1. **Almost no frontend weight.** The frontend has one runtime dependency
   (Web Awesome) and a deliberately lean, dependency-free house style. PostHog's
   browser SDK is ~40 KB gzipped, adds a third-party script origin to
   `script-src`, and needs a CloudFront `/ingest/*` proxy to keep our locked
   CSP (`connect-src 'self'`, `infra/modules/app/main.tf`) clean — and its
   beacons are exactly what ad-blockers/ITP break.
2. **Resident data governance.** GNP is a resident-facing CCSF app; forwarding
   error payloads to a third-party cloud is a **data-egress decision
   (MOI/COIT)**, not a technical one. Error payloads can carry incidental PII
   in messages/stacks.
3. **Provider longevity.** Contributors interact with whatever UI the tracker
   provides; we want the option to swap trackers without touching clients.

## Decision

**Vendor-free client capture, our own intake route, server-side forwarding to
PostHog — with forwarding log-only until the egress gate clears.**

- **Client (~0.5 KB, no SDK):** `frontend/src/services/error-report.js`
  registers `error` + `unhandledrejection` listeners, scrubs (allowlisted
  fields, no query strings, size caps), dedupes + rate-caps, and sends via
  `navigator.sendBeacon()` (fetch-keepalive fallback) to same-origin
  `POST /v1/client-errors`. Same-origin keeps `connect-src 'self'` untouched;
  `instrument.js` conventions (`gnp:errors` toggle, test-mode off). Release
  stamp via a Vite `define` (`__RELEASE__`); sourcemaps are uploaded to PostHog
  per deploy from CI and **excluded from the public S3 sync**.
- **Intake:** `backend/src/handlers/client-errors.js` — public, always 204,
  never signals validity (abuser-proofing), re-scrubs server-side (the second
  of two scrubs), emits structured JSON logs with `ClientErrorDropped` /
  `ClientErrorForwardFailed` markers so metric filters count abuse and forward
  failures.
- **Forwarder:** `backend/src/handlers/forwarder.js` maps the report to a
  PostHog `$exception` event and POSTs to the ingest API with a 3 s timeout;
  failures WARN and swallow (a tracker outage must never create app errors).
  The project API key lives in Secrets Manager (container-only in Terraform,
  value out-of-band — same pattern as the analyzer key). **Missing key =
  quiet log-only mode.** **MOI egress sign-off was granted 2026-08-31**, so
  the log-only → live flip needs only the Phase 0 keys (secret values +
  GH Environment secrets); log-only remains the built-in fallback whenever a
  key is absent (e.g. local dev).
- **Server-side baseline:** `backend/src/lib/log-server-error.js` defines the
  repo's structured error-logging convention; the api dispatch and worker
  entry points wrap uncaught errors into single-line JSON. **CloudWatch is the
  source of truth for server errors** — independent of PostHog; metric-filter
  alarms (forward-failed, drops, server-error rate → SNS) page on the "failing
  now" case. An optional later `$exception` mirror for server errors would
  emit from this same helper.
- **Abuse guard:** API Gateway v2 has stage-level throttle only, so the public
  intake gets a dedicated **WAF rate-based rule** with a `/v1/client-errors`
  path scope-down (the CLOUDFRONT-scoped ACL already existed) — 100 req/5min/IP.
- **Contributor access:** PostHog Cloud free tier (unlimited seats, both dev
  and prod projects); contributors get accounts, not IAM. Fallback if egress
  ever has to be revoked: a scheduled digest Lambda (Logs Insights →
  Slack/email) — planned, not built.

## Alternatives considered

- **PostHog JS SDK in the browser** (canonical vendor setup): best capture
  fidelity (breadcrumbs/replay) but ~40 KB, CSP changes, a CloudFront ingest
  proxy, and ad-blocker interference — declined under constraint 1. Revisit if
  session replay is ever wanted (that's the feature that would justify it).
- **Sentry** (SDK or via our forwarder): more mature error UX and finer
  free-tier ACLs; PostHog won on unlimited seats + analytics-in-one-place.
  The forwarder keeps a swap cheap.
- **DIY-only, tracker conditional** (the sibling proposal): rejected — the
  need for account-based contributor access was already decided, and no
  CloudWatch shape grants it. Its governance and hygiene elements were kept
  (see Status).
- **Vendor SDK on the Lambdas:** CloudWatch + the logging convention covers
  server visibility; a vendor SDK there adds weight without a new capability
  we need yet.

## Consequences

Trivially small client cost (~0.5 KB + one beacon per real error), zero CSP
changes, no ad-blocker dependence, provider swaps confined to one server-side
module, and full server-side visibility from day one in CloudWatch — at the
cost of breadcrumbs/session replay (PostHog still groups exceptions
server-side, so triage quality holds) and one more route to keep in step in
the three places the API contract lives.