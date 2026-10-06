# DynamoDB Data Model — Perimeter Checks

*Data-model reference · [index](../README.md) · ← [decision](./adr/0002-datastore-dynamodb.md)*

**Status:** Live model. This is what the app writes and reads today.
**Date:** 2026-08-12 · updated 2026-09-04 for the built state · 2026-09-21 for the photo roll ([ADR 0014](./adr/0014-remove-places-photo-roll.md)) · 2026-10-01 to match the deployed authorizers, UUID IDs, provider and setup-code items, GSI6–7, and the analytics tier status

## What this document is

This is the reference for how the app stores data in DynamoDB. It lists every item type,
its keys, the indexes, and the queries the app runs. Why we chose DynamoDB is covered in
[ADR 0002](./adr/0002-datastore-dynamodb.md), not here.

Three things needed careful design: cross-site reports, detecting a check that never
happened, and how devices prove which site they belong to. Each has a section below.

For a worked example of one check's records as JSON, see
[dynamodb-sample-records.md](./dynamodb-sample-records.md).

### Terms used in this document

- **Tenant.** One site. Each site must see only its own data.
- **`pk` / `sk`.** DynamoDB's partition key and sort key. Together they identify one item.
  Items with the same `pk` live together and can be read in one query.
- **GSI.** Global secondary index. A copy of the table sorted a different way, so we can
  query by something other than `pk` / `sk`.
- **Sparse index.** A GSI that only holds items that set its keys. Items that do not set
  them are simply absent, so a query on the index needs no filter.
- **Idempotent.** Safe to repeat. Sending the same request twice has the same effect as
  sending it once.
- **Conditional write.** A write that only happens if a condition holds, such as "this
  item does not exist yet". We use it to make writes idempotent.
- **Authorizer.** The API Gateway step that checks a caller's token before the request
  reaches our code.

## The domain

- About **400 sites**. Each site is a building.
- Each site has a **shared device**, a tablet at the front desk. Staff carry it around to
  take photos.
- Staff do **perimeter checks** 3 times a day. Staff do **not log in**.
- A check is one flat **photo roll** for the whole perimeter. A check is complete with at
  least **one photo**, or with **one typed description** of at least 20 characters. Photos
  plus a description also count. This rule lives in the client
  (`frontend/src/domain/check-completion.js`). The backend records the counts and never
  refuses a check. There is no per-site list of places. Audio is out of scope.
- An **AI engine** analyzes each photo or description. It returns a list of concerns and
  a severity for each.
- Concerns become **tasks**. Business rules decide whether a task goes to on-site staff or
  is **escalated to the city** (for example, toxic material cleanup).

### Facts that shape the model

1. **The city needs one queue of escalations across all sites.** This is the only
   cross-site read we planned for. It would use GSI3. GSI3 is deferred past MVP. It is
   sparse, so we can add it later without rebuilding the table.
2. **Staff are anonymous.** A check is attributed to the site and the device, never to a
   person. See [Identity model](#identity-model).
3. **Photos live in S3, not DynamoDB.** Items store the S3 key. See R4.
4. **Retention is not enforced yet.** Media is designed to expire after about 7 days
   through an S3 lifecycle rule, but that rule is not in place. It is a pre-launch TODO.
   Retention for checks and analysis is post-MVP. DynamoDB TTL is enabled on
   `expiresAt` for numeric operational expiries such as upload reservations, daily
   quota counters, rate limits, and import staging. Legacy/domain rows that store an
   ISO date string in the same attribute are ignored by DynamoDB TTL and continue to
   use application-level expiry checks.

## Identity model

Who can write what:

| Principal | How they authenticate | What they write | How their scope is enforced |
|---|---|---|---|
| **City administrator** | Cognito JWT in the `central-admin` group | cross-Site configuration and operations | central-admin handler guard plus server-built keys |
| **Site-bound device** | bounded access token checked against current physical-device, binding, membership, and Site generations | perimeter checks, artifacts, and Manager operations allowed by binding access | authorizer-derived Site/access claims plus server-built keys and negative tests |
| **Performer** (staff member) | none; they use the device | nothing directly | not needed; attribution is device + site |
| **City reviewer** | Cognito `central-admin` user | cross-Site review | central-admin handler guard |

The key decision: **the device is authenticated as the site.** Staff never need accounts.
Every check is still tied to a site and a device. The admin registers the device once
during setup.

Tenant isolation is enforced at the application boundary: the authorizer verifies the
current binding and supplies the Site claim, and handlers derive keys from that claim.
The media path adds exact server-owned key validation and re-checks stored pointers before
signing reads. A shared Lambda role cannot express a different `LeadingKeys` value for each
JWT caller because DynamoDB sees the execution role, not the original principal.

### What runs today

The IAM part above is the target. Here is what is deployed now (`infra/modules/app/api.tf`):

- Every protected route uses the **device-token authorizer**
  ([ADR 0010](./adr/0010-device-token-auth.md), `backend/src/lambda/authorizer.js`). It
  checks the bearer token against the site's `DEVICE#` item, including the token
  generation and revocation state. It then adds `custom:siteId` to the request.
- Routes under `/admin/v1/*`, including analytics, use a **Cognito JWT authorizer**. The
  handlers also require the `central-admin` group (`backend/src/lib/admin-auth.js`).
- Open routes are limited to bootstrap (`/site-code`, `/v1/devices*`, `/v1/sites:search`,
  `/v1/setup-codes:request`), `/health`, and the best-effort intakes.
- Handlers read `siteId` from the authorizer context (`backend/src/lib/principal.js`).
  `DEMO_SITE_ID` is only a fallback for requests with no authorizer context, such as the
  local harness and the open intakes. Clients never choose their own site.

### Platform-layer limitation

The API Lambda role reaches the whole table because it also executes authenticated City
administration over global and cross-Site records. A genuine IAM tenant backstop would
require a separate tenant-only Lambda/role or per-request tagged-role assumption. A static
`SITE#*` condition would still permit cross-Site access and must not be described as tenant
isolation. See [security-review.md](./security-review.md).

## Table design

One table, `gnp-<env>-app`, with partition key `pk` and sort key `sk`.

We chose a single table for isolation, not for scale. Volume is tiny (see
[Scale](#scale)). The point is that **all of one site's data shares one `pk` prefix**,
`SITE#<siteId>`. That is what makes the IAM `LeadingKeys` rule possible. It also puts a
check's header, artifacts, and analyses next to each other, so one query reads them all.

A few item types live **outside** the `SITE#` prefix. They are needed before we know the
site, or they span sites:

- provider config and provider membership (`PROVIDER#`)
- the public site and provider search rows
- setup codes and their request throttles
- the analytics export watermark
- the legacy submission receipt

These belong to central admin or to device bootstrap, not to a tenant. A `LeadingKeys`
rule on site and device roles would not grant them, and only admin and bootstrap code
touches them.

**IDs are UUIDs.** The client makes `checkId` with `crypto.randomUUID`. The backend makes
artifact, task, and assessment IDs with `node:crypto`. UUIDs have **no time order**, so
`CHECK#<checkId>` does not sort by time. The checks timeline comes from GSI1, whose sort
key is `startedAt`. Any key that must sort by time includes a timestamp on purpose, such
as task update events and every GSI sort key.

### Item types

| Entity | `pk` | `sk` | Notes |
|---|---|---|---|
| Site config | `SITE#<siteId>` | `#META` | `type`/`entityType`, name, `address` + `addressParts`, `location` (lat/lng) + `geocodedAddress`, `providerId` / `providerName` / `providerSiteId`, `status`, `contactPerson`, admin-managed `oversight` / `compliance` / `perimeter` / `complianceLetters`, `providerShortCode`, `siteShortCode`. `perimeter` is a plain-text description (not geometry or a geofence), with `perimeterUpdatedAt` and `perimeterUpdatedBy` edit metadata. Compliance letters keep a private S3 key. The site response for devices mints short-lived download URLs. |
| User profile | `SITE#<siteId>` | `USER#<sub>` | admin roster; the JWT usually makes the lookup unnecessary |
| Device | `SITE#<siteId>` | `DEVICE#<deviceId>` | Compatibility projection for authorization and refresh: label, physical-device ID, lastSeenAt, lifecycle/expiry fields, `tokenGeneration`, `refreshJti`, and canonical `accessLevel` (`general` or `manager`). |
| Code contact / master contact | `SITE#<siteId>` | `CODE_CONTACT#<emailHash>` / `MASTER_CONTACT#<emailHash>` | contacts allowed to request setup codes. Managed by central admin. `email`, `emailHash`, `name`, `status` |
| Manager membership | `SITE#<siteId>` | `MANAGER_MEMBERSHIP#<membershipId>` | One email-based Site Manager role at exactly one Site. Stores normalized `email`, keyed verifier in `emailHash`, optional source `programId` / `userId`, `status`, `role=manager`, and a generation advanced on removal so later bindings can fail closed. Contact edits update the email-directory pointers transactionally without revoking active bindings. |
| Manager email uniqueness | `SITE#<siteId>` | `MANAGER_EMAIL#<emailHash>` | Conditional uniqueness marker pointing to the active `membershipId`; written and removed in the same transaction as membership lifecycle changes. |
| Manager membership directory | `MANAGER_EMAIL#<emailHash>` | `SITE#<siteId>#MEMBERSHIP#<membershipId>` | Non-secret pointer used only by the public Manager recovery flow. Each result is revalidated against the canonical Site and membership before a separate, single-Site link is issued. Existing memberships are populated by the dry-run-first directory backfill. |
| Manager enrollment grant | `SITE#<siteId>` | `MANAGER_GRANT#<createdAt>#<grantId>` | Fifteen-minute, single-use, single-Site Manager enrollment grant with grant-email and post-redemption security-notification delivery evidence. Stores only the random token's SHA-256 verifier; list APIs omit it. |
| Current Manager enrollment grant guard | `SITE#<siteId>` | `MANAGER_GRANT_CURRENT#<membershipId>` | Conditional singleton for one unexpired Manager grant per membership. Creation replaces only the grant observed by the request; redemption or cancellation deletes the matching pointer atomically. |
| Staff enrollment grant | `SITE#<siteId>` | `STAFF_GRANT#<createdAt>#<grantId>` | Ten-minute, single-use general-access grant issued by an active Manager binding. Stores its intended device label, issuing binding/membership generations, status, and only the token verifier. |
| Active staff-grant guard | `SITE#<siteId>` | `ACTIVE_STAFF_GRANT#<managerBindingId>` | Conditional singleton ensuring a Manager can have only one unfinished staff grant. Redemption or explicit cancellation removes it atomically; an expired marker can be conditionally replaced. |
| Enrollment-token lookup | `ENROLLMENT_TOKEN#<tokenHash>` | `#META` | Opaque lookup from a presented 256-bit enrollment token to its grant. Removed on cancellation or successful redemption. |
| Physical device | `PHYSICAL_DEVICE#<physicalDeviceId>` | `#META` | Stable browser/device identity shared by one or more Site bindings. Stores label, lifecycle status, and enrollment timestamps; no Site authorization is inferred from this item alone. A revoked physical identity cannot redeem another enrollment grant. |
| Device binding | `SITE#<siteId>` | `DEVICE_BINDING#<bindingId>` | One physical device's role at one Site. Stores canonical `general` or `manager` access, membership and Site generations, rotating-refresh state, 365-day absolute expiry, 60-day inactivity policy, enrollment provenance, and lifecycle status. Suspension records its reason, actor, and time; suspended bindings are immutable and never restored in place. |
| Physical-device binding pointer | `PHYSICAL_DEVICE#<physicalDeviceId>` | `BINDING#<bindingId>` | Non-secret ownership and discovery pointer to one Site binding. It grants no access by itself; listing and selection revalidate the canonical binding, compatibility Device row, Site generation/status, expiry/inactivity, and Manager membership where applicable. |
| **Check header** | `SITE#<siteId>` | `CHECK#<checkId>` | status (`in_progress` → `completed`), startedAt, `flowType` (`perimeter` or `single-problem`), running `issueCount` / `maxSeverity` counters that the worker bumps. **At `complete` the header also gets:** `grade`, `summary`, `categories`, `rubricVersion`, `photoCount` / `textCount` / `evidenceKind`, `synthesizedAt`, `completedAt`. See [Scorecard on the header](#scorecard-on-the-header). |
| **Artifact** (one photo or description) | `SITE#<siteId>` | `CHECK#<checkId>#ART#<artifactId>` | S3 key or text, capturedAt, latitude/longitude, contentType. See [Old artifact rows](#old-artifact-rows). |
| **Analysis** (one per artifact) | `SITE#<siteId>` | `CHECK#<checkId>#ANALYSIS#<artifactId>` | `status` (`analyzed` or `failed`), `analysisId`, `model`, `rubricVersion`, `grade`, `gradeDescription`, `concerns[]`, `issueCount`, `maxSeverity`, `analyzedAt`, optional lat/lng + `georeferencedAddress`. A `failed` item holds `error` instead of results. It is the one case a retry may overwrite. |
| **Assessment report** | `SITE#<siteId>` | `ASSESSMENT#<assessmentId>` | status, `policyVersion`, `rubricVersion`, grade, `reportedAt`, `assessmentRevision`, `lineageId`, `summary{}` counts, `rawAssessment`. Gets `supersededByAssessmentId` when a refresh replaces it. |
| **Condition** | `SITE#<siteId>` | `ASSESSMENT#<assessmentId>#COND#<conditionId>` | `canonicalCategory` / `analyzerCategory`, severity, `answers`, `outcome`, `selectedRuleId`, status, `taskIds`, `resolvedToTasks`, `needsAnswer`, `cannotDo`, `source`. See [guidance workflow](./architecture.md#guidance-workflow-rule-driven-tasks). |
| Guidance current pointer | `SITE#<siteId>` | `GUIDANCE_CURRENT#<JSON [checkId, lineageId]>` | points to the current assessment for one artifact. Moved atomically on refresh. See [Guidance refresh lineage](#guidance-refresh-lineage). |
| **Task** (action item) | `SITE#<siteId>` | `TASK#<taskId>` | `shortId`, kind (`action` \| `escalation` \| `non_actionable_escalation`), type (`onsite` \| `city_escalation`, derived from kind), ruleId, policyVersion, `canBeInProgress`, `primaryInProgressAgency`, category, severity, status |
| **Task update event** | `SITE#<siteId>` | `TASK#<taskId>#UPDATE#<occurredAt>#<updateId>` | append-only timeline event for an in-progress task: type, label, actorId, `text` / `notes`, `photoKeys` (artifact IDs), optional `presencePeriod`, `documentationState` |
| Task update pointer | `SITE#<siteId>` | `TASK#<taskId>#UPDATE_ID#<updateId>` | finds an update by ID alone, for documentation and safe retries. Stores the event's full sort key. |
| Task update media | `SITE#<siteId>` | `TASK#<taskId>#MEDIA#<artifactId>` | photos attached to an update. Not analyzer input. A `CHECK#<checkId>#UPDATE_MEDIA#<artifactId>` pointer lets the normal media route serve them. |
| Upload reservation | `SITE#<siteId>` | `UPLOAD_RESERVATION#<checkId>#<artifactId>` | 24-hour record created before issuing a media PUT; binds key, type, and declared bytes. |
| Daily check/device/Site media quota | `SITE#<siteId>` | `MEDIA_QUOTA#<yyyy-mm-dd>#CHECK#<checkId>`, `...#DEVICE#<actorId>`, or `...#SITE` | conservative reserved byte and artifact counts; expires after the quota day so abandoned upload URLs cannot permanently exhaust a Check. |
| Daily global media quota | `MEDIA_QUOTA#<yyyy-mm-dd>` | `#GLOBAL` | conservative global byte and artifact-count cost budget. This is operational, not tenant data. |
| Task display ID counter | `SITE#<siteId>` | `COUNTER#task-display-id` | `nextTaskDisplayNumber`, a counter that only goes up. Used to mint task `shortId` values. |
| Provider config | `PROVIDER#<providerId>` | `#META` | managed by central admin: name, `status`, timestamps |
| Program config | `PROGRAM#<programId>` | `#META` | managed by central admin: Provider relationship, name, required contact, optional Program Manager reference, migration-placeholder/review flags, status, timestamps |
| Program contact | `PROGRAM#<programId>` | `USER#<userId>` | non-authenticating roster/contact record: name, phone and optional extension, normalized email, `siteManager` directory marker, status, Site-assignment count, timestamps. Archival is blocked while assignments remain. |
| Site contact assignment | `SITE#<siteId>` | `ASSIGNED_USER#<userId>` | assignment to an active contact in the Site's lead Program, with a contact snapshot for display. The Site `#META` row identifies exactly one `primaryContactUserId`; primary removal requires replacement first. |
| Compliance terms version | `SITE#<siteId>` | `COMPLIANCE_TERMS#<effectiveStart>#<versionId>` | immutable effective-dated tier 0–4 and integer checks/day. Start is inclusive, expiry is exclusive, and missing expiry means indefinite. New versions may close the prior open version but cannot overlap a future version. |
| Compliance-letter generation job | `SITE#<siteId>` | `LETTER_JOB#<createdAt>#<jobId>` | transactional outbox item created with a terms version; a later worker generates the draft and advances letter state. |
| Site audit event | `SITE#<siteId>` | `AUDIT#<createdAt>#<eventId>` | append-only actor/event record for Site administration changes. |
| Revocation operation | `SITE#<siteId>`, `PHYSICAL_DEVICE#<physicalDeviceId>`, or `REVOCATION_OPERATION#<operationId>` | `REVOCATION_OPERATION#<createdAt>#<operationId>`, `#META`, `SITE#<siteId>`, or `OUTBOX#<siteId>` | Durable outcome for selected-binding, Site-wide, physical-device-wide, or emergency multi-Site revocation. The multi-Site root tracks queued/completed Site counts and has one idempotent Site-result row plus one transactional outbox row per reconciliation job. DynamoDB Streams dispatches pending outbox rows to SQS; reconciliation failures are retried rather than recorded as terminal partial success. Contains IDs and aggregate outcomes, never credentials. |
| Site-import ledger | `SITE_IMPORT#<importId>` | `#META` | requester, source SHA-256 digest, preview version/expiry, idempotency key, confirmed counts, status, aggregate outcomes, and bounded-review TTL. |
| Site-import row | `SITE_IMPORT#<importId>` | `ROW#<sourceRow>` | normalized plan and safe source fields, preview classification, apply attempts, terminal outcome, created/reused IDs, safe conflict reason, and the same bounded-review TTL. |
| Site-import history | `SITE_IMPORT_HISTORY#<requesterId>` | `<completedAt>#<importId>` | recent terminal-import summary for the admin UI: safe filename, completion timestamp, `succeeded`/`partial`/`failed` result status, and added/updated/failed record counts. |
| Provider → program membership | `PROVIDER#<providerId>` | `PROGRAM#<programId>` | lists Programs owned by a Provider; archival never cascades to Programs or Sites |
| Program → site membership | `PROGRAM#<programId>` | `SITE#<siteId>` | lists Sites led by a Program; reassignment updates this relationship without changing Site identity or device access |
| Program search row | `PROGRAM_SEARCH#ACTIVE` | `<lowercased name>#<programId>` | active Program directory projection with Provider and migration-review metadata |
| Provider → site membership | `PROVIDER#<providerId>` | `SITE#<siteId>` | `siteName`, `providerSiteId`, `status`. Lists a provider's sites (AP19). |
| Provider search row | `PROVIDER_SEARCH#ACTIVE` | `<providerId>` | all active providers in one partition, for the admin list |
| Oversight directory option | `ADMIN_DIRECTORY#OVERSIGHT` | `DEPARTMENT#<normalizedName>` or `SYSTEMOFCARE#<normalizedName>` | reusable central-admin dropdown value with display name, type, status, and timestamps. DPH, HSH, and BHS-PBH are supplied as defaults even before rows exist. |
| Site search row | `SITE_SEARCH#ACTIVE` | `<lowercased name>#<siteId>` | `label`, `searchText`. All active sites in one partition, for the public bootstrap search (AP20). |
| Setup code | `SETUP_CODE#<verifier>` | `#META` | `verifier` is an HMAC of the code the person types. The code itself is never stored. `codeId`, `status`, `expiresAt` (ISO string, 72 hours), `uses` / `maxUses` (3), `accessLevel`, `siteId`, `issuedTo`, `issuedBy`. Carries GSI6 and GSI7 keys while `pending`. |
| Current setup code pointer | `SETUP_CODE_CURRENT#<siteId>#<contactHash>` | `#META` | `currentCodePk` / `currentCodeId`: the code a contact's latest request created |
| Legacy site code | `SITE_CODE#<code>` | `#META` | `type: providerSiteCode`. Rows from before setup codes. `/site-code` still accepts them as a fallback. |
| Setup-code request throttle | `SETUP_CODE_REQUEST#<siteId>#<contactHash>` | `#THROTTLE` | `nextAllowedAt`, a cooldown for the public request route. Written with a conditional Put. |
| Manager-access request controls | `MANAGER_ACCESS_RATE#IP#<ipHash>` / `MANAGER_ACCESS_RATE#EMAIL#<emailHash>` / `MANAGER_ACCESS_COOLDOWN#<emailHash>` | `HOUR#<yyyy-mm-ddThh>` / `#REQUEST` | TTL-bound counters and cooldown marker for the non-enumerating public Manager recovery route. No raw email or IP address is stored. |
| Analytics export watermark | `ANALYTICS#EXPORT` | `#WATERMARK` | `exportToTime` (epoch seconds), `lastExportId`, `updatedAt`. The cursor for the incremental export Lambda ([ADR 0013](./adr/0013-analytics-read-plane.md)). |

### Old artifact rows

Artifact rows written before Phase 2 of [ADR 0014](./adr/0014-remove-places-photo-roll.md)
have an extra `<placeId>` segment: `CHECK#<checkId>#ART#<placeId>#<artifactId>`. They also
carry `placeId` and `placeName` attributes, and their S3 keys have a matching extra path
segment. No code rebuilds an artifact key from its parts. `getCheck`, `completeCheck`,
`deleteArtifact`, and `presignMedia` all query the prefix `CHECK#<checkId>#ART#` and match
on the `artifactId` attribute. Both shapes stay readable with no migration.

The analyzer requires a `position_descriptor`. We always send the fixed value
`"perimeter"` (`backend/src/workers/analyze-artifact.js`). It is copied onto tasks as
`source.positionDescriptor`. Nothing makes decisions based on it.

### Extra task fields

**311 state.** Tasks carry the 311 app-action state as plain attributes. There is no index
and no separate ticket item.

- `appActions`: the rule's structured actions.
- `appActionResults`: one result per action that ran.
- `appActionStatus`: a rollup of the results.
- `maxAcceptableResponseHours`: the response window from the rule. Zero turns off overdue
  checks.

**In-progress tasks** also carry `inProgressAt`, `notifiedAt`, an agency snapshot,
`latestUpdateId`, `latestUpdateLabel`, and `lastAnsweredPresencePeriod`. Four-hour
presence periods are always counted from `inProgressAt`, which never changes. Task-update
photos reuse ART rows with `purpose: "task_update"`. Registering them skips the SQS and
analyzer path on purpose. The update event stores the artifact IDs so the media route can
authorize reads.

`canBeInProgress` is snapshotted from the versioned guidance rule when the task is
created. The first successful card action moves eligible tasks to `in_progress`; tasks
without that flag complete directly.

`primaryInProgressAgency` is also snapshotted from the rule. When an eligible task enters
progress, it becomes the task's displayed `agency` without interpreting user-facing button
text.

Resolution of an in-progress task with an app-owned informational 311 ticket temporarily
uses `status: "resolving"`, `resolutionUpdateId`, and `resolutionLeaseExpiresAt`. The claim
prevents concurrent, non-idempotent ticket closures. Per-ticket closure checkpoints are
written under that lease; partial or failed closure returns the task to `in_progress` for
retry, while full success atomically writes the resolution event and completed task.

**Short IDs.** `shortId` is the reference staff see on task cards. New tasks mint it as
`<providerShortCode>-<siteShortCode>-<nnn>`. The short codes are site metadata. `nnn`
comes from the site's counter item, padded to 3 digits. `taskId` stays the real key and
API identifier. Gaps in the counter are allowed if a task write fails after taking a
number.

**App-action result shapes** (`code` values from
`backend/src/analysis/guidance/app-actions.js`):

- **`create_311_ticket`**: `payload.tickets[]` with `srNum` and `responsibleAgency`.
  `externalId` joins the SR numbers.
- **`close_311_ticket`**: `payload.closures[]`, one entry per eligible ticket. Each entry
  has `serviceCode`, `srNum`, `closedReasonCode: "8"`, and `status: "closed" | "failed"`,
  plus `updateId` on success or `reason` on failure. No `externalId`. On a retry, tickets
  closed by earlier attempts are copied into `closures[]` as they were, so the latest
  result is always complete. The result status rolls up to `submitted`, `partial`, or
  `failed`. A failed closure never blocks task completion. See
  [guidance workflow](./architecture.md#guidance-workflow-rule-driven-tasks). Each
  successful HUB close is also saved onto the task right away, merged into
  `appActionResults` under the completion lease. HUB closure cannot be repeated safely, so
  this makes sure a crash or lease expiry after HUB accepts a close never closes the same
  SR twice.

### One query reads a whole check

The header and all its children start with `CHECK#<checkId>`. So the check detail screen
is one query: `pk = SITE#x AND begins_with(sk, "CHECK#<checkId>")`. It returns the header,
every artifact, and every analysis.

### Scorecard on the header

Decided 2026-08-14. One `CHECK#<checkId>` is one full perimeter run. There is no separate
"synthesis" item. At `complete`, the worker writes the check-level scorecard onto the
header:

- `grade`: the worst grade across the check's artifacts, on the scale Excellent < Good <
  Fair < Poor < Very Poor. Taken from the service's `general_conditions.label`.
- `categories`: a per-category rollup, `[{ category, maxRating, sourceArtifactIds }]`.
- `rubricVersion` and `synthesizedAt`.

This is written once and never changed. **Why on the header:** the checks list (AP6) is one
GSI1 query over headers only. With `grade` on the header, the list can show each check's
grade without reading its `ANALYSIS#` items. Raw per-artifact output stays in the
`ANALYSIS#` items as `concerns[]`. See
[`adapt-scorecard.js`](../backend/src/analysis/adapt-scorecard.js) and
[`synthesize-check.js`](../backend/src/analysis/synthesize-check.js).

### Global secondary indexes

| GSI | Partition | Sort | Sparse on | Serves | Status |
|---|---|---|---|---|---|
| **GSI1** timelines | two partitions per site: `SITE#<siteId>` and `SITE#<siteId>#ASSESSMENT` | `<startedAt ISO>` (checks) / `<reportedAt>#<assessmentId>` (assessments) | check headers + assessment reports | checks timeline (AP6, AP12) and assessments timeline (AP14). Each partition holds one entity type. | built |
| **GSI2** site worklist | `SITE#<siteId>#TASK#<status>` | `<createdAt>#<kind>#<severity>#<taskId>` | tasks | staff's open tasks, newest first. The app re-sorts each page by severity. See AP10. | built |
| **GSI3** city queue | `ESCALATION#<status>` | `<severity>#<createdAt>#<siteId>` | `city_escalation` tasks only | cross-site escalation queue for the city | **deferred post-MVP**. Sparse, so it can be added with no rebuild. |
| **GSI4** condition history | `SITE#<siteId>#CONDITION#SEV#<severity>` | `<reportedAt>#<assessmentId>#<conditionId>` | conditions | list conditions by site, date, and severity | built |
| **GSI5** unresolved conditions | `SITE#<siteId>#CONDITION#UNRESOLVED` | `<reportedAt>#SEV#<severity>#<assessmentId>#<conditionId>` | unresolved conditions only | list conditions not yet turned into tasks | built |
| **GSI6** pending codes by contact | `SETUP_CODE_PENDING#<siteId>#<contactHash>` | `<createdAt>` | `pending` setup codes only. Keys are removed on use or revoke. | cancel a contact's old code when they ask for a new one (AP21) | built |
| **GSI7** pending codes by site | `SETUP_CODE_PENDING_SITE#<siteId>` | `<createdAt>` | `pending` setup codes only | revoke every open code when a site is deactivated (AP22) | built |

## Access patterns

Every pattern is a single query. There are no scans.

| # | Pattern | Operation |
|---|---|---|
| AP1 | Get site config | `GetItem` `SITE#x` / `#META` |
| AP2 | List a site's users | `Query` `SITE#x`, `begins_with(sk,"USER#")` |
| AP3 | Find an admin's site | read `custom:siteId` from the JWT. No query. |
| AP4 | List devices | `Query` `SITE#x`, `begins_with(sk,"DEVICE#")` |
| AP5 | Create a check | conditional `PutItem` of the header with `attribute_not_exists(sk)`. Idempotent on the client-minted `checkId`. A repeat returns 200 instead of 201. This is not a transaction. Artifacts arrive one at a time (AP5a). |
| AP5a | Register one artifact | conditional `PutItem` of `…#ART#…`, then an SQS send. The two are **not atomic**. Registering the same `artifactId` again re-queues it on purpose. The worker's conditional `ANALYSIS#` write (AP8) absorbs the duplicate. |
| AP6 | List recent or today's checks | `Query` **GSI1** `SITE#x` (checks partition), sort-key date range, newest first |
| AP7 | Open one check with artifacts and analyses | `Query` base `SITE#x`, `begins_with(sk,"CHECK#<id>")` |
| AP8 | Worker writes an analysis | conditional `PutItem` of `…#ANALYSIS#…`. Allowed into an empty slot or over a `failed` marker. Then `UpdateItem` on the header: `ADD issueCount` and a running max of `maxSeverity`. Header `status` does not change until `complete`. |
| AP8a | Amend or reject one analyzed condition | consistent `GetItem` of `SITE#x` / `CHECK#<checkId>#ANALYSIS#<artifactId>`, then an analyzer call and a GSI2 task supersede. Routes use `checkId` + `artifactId`, which is the item's key. The analyzer's `analysisId` is an attribute on the item. The client never supplies it. |
| AP9 | Create tasks | `TransactWrite` of the tasks |
| AP10 | Staff worklist (open tasks) | `Query` **GSI2** `SITE#x#TASK#open`, newest first. The app re-sorts each page most-severe first. The key is date-first, so severity order holds within a page only. A severity-first index is deferred. |
| AP11 | City escalation queue, all sites | `Query` **GSI3** `ESCALATION#open`. Post-MVP; GSI3 is not built. |
| AP12 | Compliance: were there 3 checks on date D? | `Query` **GSI1** for the date range and count |
| AP13 | Cross-site analytics | **not native**. See R2. |
| AP14 | List assessments by site and date | `Query` **GSI1** `SITE#x#ASSESSMENT` (assessments partition), sort-key date range, newest first |
| AP15 | Conditions of one assessment | `Query` base `SITE#x`, `begins_with(sk,"ASSESSMENT#<id>#COND#")` |
| AP16 | Unresolved conditions | `Query` **GSI5** `SITE#x#CONDITION#UNRESOLVED` |
| AP17 | Read guidance, record answers | `GetItem` the assessment and condition; `UpdateItem` on answer |
| AP18 | Read one task's update timeline | `GetItem` the task, then a bounded, cursor-paged `Query` of base `SITE#x`, `begins_with(sk,"TASK#<taskId>#UPDATE#")`, newest first. Update mutations look up the `UPDATE_ID` pointer. |
| AP19 | List a provider's sites | `Query` base `PROVIDER#<providerId>`, `begins_with(sk,"SITE#")`, cursor-paged |
| AP20 | Public site search (bootstrap) | `Query` base `SITE_SEARCH#ACTIVE` with a `contains(searchText, :q)` filter and a bounded `Limit`. One small partition, no scan. |
| AP21 | Resolve or replace a setup code | `GetItem` `SETUP_CODE#<verifier>` / `#META`, falling back to `GetItem` legacy `SITE_CODE#<code>`. On a repeat request, `Query` **GSI6** and revoke the contact's older pending code (`REMOVE gsi6pk, gsi6sk, gsi7pk, gsi7sk`). |
| AP22 | Deactivate a site | `Query` **GSI7** `SETUP_CODE_PENDING_SITE#x` and revoke open codes. Delete the `SITE_SEARCH#ACTIVE` row. Set membership and `#META` status. |
| AP23 | List a Program's contacts and Sites | `Query` base `PROGRAM#<programId>` with `USER#` or `SITE#` sort-key prefix. Program contacts are roster records only and have no authentication principal. |
| AP24 | Assign a Program contact to a Site | transactionally put `SITE#x / ASSIGNED_USER#y`, increment the Program contact's assignment count, and optionally update the Site primary-contact pointer/snapshot. |
| AP25 | Read or add effective-dated terms | `Query` the Site `COMPLIANCE_TERMS#` prefix. Creation transactionally puts the version, conditionally closes the prior open version, marks the letter draft pending, and writes letter-job and audit rows. |
| AP26 | Preview/apply a Site CSV import | Query the three bounded active-directory partitions plus Program users and Site assignments/Manager memberships. Each valid row exact-matches or creates its Site Manager Program user, marks it `siteManager=true`, assigns it to the Site, and creates the canonical Manager membership and email-directory projections in the same conditional transaction as the Provider, Program, and Site changes. Re-import repairs older generic-contact rows that lack the Manager marker or membership. A TTL-bound ledger and terminal row outcomes make retries idempotent. |
| AP27 | List or select this physical device's Site bindings | Query `PHYSICAL_DEVICE#<physicalDeviceId>` with `begins_with(sk,"BINDING#")`, then revalidate each canonical Site binding. Selection conditionally rotates the target binding's session and writes a Site audit event. |
| AP28 | Manager enrolls and manages general devices | Range-query the last hour of `STAFF_GRANT#` rows for bounded hourly limits, conditionally create one active-grant guard, and query `DEVICE_BINDING#` rows filtered to `general`. Redemption/cancellation consumes the guard and token lookup atomically. Individual revocation conditionally updates the canonical binding, compatibility Device row, and physical-device pointer in one transaction. |
| AP29 | Recover Site Manager access by email | Apply per-IP, per-email, and cooldown controls, then query `MANAGER_EMAIL#<emailHash>`. Revalidate every canonical Site and membership and issue one 15-minute, single-use link per active Site membership. The public response is generic whether the address is known, unknown, throttled, or delivery fails. |
| AP30 | City revokes one Site binding | Consistently read `SITE#x / DEVICE_BINDING#y`, then transactionally mark the canonical binding, compatibility Device row, and physical-device pointer revoked with the same incremented generation and append a Site audit event. Pre-binding dev devices retain a bounded legacy fallback until migration is complete. |
| AP31 | City revokes selected Site bindings | Consistently read up to 20 canonical bindings, then use one all-or-nothing transaction to revoke every canonical/compatibility/pointer projection and write the completed operation plus audit event. Already-revoked selections are reported without changing generations. |
| AP32 | City revokes every device at one Site | Require exact typed Site-name confirmation, atomically advance `siteCredentialGeneration` with an applying operation/audit record, then reconcile canonical and bounded legacy rows. The generation change invalidates canonical Site credentials before display reconciliation; the operation finishes `complete` or `partial` with counts. |
| AP33 | Remove one Site Manager membership | Query current Manager bindings at the Site, then atomically deactivate/advance the membership generation, remove both email-directory pointers, revoke up to 30 matching canonical/compatibility/physical-pointer projections, and append an audit event with the impact count. Other Site memberships are unaffected. |
| AP34 | Revoke one physical device everywhere | Query the physical device's binding pointers, then consistently revalidate each active canonical binding and resolve its Site name. Require exact typed device-label confirmation and atomically revoke the physical record plus up to 20 canonical/compatibility/pointer projections, append one audit event per affected Site, and store one physical-device operation result. |
| AP35 | Emergency revoke across Sites | Preview 2–20 active Sites and every current canonical or bounded-legacy binding. Require the exact generated phrase, then use one transaction to advance every selected Site generation and create the operation, audit, and outbox records. A filtered DynamoDB Stream dispatches one SQS reconciliation job per Site. Device writes are idempotent so transient failures retry; each successful worker result updates its Site operation and the aggregate operation to complete. |
| AP36 | Suspend one Site binding | Consistently read the canonical binding, then atomically advance its token generation and mark the canonical, compatibility, and physical-pointer projections suspended with a bounded reason plus a Site audit event. A bounded legacy fallback updates the legacy Device row. Re-enrollment consumes a new single-Site grant and creates a new binding; it never reactivates the suspended row. |
| AP37 | Manage oversight dropdown directories | Query the bounded `ADMIN_DIRECTORY#OVERSIGHT` partition and merge the default department/system values. Creating an option conditionally puts one normalized-name row. City Program Managers remain Cognito users marked by `custom:program_manager`; the local harness uses `ADMIN_DIRECTORY#PROGRAM_MANAGERS` only when no user pool is configured. |

### Who owns a task

Decided 2026-08-12. App code in this repo decides who owns each task, not the analyzer.
After the analysis returns, the app derives conditions, creates tasks, marks each as
`onsite` or `city_escalation`, assigns them, and writes them in one batch (AP9). The owner
is set before anyone sees the task.

The `type` value is set once at creation and never changed. Routing rules may change
later, but old tasks will already be closed. `type` is just an attribute. It needs no
index.

- **In MVP:** the classification logic and the per-site worklist (GSI2, AP10).
- **Post-MVP:** the escalation integrations (sending work to city teams and outside
  systems) and the cross-site city queue (GSI3, AP11). GSI3 is sparse, so adding it later
  costs nothing now.

## Scale

- 400 sites × 3 checks a day = **1,200 checks a day**, about 438k a year. Trivial for
  DynamoDB.
- Each site's partition grows by about 1,095 checks a year. It will take **years** to get
  large. The `expiresAt` TTL attribute is already wired on the table but turned off. Turn
  it on when retention policy allows, after fixing the ISO-string `expiresAt` on
  setup-code rows (see fact 4 above).
- Writes are spread across 400 sites. There is **no hot partition**.
- Capacity is on-demand, pay per request. It scales to zero. Nothing to size.

## Idempotency and the existing code

The client makes a UUID `checkId` and sends it as the `idempotency-key` header.
`createCheck` writes the header with `attribute_not_exists(sk)`. A repeated request
cannot create a duplicate. Full offline queue-and-replay (a Workbox service worker) is
deferred past MVP. The idempotency contract is already in place for when it lands. AI
analysis stays asynchronous through the existing SQS → worker path.

**Current state: built.** `createCheck`, `registerArtifact`, and `completeCheck` write real
`SITE#`, `CHECK#`, `ART#`, and `ANALYSIS#` items, keyed by the client's `checkId`, with
conditional writes. The older idempotency **receipt** (`pk = SUBMISSION#<requestId>`,
`sk = #RECEIPT`) survives only on the legacy `/submissions` demo loop. The check path does
not use it.

## City-wide reporting and analytics

City leaders will want reports across sites. For example:

- Which site has the best or worst cleanliness record?
- Which sites do their checks regularly, and which do not?
- How have conditions changed over time, for one site, a group of sites, or all sites?

These are analytical queries: aggregates, rankings, group-bys, time series. DynamoDB is
built for fast single-item reads and writes, not for this. So we never run these on the
operational table with scans or awkward indexes. Instead the work is split. The app table
stays lean, and a separate read-optimized analytics layer is fed from it. This split is
sometimes called CQRS.

The analytics layer has two tiers:

- **Tier 2: built.** Scheduled exports from DynamoDB to S3, queried with DuckDB
  ([ADR 0013](./adr/0013-analytics-read-plane.md)).
- **Tier 1: designed, not built.** Live counter items kept up to date by DynamoDB Streams.

### Tier 1: live counters (designed, not built)

No `#STATS#` items, aggregator Lambda, or shared `scoring` module exist in the repo today.
DynamoDB Streams are already **on** for the table (`NEW_AND_OLD_IMAGES`,
`infra/modules/app/main.tf`), with nothing consuming them. The aggregator can be added
without a table change.

The design: the day is the unit of counting, because the legal duty is 3 checks per day.
Longer windows add up a range of days. A Streams-triggered Lambda would update the
counters on each write. It must be idempotent, because Streams can deliver an event twice.
Reads would be a single `Query`, never a scan.

| `pk` | `sk` | Attributes |
|---|---|---|
| `SITE#<siteId>` | `#STATS#<yyyy-mm-dd>` | raw components: `checksCompleted`, `issueCount`, `maxSeverity` |
| `STATS#<yyyy-mm-dd>` | `<score>#<siteId>` | one day's ranking across all sites. All ~400 sites in one query. |

Counters hold **raw components, never a finished score**. Scores are computed when read.
A formula change is then a one-function edit. The `severitySum` and `hazardCount`
components from the original design are **retired**. See
[Metric definitions](#metric-definitions).

### Tier 2: S3 export lake (built)

An incremental DynamoDB export to S3 runs every 6 hours. It needs point-in-time recovery,
which is on. The export is converted to Parquet files split by entity, and DuckDB runs SQL
over them for any set of sites or time grain. The pipeline lives in
`infra/modules/app/analytics.tf`:

| Lambda | Trigger | Role |
|---|---|---|
| `analytics-export` | EventBridge `rate(6 hours)` | incremental export, starting from the `ANALYTICS#EXPORT` / `#WATERMARK` cursor, into the analytics lake bucket |
| `analytics-convert` | export completion | rewrites the export as Parquet, split by entity |
| `analytics-query` | `GET/POST /admin/v1/analytics/*`, behind the admin JWT authorizer | runs DuckDB over the Parquet lake and serves the named query catalog (`backend/src/analytics/catalog.js`) |
| `analytics-report` | EventBridge `cron(0 14 * * ? *)`, 06:00 America/Los_Angeles | builds the daily citywide report |

ADR 0013 replaced the Glue and Athena tooling we first sketched. Athena could still be
added over the same Parquet later. We also considered a streaming Firehose-to-Parquet
build (T2b) and **rejected** it. Near-real-time feeds are more than leadership reporting
needs. The 6-hour export is the design.

### Infrastructure

All of it is Terraform. Nothing is set up by hand.

- **Built:** DynamoDB Streams on the table (no consumer yet), the S3 analytics lake bucket
  (KMS, lifecycle rules), the four Lambdas, and the two EventBridge schedules above.
- **Not built:** the Tier-1 Streams aggregator and the `#STATS#` counter items. No
  Firehose (see T2b above). Dashboards, if any, will be app-rendered or QuickSight.
  Decide when building.

Tier-1 buildout is post-MVP and tracked on the issue tracker.

## Metric definitions

Settled 2026-08-12 as a product decision. "Best cleanliness record" and "regularity" are
defined below. Both are computed **when read**, never stored. Today that happens in the
Tier-2 DuckDB SQL (`backend/src/analytics/catalog.js`; the compliance rule is the
`COALESCE(c.checks, 0) >= 3` filter). The shared `scoring` module planned for Tier 1 does
not exist yet. When Tier 1 lands, the module and the SQL must agree. Neither tier stores
a score, so there is nothing to migrate.

- **Cleanliness is grade-based.** Settled 2026-08-14. The check **grade** is the service's
  `general_conditions.label`: Excellent, Good, Fair, Poor, or Very Poor. The service
  computes it from all category severities and the per-category `weighting` in the GNA
  rubric (`good-neighbor-app` v1.0.0). We take it as-is and stamp it on the `CHECK#`
  header (see [Scorecard on the header](#scorecard-on-the-header)). The service returns
  only an **exceptions list** (`identified_conditions_of_concern[]`), not a severity for
  every category, so a severity average is undefined. `issueCount` and `maxSeverity` from
  that list remain as raw components. `hazardCount` is retired; `hazard_detected` is gone
  from the contract. Weighting lives in the service and is baked into the grade, so we
  store none of our own. See
  [`adapt-scorecard.js`](../backend/src/analysis/adapt-scorecard.js).
- **Evidence mix is not a score input.** The header's `evidenceKind` (`photos`,
  `description`, `mixed`, or `none`) and its `photoCount` / `textCount` are stamped once at
  `complete`. They let us report how often staff use text instead of photos.
- **Regularity is a legal 3 per day, with no grace.** Three checks a day is a legal
  requirement. Today it lives as the literal `>= 3` in the analytics SQL, not as a named
  constant. There is **no grace period** for device outages. The duty is per day, so
  compliance is per day and yes-or-no: a day is **compliant if it had 3 or more checks**.
  Compliance over a window is `compliant_days / total_days`. A flat ratio of
  `completed ÷ (3 × days)` was rejected. It would let extra checks on one day hide a
  missed day.

**Easy to change later.** These defaults are simple on purpose. Counters hold raw
components, never a baked score. The formula lives in one place per tier. Test data is
disposable and cleared between test cycles, so formulas can change during testing with no
migration cost.

## Limitations and workarounds

| # | Limitation | Status | Mitigation |
|---|---|---|---|
| **R1** | The city needs a **cross-site** view, which breaks per-site partitioning | Deferred post-MVP | GSI3 collects `city_escalation` tasks across sites. Toxic escalations are rare, so the `ESCALATION#open` partition stays small. Shard the key later only if volume demands it. |
| **R2** | **Cross-site analytics** for city-wide reports. See [City-wide reporting](#city-wide-reporting-and-analytics). | Tier 2 built; Tier 1 deferred post-MVP | The Tier 2 lake (S3 export → Parquet → DuckDB, [ADR 0013](./adr/0013-analytics-read-plane.md)) serves the admin analytics routes today. Tier 1 live counters (Streams → counter items) are design only. Cheap at this volume. |
| **R3** | Detecting a **missing** check (a site did fewer than 3 today). You cannot query for something that was never written. | Not built | Design: a scheduled EventBridge sweep walks the site registry and counts GSI1 rows per site. Not a single query, but it is a cron job, not a hot path. Today the daily Tier 2 report answers this after the fact from the Parquet lake. |
| **R4** | Photos/audio exceed the **400 KB item limit** | Handled by design | Blobs go to the existing S3 uploads bucket. Items store the S3 key and use presigned URLs. Never store media in the item. |
| **R5** | Tenant isolation must be **airtight** across 400 tenants | **Runtime authorization and negative tests enforced; shared-role IAM cannot express caller-dynamic scoping.** | Every protected route authenticates, derives `siteId` from the verified principal, and builds partition keys server-side. Media also uses exact server-owned keys and refuses to sign a stored pointer outside that Site/check. A `LeadingKeys = SITE#${custom:siteId}` condition cannot be applied to the shared API Lambda execution role: DynamoDB sees the Lambda role, not the JWT/device principal, and central-admin operations intentionally access global partitions. A future platform backstop requires a separate tenant-only data-plane function/role or per-request tagged-role assumption; do not add a misleading `SITE#*` condition. |
| **R6** | Anonymous staff, so **no per-person attribution** | By design | Attribution is site + device. If per-person is ever needed, add a device-local PIN or roster. Not required now. |
| **R7** | Each task status change rewrites its GSI2 entry | Normal | Expected DynamoDB behavior. Volume is tiny. |

R1 (GSI3) and the rest of R2 are post-MVP and tracked on the issue tracker. The others are
routine.

## Settled questions

1. **City cross-site queue.** Deferred post-MVP. GSI3 is sparse and can be added with no
   rebuild. The queue view ships with the escalation integrations.
2. **Retention.** Enforced by upload-state tags: pending/rejected one day,
   registered two days, accepted seven days, and noncurrent media versions one day.
3. **Analytics scope and metrics.** The Tier 2 S3-export lake is built
   ([ADR 0013](./adr/0013-analytics-read-plane.md)). Tier 1 live KPIs are post-MVP. Metric
   definitions are settled (see above).
4. **Single table.** Confirmed, for the `LeadingKeys` isolation reason. The non-tenant item
   types (provider, search, setup code, analytics watermark) live outside `SITE#` by
   design.
5. **Per-place artifact model.** Retired
   ([ADR 0014](./adr/0014-remove-places-photo-roll.md)). The artifact key is
   `CHECK#<checkId>#ART#<artifactId>`. Rows written before the change keep their
   `<placeId>` segment and stay readable through the prefix query and `artifactId` match.

## Guidance refresh lineage

`GUIDANCE_CURRENT#<JSON [checkId, lineageId]>` items in the site's partition point to the
current assessment for an artifact. The lineage ID is the artifact ID. Assessments created
through the API with no artifact use their original assessment ID instead.

Publishing a refresh does all of this in one transaction:

- moves the pointer to the new assessment
- marks the old assessment with `supersededByAssessmentId` and `lineageId`
- writes the new assessment and its conditions
- supersedes open tasks whose conditions changed or disappeared

Completed tasks stay as history. A task that is mid-completion blocks the refresh until it
settles. The revision check on the old assessment also protects against concurrent
answers. Answer writes to a replaced assessment are rejected. Reads of historical guidance
go through the pointer.

Existing assessments get the pointer and the superseded marker on their first refresh. No
data migration is needed. For conditions with no artifact, answers carry over only when
both revisions have an explicit condition ID (`explicitConditionId`), the same lineage,
and the same policy, category, severity, and description. Empty evidence lists alone do
not prove two conditions are the same. Tasks are retired only after the guidance publish
succeeds. An analyzer amendment on its own no longer retires tasks.
