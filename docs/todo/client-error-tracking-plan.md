# Plan: client error tracking → PostHog (lean-client beacon)

Status: **approved — build in progress** (branch `feature/error-tracking`,
2026-08-31). Amended after review against a sibling DIY-first plan (since
removed; its governance gate, digest fallback, handler placement, structured
server logging, and `instrument.js` conventions are folded in; its DIY-first
posture and offline error queue are declined — see
[Alternatives](#alternatives-considered)).
Date: 2026-08-31

**In one sentence:** vendor-free client capture → own API route → Lambda
forwarder → PostHog; the forwarder ships in **log-only mode whenever the key
is absent** (the pre-keys default, still the local-dev behavior), and **MOI
granted the egress sign-off 2026-08-31** — once the Phase 0 keys are set, it
goes live with no code change.

## The decision

Track client-side *and* server-side errors with **PostHog**, chosen because
contributors need interactive, account-based access without AWS accounts
(PostHog Cloud free tier: unlimited seats, ~1M events/mo). This is a decided
need, not an open question.

The architecture deliberately keeps the **frontend vendor-free**:

- No PostHog JS SDK. The browser ships a ~0.5 KB native capture module that
  reports via `navigator.sendBeacon()` to our **own** API route.
- The api Lambda validates + **re-scrubs** the report and **forwards** it to
  PostHog's ingest HTTP API. Provider choice becomes a server-side detail —
  swapping PostHog for Sentry (or anything with an ingest API) never touches
  the client.
- **CSP is untouched.** Same-origin beacon stays inside the existing
  `connect-src 'self'` (`infra/modules/app/main.tf:462`); no new third-party
  origins, no `connect-src` edits. This is a design invariant, not a side effect.

```
Browser  (onerror + unhandledrejection, ~0.5 KB, scrubbed)
  │  sendBeacon → POST /v1/client-errors        (same-origin, CSP unchanged)
  ▼
api Lambda  (validate + re-scrub + size-cap + map to $exception)
  │  key resolved? ─ no → log-only (structured JSON, no egress)
  │                 └ yes → fetch https://us.i.posthog.com/batch/
  ▼
PostHog  (grouping, dashboards, contributor accounts)
```

Server-side visibility has an explicit **baseline that stands on its own,
independent of PostHog**: a named structured-log convention (`logServerError`,
Phase 4) emits every uncaught server error as one JSON `console.error` line,
making **CloudWatch the source of truth** for server errors — groupable via
Logs Insights, alarming via metric filters — from day one. The PostHog leg is
purely additive on top: grouping server errors in PostHog can come later by
emitting `$exception` from the same helper (one call, same secret) — optional
follow-up, not MVP, and its absence never leaves a server-error blind spot.

Why not the PostHog SDK, honestly recorded:

- SDK is ~40 KB gzipped, adds a third-party script origin to `script-src`, and
  its beacons are exactly what ad-blockers/ITP break. We'd also need a
  CloudFront `/ingest/*` proxy to keep the CSP clean — more Terraform for
  capture the platform already gives us for free.
- What we give up vs. the SDK: breadcrumbs, session replay, client-side
  framing. PostHog still groups exceptions into issues server-side, so for
  "know what broke and show contributors" the loss is small. Revisit if we ever
  want session replay — that's the feature that would justify the SDK + proxy.

## Scope

| Phase | What | Status |
|-------|------|--------|
| 0 | PostHog org + two projects (dev/prod), keys provisioned | In this plan |
| 1 | Backend: route, intake handler (validate + re-scrub), forwarder, WAF rate rule, tests | In this plan |
| 2 | Frontend: `error-report.js` capture module (scrub + thrott/dedupe) + tests | In this plan |
| 3 | Source maps: Vite build flag + CI upload, kept out of S3 | In this plan |
| 4 | Baseline: `logServerError` convention (CloudWatch = server-error source of truth) + metric filters + alarm | In this plan |
| 5 | E2E verify in dev, keys → secrets, flip live in prod, ADR + docs index | In this plan |
| — | Fallback sharing digest (only if egress is ever revoked) | **Conditional** — see [Fallback sharing path](#fallback-sharing-path-only-if-egress-is-ever-revoked) |

Out of scope (explicitly): breadcrumbs/session context ring buffer, session
replay, PostHog web analytics events (pageviews etc.), **offline queueing of
error reports** (contradicts the deferred-offline decision in ADR 0005 /
AGENTS.md; a lost offline error report is an acceptable loss — revisit with the
real offline pass), sampling knobs (100% capture for MVP; volume is tiny).

---

## Governance gate (binding)

This is a resident-facing CCSF app. **Forwarding error payloads to PostHog
Cloud is a data-egress decision (MOI/COIT), not a technical one.** Consequences
for this plan:

- The forwarder ships **log-only whenever the key is absent** (Phase 1) — the
  pipeline is fully built and exercised, but payloads only land in CloudWatch
  until a key is configured. This was the governance-gate default pre-sign-off
  and remains the local-dev / rollback behavior permanently.
- **Scrub twice.** Client scrubs before send (strip query strings, drop PII-ish
  fields, size-cap); the Lambda **re-scrubs on intake** (never trust the client)
  before mapping/forwarding. Phase 3's sourcemap step never publishes `.map`
  files publicly.
- **Sign-off: GRANTED (MOI, 2026-08-31)** — the egress gate is cleared. The
  log-only → live flip now waits only on the Phase 0 keys (secret values +
  GH Environment secrets). Until the first dev apply validates the
  Terraform, the endpoint still delivers value via CloudWatch (structured
  logs + alarms).

## Phase 0 — PostHog setup (no code)

1. Create a PostHog org (US cloud — `us.i.posthog.com`); two projects **GNP dev**
   and **GNP prod**, mirroring the Terraform `dev`/`prod` split.
2. Note each project's **Project API key** — write-only ingest keys, but we keep
   them server-side anyway (CSP invariant + provider-swap freedom).
3. Create one **Personal API key** (for source-map upload in CI only); store as
   `POSTHOG_PERSONAL_API_KEY` in the existing `dev` and `prod` **GitHub
   Environment** *secrets* (not variables — secrets so the project key used for
   the CLI is masked in logs too; deploy.yml already gates on those
   environments).
4. Invite contributors to the org; note the free-tier caveat: org-wide coarse
   permissions — anyone invited sees both projects. Acceptable for MVP; the
   alternative (Sentry's finer ACLs) was weighed and declined (see Alternatives).

## Phase 1 — backend route + intake + forwarder

**Terraform** (`infra/modules/app/api.tf`, `secrets.tf`, `iam.tf`,
`main.tf` WAF):

- Add `POST /v1/client-errors` to `local.api_routes`. Register it in **all
  three** places (per the repo's API contract): the Terraform route set, the
  `routes` table in `backend/src/lambda/api.js`, and
  `backend/scripts/local-api.mjs`.
- New secret `aws_secretsmanager_secret.posthog_project_api_key` — modeled on
  `analyzer_api_key` (secrets.tf): Terraform creates the container; value set
  out-of-band via `put-secret-value`; KMS + `var.tags`; same
  `checkov:skip=CKV2_AWS_57` rationale. Key is write-only/ingest-only.
- IAM: `secretsmanager:GetSecretValue` on that ARN for the **api** Lambda role only.
- Lambda env: `POSTHOG_HOST` (default `https://us.i.posthog.com`) + secret ARN.
- **Abuse guard: WAF rate-based rule** — API Gateway v2 has stage-level throttle
  only (a stage cap would throttle every route to error-endpoint levels), but a
  CLOUDFRONT-scoped WAF ACL is already attached (`aws_wafv2_web_acl.web`,
  `infra/modules/app/main.tf:503` → `cloudfront.tf:38`). Add a
  `RATE_BASED` rule with a scope-down statement matching the
  `/v1/client-errors` path so only this endpoint is rate-limited. (WAF us-east-1
  placement is already handled by the module's existing provider setup.)

**Intake handler** — `backend/src/handlers/client-errors.js` (alongside
`health.js`, returns `jsonResponse`), routed in `api.js`'s `routes` map and
mirrored in `local-api.mjs`. The handler:

1. Validate: JSON object, `type` ∈ {`Error`, `UnhandledRejection`}, `message`
   string ≤ 2 KB, `stack` string ≤ 16 KB, `source`/`release`/`id` short
   strings. Always respond **204** (never signal validity to a possible
   abuser); drop garbage.
2. **Re-scrub server-side** (mirror of the client scrub — see Governance):
   strip query strings from any URL-ish field, drop non-allowlisted fields,
   re-cap sizes.
3. Emit one structured JSON log line per report: forwarded reports get an INFO
   marker; validation drops get `ClientErrorDropped` (so Phase 4's metric
   filters have an abuse signal to alarm on — silent drops would hide exactly
   what we alarm on).
4. Map to PostHog `$exception` and `await fetch()` with a **3 s timeout**;
   swallow all forwarder failures into `ClientErrorForwardFailed` WARNs (an
   error-tracker outage must never create app errors). Client gets 204 either
   way. Outbound HTTPS from the api Lambda is already proven (analyzer calls
   for `description:validate`) — no VPC/NAT work expected.

Payload → event mapping (kept mechanical so provider swaps stay trivial):

```json
{
  "api_key": "<project key from Secrets Manager>",
  "batch": [{
    "event": "$exception",
    "distinct_id": "<random per-browser uuid from the client payload>",
    "properties": {
      "$exception_type": "Error",
      "$exception_message": "...",
      "$exception_stack_trace": "...",
      "$exception_handling": "unhandled",
      "release": "<commit sha or 'dev'>",
      "app_source": "/check",
      "user_agent": "<from event.headers, set server-side — client doesn't send it>",
      "$process_person_profile": false
    },
    "timestamp": "<ISO from payload ts>"
  }]
}
```

`$process_person_profile: false` keeps error events from building person
profiles — no PII surface, and we don't burn on person creation. The payload
carries **no user content by design** (see PII note below).

**Log-only mode — the exact semantics** (the first thing to get wrong):

- Forwarder reads the secret **once per container** (module-scope cache; the
  analyzer pattern already does per-container config) — never per-report.
- `GetSecretValue` on a container with no value set **throws**, so the
  no-key case is caught and treated as **quiet log-only** (validate →
  re-scrub → structured log line → 204, no WARN spam) — the state between
  first apply and `put-secret-value`, the permanent local-dev behavior, and
  the built-in kill switch if egress ever needs to be revoked
  (`put-secret-value ""` → containers resolve empty → log-only).
- Present-but-fetch-fails (transient/re-issue) → WARN +
  `ClientErrorForwardFailed`, still 204.
- Local dev: `local-api.mjs` is log-only unless `POSTHOG_PROJECT_API_KEY` is
  set in `.env.local` (mirrors `ANALYZER_API_KEY`; `.env.example` updated).

**Tests** (Vitest, dependency-free per repo convention): handler validation
table-tests (oversize/malformed/garbage → 204 + `ClientErrorDropped` line),
server re-scrub cases, forwarder mapping snapshot, timeout/fetch-failure → 204
+ WARN path, **empty-secret-container → quiet log-only**, log-only mode when
env unset.

## Phase 2 — frontend capture module

**`frontend/src/services/error-report.js`** (~60 lines, no deps), following the
**`instrument.js` conventions** (`frontend/src/services/instrument.js`):
toggle via `localStorage['gnp:errors'] = 'on'|'off'`, **on by default in prod**,
off under the test runner (`MODE === 'test'`), no-op-safe when
`localStorage`/`navigator` are unavailable (try/catch like `instrument.js`).

- Install `window.addEventListener('error')` + `'unhandledrejection'` at app
  bootstrap from `main.js` (installed immediately — it's tiny, and early errors
  are the ones you want). Skip `error` events with no `event.error` — those are
  resource-load failures whose only content is "Script error." noise.
- Collect: `type`, `message`, `stack`, `source` = `location.pathname` (no query
  string), `ts`; keep a `distinct_id` = random UUID in `localStorage` and a
  per-session dedupe + rate cap (identical `type+message` once per session;
  cap N/min) so a broken render can't flood the endpoint.
- **Scrub before send** (first of the two scrubs): strip query strings, send
  only allowlisted fields, cap payload size.
- Send with `navigator.sendBeacon('/v1/client-errors', blob)` — same-origin, no
  custom headers, so no CORS preflight ever fires; `fetch(...,
  {keepalive:true})` fallback for the rare browser without beacon. Never
  `await`-block navigation; never surface reporting failures to the user.
  Failures are dropped silently (no offline queue — see scope).
- Release stamp: injected at build time via Vite `define` —
  `__RELEASE__ = github.sha` in CI, `'dev'` locally. JS-only define, so the
  CSP's inline-script hash in `infra/modules/app/main.tf` is untouched.

**Tests**: mock `sendBeacon`; assert payload shape, scrub (no query strings,
allowlist), dedupe/throttle, beacon-absent → quiet no-op, `gnp:errors=off`
disables.

## Phase 3 — source maps

- `frontend/vite.config.js`: `build: { sourcemap: true }` (comment already in
  place about CSP/hash interplay — sourcemaps don't affect it).
- `deploy.yml`, after "Build frontend": `posthog-cli sourcemap upload` for
  `frontend/dist` with `--release <sha>` using `POSTHOG_PERSONAL_API_KEY`
  (env-scoped GH secret) and the right dev/prod project API key (also a GH
  Environment secret — uniform handling, and avoids needing
  `secretsmanager:GetSecretValue` on the deploy role).
- **Change the S3 publish step**: `aws s3 sync ... --exclude "*.map"` —
  public sourcemaps would leak full source; they belong in PostHog only.
- Uploads happen per deploy, so symbolicated traces line up with the `release`
  stamp the client sends (post-deploy stragglers on an old release
  symbolicate against the still-uploaded previous maps — acceptable; PostHog
  retains them).

## Phase 4 — structured server logging (the named baseline) + guardrails + alarm

- **The baseline convention: `logServerError`** (new helper, e.g.
  `backend/src/lib/log-server-error.js`, structured JSON via one
  `console.error` call) — the **named, repo-wide convention for server-side
  error logging**, adopted at the dispatch layer so no handler has to remember
  it:
  - wrapped around the dispatch in `backend/src/lambda/api.js` and the worker
    entry points (`backend/src/lambda/worker.js`, `backend/src/workers/*`):
    uncaught handler errors log `{ level:"error", route, reqId, name, message,
    stack }` as a single JSON line, so CloudWatch **Logs Insights** can group
    server errors and this plan's alarms have a clean signal.
  - **CloudWatch is the source of truth for server errors** — full fidelity
    (complete stack, reqId, all fields), independent of whether the PostHog
    leg is enabled, gated, or swapped out. PostHog (if/when the `$exception`
    follow-up lands) mirrors from the same helper; it never replaces it.
  - This is the repo's server-side story in full; no vendor SDK — and it costs
    one helper.
- **Two metric filters** on the api Lambda log group, both worth watching:
  - `ClientErrorForwardFailed` → alarm (PostHog ingest dying / network egress
    broken).
  - `ClientErrorDropped` → alarm at a high threshold only (abuse signal, not
    an app-failure signal).
  - Plus the existing generic idea from MVP-TODO's harden gates: elevated
    handler `ERROR` rate alarm (`logServerError` makes this a one-line
    filter).
- Route-level protection from Phase 1 (WAF rate rule scoped to the path) +
  payload caps. Unauthenticated endpoint → note in `security-review.md`
  follow-ups.

## Phase 5 — verify, configure keys, ship, record

1. E2E in dev **in log-only mode first**: throw in a handler, throw in the
   console, kill network mid-check → confirm structured lines in CloudWatch,
   validation/dedupe behavior, and 204s everywhere. This proves the whole
   pipeline with **zero egress**.
2. ~~**Egress sign-off (MOI/COIT)**~~ — **GRANTED (MOI, 2026-08-31)**, clearing
   the PostHog blocker. Remaining to flip log-only → live: set the secret
   values (`put-secret-value`), add the GH Environment secrets (Phase 0),
   verify events arrive grouped in GNP dev after the next dev deploy.
3. Prod keys → Secrets Manager + GH env; first prod release exercises the
   sourcemap upload path.
4. Write **ADR 0008 — lean client error capture via own endpoint** (the
   vendor-free decision + alternatives, supersedeable like the rest).
5. Update `docs/README.md` index (new plan/thread) + check off in MVP-TODO.

## Fallback sharing path (only if egress is ever revoked)

Sign-off was **granted 2026-08-31**, but if it's ever withdrawn, contributors
still need *something* — the pre-approved plan B, built **only** in that case:
a scheduled (EventBridge) digest Lambda runs a Logs Insights query
(last 24h errors, grouped/counted), scrubs, and posts to Slack/email.
Recipients need no AWS access, and the same egress question applies to the
digest sink (Slack/email) anyway — so this is not a way to dodge the gate, only
a lower-stakes one. Do **not** build it now; it's redundant while PostHog is
live and Phase 4's alarms already cover the "we're failing now" need in CloudWatch.

---

## Alternatives considered

- **PostHog SDK in the frontend** (canonical vendor setup): best capture
  fidelity (breadcrumbs/replay), but ~40 KB, `script-src`/`connect-src` CSP
  changes, CloudFront `/ingest/*` proxy to keep it clean, and ad-blocker
  interference. Declined for MVP per the "no weight for error-collecting"
  constraint; the lean pipeline doesn't preclude adding it later.
- **Sentry** (SDK or via our forwarder): more mature error UX, finer free-tier
  ACLs (good fit for contributor access), 5k errors/mo free. PostHog won on
  unlimited seats + analytics-in-one-place; our forwarder keeps the swap cheap
  if grouping quality disappoints.
- **Vendor SDK on the Lambdas** (Sentry layer / posthog-node): out of scope —
  CloudWatch + the `logServerError` convention covers server visibility; server
  error *grouping* in PostHog is a later `$exception` emit from the same helper
  (no
  SDK needed).
- **DIY-only baseline, tracker conditional** (the sibling plan's posture):
  rejected after discussion — the need for interactive,
  account-based contributor access is already decided, and CloudWatch
  (digest or dashboard) can't grant it. Its governance gate, scrub-twice,
  digest fallback, handler placement, structured server logging, and
  `instrument.js` conventions **are** adopted, above.
- **Offline IndexedDB queue for error reports**: rejected — contradicts the
  deferred-offline decision (ADR 0005, AGENTS.md); a lost offline error report
  is an acceptable loss. Revisit with the offline pass.
- **CloudWatch dashboard shared via Cognito / Managed Grafana**: interactive but
  cloud-shaped and
  IAM-adjacent; PostHog accounts are strictly easier for contributors and the
  fallback digest covers the no-PostHog world.

## PII / data classification note

Payloads are technical-only: exception type/message/stack, route, release,
random per-browser UUID, UA (set server-side). No user text, no IDs, no
localStorage dumps, no query strings — and, unlike the original draft of this
plan, scrubbing happens **twice** (client allowlist + server re-scrub), per the
governance gate. Stack traces can in principle embed sensitive strings from
code/messages — that risk, plus the PostHog Cloud egress itself, is exactly
what the MOI egress sign-off (granted 2026-08-31) covers; the forwarder
remains the single choke point for any future scrubbing rules.

## Open questions for review

1. ~~Route name~~ — `POST /v1/client-errors` settled.
2. ~~Key storage~~ — settled: GH Environment **secrets** for both the personal
   CLI key and the per-project ingest key used by sourcemap upload;
   Secrets Manager solely for the runtime ingest key.
3. **Alarm recipients** — SNS email to whom? (Blocking for Phase 4 only.)
4. **Region/org naming** — confirm US cloud + org/project names at Phase 0.
5. ~~Egress sign-off owner + ticket~~ — **settled: MOI sign-off granted
   2026-08-31** (recorded in the Governance gate above).