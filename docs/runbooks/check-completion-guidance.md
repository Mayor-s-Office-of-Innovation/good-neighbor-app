# Completion history for capture guidance

Capture starting titles use `GET /v1/checks:capture-guidance?startedAt=<ISO>&checkId=<id>`.
The authenticated Site is authoritative; clients cannot select another Site. The
response contains five counts: today, yesterday, through four Pacific days ago.
Only completions at or before `startedAt` count. The response has no history cursor.
Backend queries may paginate within this five-day window, never across a Site's
lifetime history. Requests with invalid dates, missing IDs, or dates more than five
minutes into the future return 400.

The completion transaction writes both the completed CHECK header and an immutable
`CHECK_COMPLETION#<Pacific date>#<completedAt ISO>#<checkId>` record. Single-problem
reports are excluded, and headers without `flowType` are treated as perimeter
checks. Reads use the base table with `ConsistentRead: true`, not GSI1. Records
remain alongside retained checks; a future check-retention workflow must remove
both the header and its completion record. Whole-Site deletion must include these
Site-partition records.

## Rollout and historical migration

1. Deploy the backend completion writer and API route through the normal CI
   pipeline. Wait for invocations of the previous backend version to drain before
   backfilling; all concurrent new completions must use the atomic writer.
2. Run the backfill in dry-run mode against the intended environment, with the
   target `DYNAMO_TABLE`, region, and an approved operator AWS profile:

   ```bash
   npm run backfill:check-completions -w backend
   ```

3. Review the eligible-header count, then apply:

   ```bash
   npm run backfill:check-completions -w backend -- --apply
   ```

4. Deploy the frontend using the new endpoint. Until migration completes,
   guidance returns `503 capture_guidance_not_ready`; capture remains usable with
   default guidance and does not save that fallback as a resolved title context.

The backfill scans the base table once, consistently, and migrates only completed
perimeter CHECK headers. Each write transaction checks that the source header is
still completed with the same timestamp and creates its marker conditionally.
Existing markers or concurrently removed headers are skipped. Reruns are safe;
errors stop the run and do not mark an uninitialized migration ready. On success,
the script writes `SYSTEM#MIGRATIONS / CHECK_COMPLETIONS_V1` with `status: "ready"`.
No credentials are stored in the repository. This workflow makes data writes;
Terraform plan/apply remains in CI.

## Local harness

With the updated local backend running, initialize existing or empty local tables:

```bash
node --env-file=.env.local backend/scripts/backfill-check-completions.mjs
node --env-file=.env.local backend/scripts/backfill-check-completions.mjs --apply
```

These commands use the local DynamoDB endpoint and dummy credentials already
configured in `.env.local`. Start the updated backend before applying so concurrent
local completions use the new writer. Restart the frontend only if its dev server
is not already watching source files.

## Recovery and verification

A migration failure leaves guidance unavailable rather than declaring partial
counts authoritative. Fix the reported storage/input error and rerun; existing
markers will not be overwritten. For a previously completed successful migration,
a failed rerun leaves its existing readiness state intact.

After successful migration, complete a perimeter check and immediately request
guidance for a new check. The new completion should appear without waiting for
GSI propagation. Replaying completion must not add another record. Verify both
sides of Pacific midnight and include a check started earlier but completed today.
Existing saved draft title contexts remain unchanged on resume.
