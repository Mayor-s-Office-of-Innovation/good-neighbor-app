# 311 ticket closure plan

Status: implemented

## Implementation notes (2026-09-04)

Built as planned, with these refinements discovered during implementation:

- **Where the code landed:**
  - `sf311-client.js`: `buildCloseSrPayload`, `CLOSE_REASON_FIELD_WORK_COMPLETED`
    (`"8"`), `GOOD_NEIGHBOR_AGENCY` (`"76"`). No client-method changes.
  - `app-actions.js`: exported `eligibleTicketsForClosure(priorResults)` +
    internal `execute311ClosureAction(...)` + `case "close_311_ticket"` in
    `executeAppActions`.
  - `guidance-store.js`: `completeTaskWithAppActions` synthesizes the closure
    action after the normal user-confirmed execution.
- **Eligibility vs. carry-forward split:** `eligibleTicketsForClosure` returns
  ALL eligible tickets including already-closed ones; the executor (not the
  eligibility filter) consults prior `close_311_ticket` results — closed
  closures are carried forward into the new result verbatim (no HUB call),
  failed ones are re-attempted. This keeps the latest recorded result a
  complete picture of every eligible ticket instead of only the delta.
- **Filing result preservation:** the completion path drops prior
  `appActionResults` when any fresh result exists. So that a successful
  informational filing is not lost (and the rollup never reads `failed` from a
  missing filing), prior `create_311_ticket` results are unshifted back into
  the final array whenever no fresh filing ran this attempt. Closure rides on
  top; it never replaces the filing result.
- **Executor needs full SF311 config:** the closure path builds a real client
  (`getConfig`), so tests (and any caller) must pass the `SF311_*` env vars,
  not just `GNP_311_SUBMISSION_ENABLED`.
- **`311_filed` re-run details:** the user_confirmed filing action re-executes
  on that path (idempotent via prior ticket reuse); it resolves location from
  the task item, so a task without task-level location falls back to the
  site-meta lookup. Tests seed `location` on the task to keep that path
  mock-free.
- **`local-sf311.mjs` needed no changes:** it already captures generic
  `/updatesr` posts and logs `type=`; UpdateType-11 closures show up in
  `/requests` captures as-is.
- **Verification state:** backend 293 tests / frontend 92 tests / typecheck /
  lint all green (2026-09-04). The dev-HUB manual checks below are still
  pending (`SRnum` casing, `YYYY-MM-DD HH:mm:ss` acceptance).

## Security review (2026-09-04, pre-commit, open-source posture)

Scope: the closure diff (sf311-client.js, app-actions.js, guidance-store.js)
plus everything it touches. No findings requiring code changes.

- **Secrets:** no new secrets, env vars, or config values. The closure call
  reuses the existing UpdateSR URL + Basic Auth secret already used for photo
  attachments. `.env.local` remains git-ignored (`git check-ignore` verified);
  the only env-like files tracked are `.env.example` files and
  `infra/modules/app/secrets.tf` (secret *container* in Secrets Manager, value
  set out-of-band — no secret material in source). The only "password" strings
  in the diff are JSDoc types in existing code.
- **Injection surface:** `buildCloseSrPayload` interpolates only `srNum`
  (string-cast), the constant agency id, and a hub-formatted date into the
  UpdateSR JSON body — sent via `JSON.stringify`, so no header/path/query
  injection is possible. `srNum` provenance is server-side only: it comes from
  a prior HUB CreateSR response recorded in `appActionResults` by our own
  filing code; the HTTP API never accepts a ticket number or any
  `appActionResults` content from clients (`POST /v1/tasks/{id}/complete`
  reads only `completionMethod`, string-typed). A malicious client cannot name
  or select which ticket closes — eligibility is derived entirely from
  server-recorded data.
- **Authorization:** closure rides the existing completion endpoint, which
  derives `siteId` from the Cognito `custom:siteId` claim and is bounded by
  the IAM `dynamodb:LeadingKeys` condition — a user can only complete (and
  therefore close tickets for) tasks in their own site partition. HUB-side,
  return code 26 independently rejects closures sent by any agency other than
  the SR's responsible agency, so even a forged/buggy eligibility check cannot
  close another agency's ticket.
- **Diagnostics/logging:** closure failures reuse
  `appActionErrorDiagnostics`, which redacts authorization/secret/token keys
  and presigned-URL signatures (`redactSignedUrl`) before persisting to the
  task item. Closure payloads contain no PII beyond the SR number.
- **Open-source hygiene:** no dev HUB URLs, credentials, or org-internal
  identifiers were added by this change (the pre-existing filing plan doc
  already carries the dev URL; that's a separate pre-existing review item).

## Manual test steps

Everything runs through the Docker-free local harness (see
[dev-commands.md](../dev-commands.md)). The fake SF311 server captures every
payload, so ticket filing and closing are directly observable.

1. **Start the stack** (3 terminals):
   - `npm run dev -w backend` (DynamoDB Local + MinIO + API :3001 + worker,
     self-bootstraps)
   - `npm run local:sf311 -w backend` (fake HUB :3999)
   - `npm run db:gui -w backend` (table browser at http://localhost:8001) —
     optional but handy for step 4.
2. **Start the API and worker with the 311 overrides** (see
   [dev-commands.md → Fake SF311 server](../dev-commands.md#fake-sf311-server)
   for the exact env block: `GNP_311_SUBMISSION_ENABLED=true`, the three
   `http://127.0.0.1:3999/*` URLs, `SF311_BASIC_AUTH_USER/PASS=local`).
3. **Clear the capture log** so you only see this run's traffic:
   `curl -X DELETE http://127.0.0.1:3999/requests`
4. **Drive a task that files an informational ticket** (agency 76,
   `task_created` trigger — e.g. a LITTER-1 outcome). Either run the normal
   assessment flow from the frontend, or POST an evaluation through the API.
   Confirm the filing appears:
   `curl -s http://127.0.0.1:3999/requests | jq '.[-1]'` → a `createsr` entry
   with `SourceAgency: "76"`.
5. **Complete the task via the done path** — from the Today view done button,
   or (local harness only; `X-Debug-Sub` stubs the Cognito claim and the
   `DEMO_SITE_ID` default `demo-site` names the partition):
   ```bash
   curl -X POST localhost:3001/v1/tasks/<taskId>/complete \
     -H 'content-type: application/json' \
     -d '{"completionMethod":"manual"}'
   ```
6. **Verify closure fired:** check `/requests` for a new `updatesr` entry with
   `UpdateType: "11"`, `SendingAgency: "76"`, `NumericSubType: "8"`,
   `SRnum` matching the filed ticket, and `EffectiveDate` in
   `YYYY-MM-DD HH:mm:ss` format. The response log line reads
   `[sf311] update sr=... type=11`.
7. **Verify the task record:** in the DynamoDB GUI find the `TASK#<taskId>`
   item — `status` is `completed`, `appActionResults` contains both the
   original `create_311_ticket` result (still `submitted`, with
   `externalId`) and a `close_311_ticket` result whose `payload.closures[]`
   shows `status: "closed"` with an `updateId`. `appActionStatus` is
   `submitted`.
8. **Idempotency — no double close:** force a retry by writing the item back
   to `status: "open"` in the GUI (or replay the complete call after flipping
   status), then complete again. `/requests` must show **no second
   UpdateType-11 call** for the same `SRnum`; the new closure result carries
   the prior `closed` record forward.
9. **Closure failure never blocks completion:** point
   `SF311_UPDATESR_URL` at a port nothing listens on (e.g.
   `http://127.0.0.1:3998/updatesr`) and repeat steps 4–5. The task still
   completes; the closure result records `status: "failed"` with the timeout
   reason, and `appActionStatus` is `partial` (filing `submitted` + closure
   `failed`).
10. **City-managed tickets are never closed:** complete a task whose filed
    ticket has `responsibleAgency != "76"` (e.g. a looked-up agency from an
    on-confirmation rule). `/requests` shows the `createsr` filing but **no**
    `updatesr` closure.
11. **Flag off = today's behavior:** restart the API/worker without
    `GNP_311_SUBMISSION_ENABLED=true` (or set false) and complete a ticketed
    task — no closure attempt at all, and the task completes exactly as it
    did before this feature.
12. **Dev HUB spot-check (before release only):** point `SF311_UPDATESR_URL`
    at the real dev HUB once and close one real dev ticket to confirm HUB
    accepts the `SRnum` casing and date format. Do this from a terminal, not
    committed config, and delete the ticket's test data after.

## Goal

When a field user completes an action item that has an informational 311 ticket
we filed under our agency id 76, the backend closes that ticket in the HUB via
`UpdateSR`. The user experience does not change: the existing done button
already completes the task, and the user never needs to know a 311 ticket was
associated. Button text stays as-is (still being finalized upstream).

Tickets filed for city-handled work (the `Create and file 311 ticket on
confirmation` rulebase rows, executed via the user-confirmed `File 311 ticket`
button) are explicitly out of scope for closure: the city manages those cases
after we file them.

## Source contracts

- HUB `UpdateSR` `UpdateType: 11` = `ClosedReason`. `NumericSubType` is the
  closed reason code, `Notes` is a description, and "HUB changes update status
  to closed". HUB rule: "must be responsible agency"
  (`HUB_Lookup_Tables.xlsx`, UpdateType sheet; `HUB API Documentation -
  CreateSR v1.pdf` §2.2).
- Error `26` (`SendingAgency Must Be ResponsibleAgency`) enforces that only the
  SR's responsible agency can close it. We close tickets whose recorded
  `responsibleAgency` is `76` — exactly the informational tickets we filed.
- Closed reason code `8` = `Field Work Completed` (added 7/24/20). Decision:
  send `NumericSubType: "8"`. Rationale: the informational ticket describes
  work the site owner then did; code `1` (`resolved`) stays reserved for a
  future case where we resolve the reported condition ourselves.
- The app already files as `SourceAgency`/`SendingAgency` `76`
  (`sf311-client.js`), so error 26 should not fire for our own tickets unless
  HUB later reassigns the SR to a city agency — a closure attempt may then
  fail with `26`; we record the failure and move on (see Failure handling).
- Date format: existing code sends `UpdateSR` `EffectiveDate` as
  `YYYY-MM-DD HH:mm:ss` (no millis, space separator) via `hubDateTime`, and
  that already works for photo attachments. Keep the same format for closure.
- Field casing: the existing attachment payload sends `SRnum` (working today);
  the doc sample says `SRNum`. Reuse the existing casing for consistency and
  verify in dev.

## Eligibility

A ticket is closeable when, at task-completion time, all of the following hold:

- It appears in the task's `appActionResults` under a `create_311_ticket`
  result with `status: "submitted"` and a recorded `srNum`.
- The ticket's recorded `responsibleAgency === "76"` (our id). This is the
  authoritative test; the rulebase's agency-`76` rows are exactly the
  informational `task_created` filings (LITTER-1 etc.), while city-handled
  `on confirmation` rows resolve their agency via HUB lookup and are never
  `76`.
- The completion is NOT the `311_filed` method (that path files city-managed
  tickets and completes at filing time).

If a task has multiple eligible tickets (classifier fanout), close all of them.
If it has none, no closure work happens and completion behaves exactly as
today.

## Behavior and flow

1. User taps the task's done button → existing
   `POST /v1/tasks/{taskId}/complete` with `completionMethod: "manual"` →
   `completeTaskWithAppActions`. No new endpoint, no frontend change.
2. After claiming the task (`status: "completing"`) and executing the normal
   `user_confirmed` app actions, if the completion method is not `311_filed`
   and `GNP_311_SUBMISSION_ENABLED` is `true`, synthesize one
   `close_311_ticket` app action and execute it through
   `executeAppActions` (new `case "close_311_ticket"`). The synthesized action
   carries no `executionTrigger`, so the existing `user_confirmed` filter
   passes it through, and it never runs in the `task_created` silent path.
3. The closure executor reads the prior results, collects eligible tickets
   (per Eligibility), and for each sends one `UpdateSR` closure payload via
   the existing `sf311.updateServiceRequest`.
4. Record one new `AppActionResult`:

```json
{
  "code": "close_311_ticket",
  "status": "submitted | partial | failed",
  "payload": {
    "closures": [
      {
        "serviceCode": "1.1.4.7.20.0",
        "srNum": "112445",
        "closedReasonCode": "8",
        "status": "closed | failed | skipped",
        "reason": "…on failure only…",
        "updateId": "…on success only…"
      }
    ]
  },
  "recordedAt": "…"
}
```

- `submitted`: every eligible ticket closed.
- `partial`: some closed, some failed.
- `failed`: none closed. Only recorded when there was at least one eligible
  ticket; otherwise the action is not synthesized at all (no result, no
  status noise).
- `skipped` per-ticket states: missing `srNum` (shouldn't happen for submitted
  tickets, defensive) or closure attempts disabled mid-flight.

`Status` field on closure payloads uses the same vocabulary as existing
results; `externalId` is not set for closure results (filing results keep
their `externalId` meaning).

### Completion is never blocked by closure

Current completion gating: the task stays `open` only when the rolled-up
`appActionStatus` is `failed`. When closure runs, a successful filing result
(`submitted`) is always present in the same results array, so even a closure
`failed` yields rollup `partial` — the task still completes. This is the
intended "record failure, complete anyway" decision; no gating-code change is
needed, but a test must pin the invariant: a closure failure must never keep a
task open.

### Failure handling

- `Sf311Error` from `updateServiceRequest` → per-ticket `failed` with the
  existing `appActionErrorReason` / `appActionErrorDiagnostics` (redaction
  included).
- Error `26` (agency mismatch, e.g. HUB reassigned the SR) and any
  already-closed response are recorded as failures and not retried
  aggressively; see Idempotency for retry behavior across completion retries.
- Timeouts reuse the existing 10s `sf311TimeoutSignal` path.
- Log a `console.warn` with the task id and failure reason for ops visibility
  (error tracking picks it up via existing capture).

## Idempotency

- Closure state lives on the task item inside the closure result's
  `payload.closures[]`. No new DynamoDB item type, no new index.
- On a completion retry (lease expiry path) or any later completion attempt
  that re-runs closure, tickets already recorded `closed` are skipped; only
  `failed` ones are re-attempted. Read prior results from the claimed task
  (the executor already receives `priorResults`).
- `UpdateSR` closure is not naturally idempotent on HUB's side; our
  closed-status skip logic is the dedupe.

## Config

- Reuse `GNP_311_SUBMISSION_ENABLED` (decision: no separate flag). Closure is
  skipped entirely when the flag is off — completion then behaves exactly as
  today with no closure result recorded.
- No new config values, secrets, or Terraform changes. The UpdateSR URL,
  Basic Auth secret, and IAM are already wired for attachments.

## Code shape

- `backend/src/integrations/sf311-client.js`: add exported
  `buildCloseSrPayload({ srNum, closedReasonCode, notes, now })` returning the
  UpdateType-11 payload; no client-method changes (`updateServiceRequest`
  already handles POST + return-code validation).
- `backend/src/analysis/guidance/app-actions.js`: add
  `closeEligibleTickets(...)` executor + `case "close_311_ticket"` in
  `executeAppActions`; export a small helper the guidance store can use to
  detect whether eligible tickets exist (`eligibleTicketsForClosure(priorResults)`).
- `backend/src/analysis/guidance/guidance-store.js`: in
  `completeTaskWithAppActions`, after executing `user_confirmed` actions and
  when `completionMethod !== "311_filed"` and the flag is on and eligible
  tickets exist, append the synthesized `close_311_ticket` action to the
  executed set. No changes to claiming, leases, or the final write.
- Frontend: no changes.
- `backend/scripts/local-sf311.mjs`: the fake already accepts generic
  `/updatesr` posts; add capture assertions for `UpdateType: "11"` payloads.

## Tests

- `sf311-client.test.js`: `buildCloseSrPayload` shape (UpdateType 11, agency
  76, NumericSubType 8, EffectiveDate format, empty ToAgencyDate).
- `app-actions.test.js`:
  - eligibility: only agency-76 submitted tickets close; city-managed
    (non-76) tickets and already-closed tickets are skipped;
  - multi-ticket fanout closes all eligible;
  - no eligible tickets → no closure result recorded;
  - per-ticket failure → `partial`; all fail → `failed`; all succeed →
    `submitted`;
  - retry: previously closed tickets skipped, failed ones re-attempted;
  - result records `updateId` and redacted diagnostics on failure.
- `guidance-store.test.js`:
  - done-completion with an agency-76 ticket closes it and completes the task;
  - closure failure still completes the task (pin the invariant);
  - `311_filed` completion never synthesizes closure;
  - flag off → no closure result, completion unchanged;
  - lease-expiry retry does not double-close.

## Dev verification (manual)

1. `npm run local:sf311` fake up; file a task_created informational ticket via
   the normal flow (or seed `appActionResults`).
2. Complete the task from the Today view done button; inspect
   `/requests` capture: one UpdateSR body with `UpdateType: "11"`,
   `SendingAgency: "76"`, `NumericSubType: "8"`, correct `SRnum`.
3. Repeat completion (force a retry) and confirm no second close payload for
   the already-closed ticket.
4. Point `SF311_UPDATESR_URL` at the dev HUB once and repeat against a real
   dev ticket to confirm casing (`SRnum`) and date format are accepted.

## Docs to update during implementation

- `docs/dynamodb-data-model.md`: document the `close_311_ticket` result shape
  on task items.
- `docs/architecture.md`: one line in the guidance-workflow section.
- `docs/guidance-policy-changelog.md`: note closure behavior addition (no
  rulebase change is required for this feature).

## Explicit non-goals

- No UI for closing tickets on already-completed tasks (city handles those).
- No auto-closure on `cannot-do` paths.
- No batch/backfill closure of historical tickets (follow-up issue if ops
  wants one).
- No rulebase or policy changes.