# Recovery drills: queues and database

Use this runbook with [observability.md](observability.md) and the
[media safeguards](media-safeguards.md). Aaron Hans is the production primary;
Beaudry Kock is secondary. Record the incident/drill owner, AWS account, region,
target names, timestamps, observations, and cleanup in an issue. Keep credentials,
enrollment links, message text, and private media out of incident records.

Infrastructure changes and Terraform plan/apply run through approved CI. Do not
create a replacement production table or alter an event-source mapping manually
to bypass the deployment review. A drill is successful only after its observed
results are recorded; configuration and unit tests alone do not prove recovery.

## Failure diagnosis and controlled DLQ redrive

Rehearse first in DEV with a synthetic Site and disposable evidence. Confirm the
DEV AWS account before each mutating operation. Do not send malformed messages
to a production queue, purge a shared queue, or replay real 311/email actions as
test data. A production incident redrive needs a diagnosed cause and an owner.

The queues are `good-neighbor-app-<env>-analysis` (foreground captures),
`good-neighbor-app-<env>-submissions` (background/legacy work), and their `-dlq`
queues. Main analysis/submissions queues retain messages for four days; their
DLQs retain them for 14 days. They dead-letter after five receives. Treat
approximate message counts as diagnostic signals rather than an exact inventory.
Duplicate detection has its own queues and recovery semantics; use the
[duplicate-detection runbook](duplicate-detection.md) before touching those.

1. Create a synthetic capture in DEV. In a controlled test deployment, arrange
   a retryable dependency failure for only that test path (for example, the local
   analyzer stub used by an isolated harness). Do not disable the shared analyzer
   or revoke the live worker's permissions to manufacture failure. If fault
   isolation is unavailable, use an isolated harness and report that production
   delivery/redrive is still unproven.
2. Verify retries and eventual dead-lettering. Record the Site/check/artifact IDs
   and original SQS message ID. Inspect message attributes and structured logs;
   avoid copying a full message body, which can contain description text.
3. Find `level = "ERROR"`, `messageId`, `checkId`, and `artifactId` in the correct
   worker log group (`/aws/lambda/good-neighbor-app-<env>-analysis` or `-worker`).
   Determine whether this is dependency availability, permissions, quota, input,
   expired media, or a code regression. Permanent analyzer rejection is handled
   differently from retryable exceptions and may not enter the DLQ at all.
4. Correct the cause through the appropriate reviewed deployment. Verify the
   destination queue, worker mapping, KMS access, and source media validity.
   Preserve incident evidence before moving messages.
5. Use SQS's managed DLQ redrive only for a DLQ whose **entire current contents**
   are understood and safe to retry, at the lowest supported controlled rate.
   A managed move task is not a selector for a single message. In a mixed DLQ,
   stop and prepare a reviewed targeted-replay operation; do not redrive the whole
   queue just to recover one synthetic message. Remember that polling messages
   changes visibility and receive counts.
6. Monitor destination depth/age, invocation errors, and new DLQ arrivals. Stop
   the move task if the cause persists or retries loop. Distinguish replayed IDs
   from any new SQS message IDs assigned by redrive.
7. Confirm the synthetic analysis completes and appears in the app. Replaying a
   successful item must not create a second analysis, double-count a completion,
   or repeat an external action. Test failures in one SQS batch must leave other
   successful records acknowledged (partial-batch responses).
8. Record time to detection, diagnosis, correction, and recovery. Remove only
   known synthetic fixtures using supported app cleanup after the drill. Do not
   delete real evidence, empty shared DLQs, or shorten queue retention.

### SF311 closure recovery

The 311 team confirmed that tickets owned by our agency (76) do not appear in
`GetLatestUpdatesBySourceAgency`, and repeating a closure update is safe. The
worker sends eligible owned-ticket closures directly to `UpdateSR`; it does not
use that feed as a prerequisite. A failed or interrupted closure may be retried,
while a saved successful closure is skipped. HTTP 200 alone is insufficient:
`UpdateSR` must return an explicit `return_code = 0` before a closure is recorded
as successful. Missing confirmation leaves the closure failed and retryable.
Tickets owned by other agencies
remain outside this automatic closure path.

After deploying the fix through CI, identify affected closure-only jobs by their
saved successful creation and unresolved closure checkpoints. Confirm their task
state and ownership before replay; retain the existing job keys and checkpoints
so recovery does not create another ticket. Use the controlled DLQ process above;
do not move an entire mixed queue or discard unresolved closures. Verify the job
reaches `complete` and its closure checkpoint records success after replay.

This permission to repeat closures does **not** apply to `CreateSR` or attachment
updates. `CreateSR` is non-idempotent; preserve pending/uncertain creation
checkpoints and reconcile them rather than blindly issuing another creation.

## Database point-in-time recovery

The application table is `good-neighbor-app-prod-app` in `us-west-2`.
Terraform enables DynamoDB point-in-time recovery (PITR); it is not an hourly
scheduled snapshot. Confirm the current recovery window before picking a target:

```sh
aws sts get-caller-identity
aws dynamodb describe-continuous-backups \
  --table-name good-neighbor-app-prod-app --region us-west-2
```

Require `PointInTimeRecoveryStatus = ENABLED` and choose a timestamp between
`EarliestRestorableDateTime` and `LatestRestorableDateTime`. The configured window
is 35 days, but a newly initialized table has less actual history. The latest
restore point normally trails by approximately five minutes. Restoring creates
a **new table**; it does not roll the live table back in place. Restore duration
depends on data and indexes and is not a promised recovery time.

See AWS's [PITR documentation](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Point-in-time-recovery.html)
and [restore procedure](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/PointInTimeRecovery.Tutorial.html).

### Isolated restore rehearsal

1. Pick a known timestamp (for example, one hour before the drill) inside the
   verified recovery window and record it. Agree on acceptable data loss (RPO)
   and recovery time (RTO); these targets are not established by enabling PITR.
2. Prepare a reviewed, temporary CI restore operation using a unique
   `good-neighbor-app-prod-recovery-drill-<id>` target. Keep the live source table
   outside that operation's managed resources. Constrain its role and cleanup
   to the exact target. Retain KMS encryption and all required CCSF tags:
   `Application`, `ApplicationOwner`, `Environment`, `DataClassification`,
   `InternetExposure`, `AssetCriticality`, `Compliance`.
3. Restore only to that isolated target. Do not point application Lambdas,
   analytics exports, stream consumers, or queue workers at it. It contains
   production-sensitive data: apply production access controls and an explicit
   cleanup deadline; do not copy its contents into logs or build artifacts.
4. Wait for the table and required indexes to be ACTIVE. Compare schema and index
   inventory and verify known records expected at the selected timestamp using
   strongly consistent, non-sensitive metadata checks. Approximate `ItemCount`
   alone is not validation. Record the restore's elapsed time and evidence.
5. Inventory the settings that restore does not automatically recreate: tags,
   TTL, streams, PITR, IAM permissions, alarms, and consumer mappings. Before any
   real failover, reconcile these through Terraform/CI and verify capture-history
   readiness and other migration/projection markers at that recovered timestamp.
6. Review credential and external-side-effect rollback risks before failover:
   older device/enrollment records can reverse revocations or single-use state;
   database rollback does not undo already-filed 311 requests or sent emails.
   Reconcile/invalidate affected credentials and external-action history rather
   than blindly replaying queues against an older table.
7. Record whether the measured restore and validation times meet the agreed
   targets. A real cutover additionally needs write quiescence, Lambda/table
   reference and IAM changes, stream/outbox/analytics reconciliation, rollback,
   and approved CI deployment. Do not exercise those on production for this drill.
8. Remove the isolated restored table through its reviewed cleanup operation
   after retaining only non-sensitive drill evidence. Verify the source table,
   PITR, and application configuration remain unchanged.

### Media and recovery limits

DynamoDB PITR covers database items, not S3 photos, Cognito users, Secrets Manager
versions, or the analyzer service. Upload/complaint media versioning is deliberately
suspended and media expires under its existing retention policy. A database
restored to yesterday may reference photos already expired today. Do not turn on
indefinite media backup or extend approved retention to make a drill pass. Missing
media must stay unavailable; recovered records must still enforce expiry.

The production Terraform backend has independent versioned/KMS-encrypted S3 state
and its own PITR-enabled lock table. Do not restore or overwrite Terraform state
as part of an application-data drill.

## Issue updates after an interrupted 311 filing

A `completing` task is an action attempt, not a resolved issue. Its
`completionLeaseExpiresAt` prevents concurrent processing while the action runs.
An expired lease does not undo tickets already filed or automatically change the
task status. A partial filing can retain ticket references alongside
`appActionStatus: failed` and `fanout_incomplete`.

The task-update API exposes `task.canUpdate`. In addition to ordinary
`in_progress` tasks, it permits updates to an expired completion claim with
recorded 311 ticket references, expired resolution claims, and legacy
`completed`/`311_filed` tasks whose recorded filing is not closed. The normal
14-day archive boundary still applies. Active or malformed leases, completion
claims without recorded tickets, and explicitly resolved issues are not opened
by this recovery rule.

Opening the timeline does not change data. The next successful note/photo or
additional-action update atomically moves a recoverable task to `in_progress`,
clears stale completion fields, and preserves the ticket references and partial
filing outcome. Explicit resolution moves it to `completed` through the usual
resolution flow. Conditional writes check the original status, timestamp,
lease (when present), and action results; a renewed worker claim cannot be
silently overwritten. Photo registration alone does not recover the task.

To verify a reported case, inspect the task's status, lease, and recorded ticket
references before acting. Do not re-file an existing ticket just to regain
update controls. After an authorized issue update, verify its single timeline
entry, the intended task status, unchanged ticket references, and the original
filing failure information. Any incomplete City filing still needs separate
reconciliation; accepting a local update does not declare that filing successful.

For upload failures, the editor keeps Close and Cancel available while saving.
Cancel stops waiting and preserves the draft; Close then offers the usual discard
confirmation. A foreground save has a 120-second deadline. A cancelled or timed-out
HTTP write may already have reached the server, so retry the unchanged draft:
its idempotency key and successfully uploaded photos are reused. Refreshing the
page discards the in-memory draft; no offline queue is provided.
