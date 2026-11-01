# DynamoDB Data Model — Perimeter Checks

*Data-model reference · [index](../README.md) · ← [decision](./adr/0002-datastore-dynamodb.md)*

**Status:** Current code model. Verify deployment and migration state per environment.
**Reviewed:** 2026-10-28 against `151a7d76` for storage, indexing, and lifecycle behavior.
**Date:** 2026-08-12 · updated 2026-09-04 for the built state · 2026-09-21 for the photo roll ([ADR 0014](./adr/0014-remove-places-photo-roll.md)) · 2026-10-01 to match the deployed authorizers, UUID IDs, provider and setup-code items, GSI6–7, and the analytics tier status · 2026-10-13 for the GSI1 task and update partitions behind the site manager reports (AP27, AP28) · 2026-10-14 for public complaints · 2026-10-28 for GSI3 (the compliance-terms expiry sweep) and the removal of the unread GSI4 and GSI5

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

#### Capture guidance

The capture title recommends three photos without changing the completion gate.
Two detailed photos with no wide shot prompt for the whole sidewalk; two wide
shots with no detailed shot prompt for issue details. A subsequent complementary
shot earns an acknowledgement. Four live photos override all titles with the
additional-photo encouragement. Pending or unclassified photos count toward the
visible total but not framing counts; failed uploads are excluded. Deletion
recalculates the title and count from retained evidence.

Starting titles use completed perimeter checks across every device at the Site,
counted by Pacific completion date. The third check of the day gets its own title;
the first check after exactly three consecutive days with at least three checks
per day gets the fourth-day celebration. Other starts use the three-photo guidance.
The starting title is saved in the local draft as `captureGuidanceContext` and
retained on resume. `GET /v1/checks:capture-guidance` reads base-table completion
records consistently for the five Pacific days ending at the capture start instant.
It includes completions at or before that instant and excludes the current check.
A completion record is written in the same conditional transaction as its header,
so retries do not double-count and GSI propagation is irrelevant. The query is
bounded by completion date, including older-started checks completed recently.
Navigation cancels the frontend request. Unavailable history uses the default title
without persisting it as a resolved starting context.

Existing headers require the completion backfill before guidance is enabled. The
endpoint returns 503 until the global migration readiness record is set; fresh
empty tables also require this initialization. See [the backfill runbook](runbooks/check-completion-guidance.md).

## Facts that shape the model

1. **The city needs one queue of escalations across all sites.** This is the only
   cross-site read we planned for. It would be a sparse partition on GSI3, the
   cross-site index that now exists for the compliance-terms expiry sweep. The
   escalation partition itself is deferred past MVP; items that set its keys can be
   added later without rebuilding the table.
2. **Staff are anonymous.** A check is attributed to the site and the device, never to a
   person. See [Identity model](#identity-model).
3. **Photos live in S3, not DynamoDB.** Items store the S3 key. See R4.
4. **Media retention is enforced by bucket-wide S3 lifecycle rules.** Check/task
   media expires after 30 days, while complaint evidence lives in a separate bucket
   and expires after one year. In either bucket, pending/rejected upload tags shorten
   retention to one day. DynamoDB TTL is enabled on
   `expiresAt` for numeric operational expiries such as upload reservations, daily
   quota counters, rate limits, and import staging. Legacy/domain rows that store an
   ISO date string in the same attribute are ignored by DynamoDB TTL and continue to
   use application-level expiry checks.

## Identity model

Who can write what:

| Principal | How they authenticate | What they write | How their scope is enforced |
|---|---|---|---|
| **City administrator** | Cognito JWT with `compliance-manager` or `compliance-supervisor`; `central-admin` is a legacy manager alias | cross-Site configuration and operations | role and Site-assignment guards plus server-built keys |
| **Site-bound device** | bounded access token checked against current physical-device, binding, membership, and Site generations | perimeter checks, artifacts, and Manager operations allowed by binding access | authorizer-derived Site/access claims plus server-built keys and negative tests |
| **Performer** (staff member) | none; they use the device | nothing directly | not needed; attribution is device + site |
| **City reviewer** | Cognito Compliance manager or supervisor | cross-Site reads allowed by the endpoint; System Status is supervisor-only | endpoint role guard |

The key decision: **the device is authenticated as the site.** Staff never need accounts.
Every check is still tied to a site and a device. The admin registers the device once
during setup.

Tenant isolation is enforced at the application boundary: the authorizer verifies the
current binding and supplies the Site claim, and handlers derive keys from that claim.
The media path adds exact server-owned key validation and re-checks stored pointers before
signing reads. A shared Lambda role cannot express a different `LeadingKeys` value for each
JWT caller because DynamoDB sees the execution role, not the original principal.

### What runs today

Current route and authorization configuration is in `infra/modules/app/api.tf`:

- Protected field-app routes use the **device-token authorizer**
  ([ADR 0010](./adr/0010-device-token-auth.md), `backend/src/lambda/authorizer.js`). It
  checks the bearer token against the site's `DEVICE#` session and applicable
  physical-device, binding, Site, and membership authority. It adds `custom:siteId`
  to the request. API Gateway caches verdicts for 60 seconds, so revocation can
  take that long to affect cached requests. Refresh and binding selection perform
  their own current-authority checks.
- Routes under `/admin/v1/*`, including analytics, use a **Cognito JWT authorizer**. The
  handlers enforce Compliance roles and Site assignments (`backend/src/lib/admin-auth.js`).
- Open routes include bootstrap and recovery, `/health`, best-effort intakes,
  and the token-bound 311 media redirect. The explicit open-route list in `api.tf`
  is authoritative; `/v1/devices*` is not an anonymous wildcard.
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

One application table, `good-neighbor-app-<env>-app` with the default Terraform
application name, and partition key `pk` and sort key `sk`. The local harness uses
`gnp-local-app`; isolated E2E tests use `gnp-local-e2e`.

Site-domain records share `pk = SITE#<siteId>`, placing a check's header, artifacts,
and analyses together for prefix queries. Cross-Site identities and reporting
projections use other partitions. This layout supports server-built tenant keys;
it does not provide caller-specific IAM isolation in the shared Lambda role.

A few item types live **outside** the `SITE#` prefix. They are needed before we know the
site, or they span sites:

- provider config and provider membership (`PROVIDER#`)
- the public site and provider search rows
- setup codes and their request throttles
- the analytics export watermark
- the legacy submission receipt
- Programs, canonical people, administrator directories, and profile journals
- physical devices, enrollment-token lookups, and Home Screen handoff grants
- system-status projections, migration markers, and revocation operation roots
- 311 media leases and the duplicate-comparison request pacer

These records have endpoint- or worker-specific ownership and authorization rules;
they are not all limited to admin/bootstrap code. See the inventory and the reporting
and integration sections below for their access paths.

**IDs are opaque, not chronological.** The client normally makes `checkId` with
`crypto.randomUUID`; the backend uses UUIDs for newly allocated artifact and task IDs.
Assessment IDs may be client-supplied and derived from check/artifact identity;
condition IDs may be explicit analyzer identities or generated fallbacks. UUIDs have
**no time order**, so
`CHECK#<checkId>` does not sort by time. The checks timeline comes from GSI1, whose sort
key is `startedAt`. Any key that must sort by time includes a timestamp on purpose, such
as task update events and every GSI sort key.

### Item types

| Entity | `pk` | `sk` | Notes |
|---|---|---|---|
| Site config | `SITE#<siteId>` | `#META` | `type`/`entityType`, name, optional `siteType` (`permanent_supportive_housing`, `shelter`, `drop_in`, or `other`), `address` + `addressParts`, `location` (lat/lng) + `geocodedAddress`, `providerId` / `providerName` / `providerSiteId`, `status`, `publicContact` (public email/phone/extension shared by the dashboard and field app), legacy `contactPerson`, admin-managed `oversight` / `compliance` / `perimeter` / `complianceLetters`, runtime presentation `featureFlags` (currently `duplicateDetection`, boolean, default true), `providerShortCode`, `siteShortCode`. New Sites have no active perimeter-check period. Site `compliance` is a write-side snapshot; canonical effective-dated `COMPLIANCE_TERMS#` records determine requirement status, report duties, and the current/past classification of version-linked letters. A missing canonical period never implies a default requirement. Site compliance stores `underEnhancedMonitoring` as a boolean, set from the enhanced-monitoring reason when saving a requirement and cleared when that requirement is ended. Each compliance period snapshots the flag for history. `perimeter` is a plain-text description editable by the dashboard and Site Manager app (not geometry or a geofence), with `perimeterUpdatedAt` and `perimeterUpdatedBy` edit metadata. Compliance letters keep a private S3 key. The site response for devices mints short-lived download URLs. |
| Device | `SITE#<siteId>` | `DEVICE#<deviceId>` | Compatibility projection for authorization and refresh: label, physical-device ID, lastSeenAt, lifecycle/expiry fields, `tokenGeneration`, `refreshJti`, optional `primarySessionKind` / `primarySessionStatus` / `primaryLastSeenAt`, and a bounded `sessions` map (up to eight live Home Screen contexts with independent generation, refresh JTI, status, activity and expiry). A stable `sessionStartGeneration` floor distinguishes replacement enrollments/reactivated sessions from refreshes; legacy sessions omit it until replacement. Each session may hold one encrypted `refreshRecovery` receipt with a five-minute enforced expiry; see [ADR 0020](./adr/0020-retryable-refresh-recovery.md). Signed JWT `sid` selects a slot; tokens without it use the primary fields. All contexts share parent revocation and authority. See ADR 0019. Also stores canonical `accessLevel` (`general` or `manager`). |
| Legacy code/master contact | `SITE#<siteId>` | `CODE_CONTACT#<emailHash>` / `MASTER_CONTACT#<emailHash>` | Retired. Master contacts are migrated to Site manager memberships in dev; these records no longer authorize setup-code requests. |
| Manager membership | `SITE#<siteId>` | `MANAGER_MEMBERSHIP#<membershipId>` | One email-based Site Manager role at exactly one Site. Stores normalized `email`, keyed verifier in `emailHash`, optional source `programId` / `userId`, `status`, `role=manager`, and a generation advanced on removal so later bindings can fail closed. Contact edits update the email-directory pointers transactionally without revoking active bindings. |
| Manager email uniqueness | `SITE#<siteId>` | `MANAGER_EMAIL#<emailHash>` | Conditional uniqueness marker pointing to the active `membershipId`; written and removed in the same transaction as membership lifecycle changes. |
| Manager membership directory | `MANAGER_EMAIL#<emailHash>` | `SITE#<siteId>#MEMBERSHIP#<membershipId>` | Non-secret pointer used only by the public Manager recovery flow. Each result is revalidated against the canonical Site and membership before a separate, single-Site link is issued. Existing memberships are populated by the dry-run-first directory backfill. |
| Manager enrollment grant | `SITE#<siteId>` | `MANAGER_GRANT#<createdAt>#<grantId>` | 24-hour, single-use, single-Site Manager enrollment grant with grant-email and post-redemption security-notification delivery evidence. Stores only the link token's SHA-256 verifier or the six-character code's keyed HMAC verifier; list APIs omit it. |
| Current Manager enrollment grant guard | `SITE#<siteId>` | `MANAGER_GRANT_CURRENT#<membershipId>` | Conditional singleton for one unexpired Manager grant per membership. Creation replaces only the grant observed by the request; redemption or cancellation deletes the matching pointer atomically. |
| Current Manager recovery grant guard | `SITE#<siteId>` | `MANAGER_RECOVERY_GRANT_CURRENT#<membershipId>` | Conditional singleton for one unexpired self-service recovery grant per membership. Recovery links replace only earlier recovery links, so an unredeemed administrator-issued invitation remains valid. |
| Staff enrollment grant | `SITE#<siteId>` | `STAFF_GRANT#<createdAt>#<grantId>` | Eight-hour, single-use Site invitation issued by an active Manager binding. Site Managers issue general-access grants; Provider Managers can also issue manager grants linked to a new named Site membership. Stores the intended device label, target role, issuing authority snapshots, status, and only the token verifier. Provider snapshots include membership ID/generation, Provider ID, Site credential generation, and provider-access generation, all revalidated transactionally at redemption. |
| Staff grant issuance version | `SITE#<siteId>` | `STAFF_GRANT_ISSUANCE#VERSION` | Site-wide optimistic concurrency guard. Read strongly before counting the rolling hour; conditionally replace its opaque version in every grant creation transaction. No credentials or authorization are stored here. |
| Enrollment-token lookup | `ENROLLMENT_TOKEN#<tokenHash>` | `#META` | Opaque lookup from a presented 256-bit link token or six-character manual enrollment code to its grant. Raw credentials are never stored. Successful redemption atomically adds `redeemedAt` and a numeric `expiresAt` TTL 30 days later, retaining a replay diagnostic tombstone. Cancellation removes the lookup. |
| Home Screen handoff grant | `SESSION_HANDOFF#<grantId>` | `#META` | Single-use grant with SHA-256 token verifier, source Site/device/session, pending status, and numeric seven-day `expiresAt`. Issuance transactionally replaces the device's `handoffGrantId` pointer; redemption adds an independent session to the same Device row. Application checks enforce expiry and current authority before TTL cleanup. |
| Physical device | `PHYSICAL_DEVICE#<physicalDeviceId>` | `#META` | Stable browser/device identity shared by one or more Site bindings. Stores label, lifecycle status, and enrollment timestamps; no Site authorization is inferred from this item alone. A revoked physical identity cannot redeem another enrollment grant. |
| Device binding | `SITE#<siteId>` | `DEVICE_BINDING#<bindingId>` | One physical device's role at one Site. Stores canonical `general` or `manager` access, membership and Site generations, rotating-refresh state, 365-day absolute expiry, 60-day inactivity policy, enrollment provenance, and lifecycle status. Provider-derived bindings additionally store `authorityScope=provider`, Provider/membership IDs and generation, and the provider enrollment ID. Suspension records its reason, actor, and time; suspended bindings are immutable and never restored in place. |
| Physical-device binding pointer | `PHYSICAL_DEVICE#<physicalDeviceId>` | `BINDING#<bindingId>` | Non-secret ownership and discovery pointer to one Site binding. It grants no access by itself; listing and selection revalidate the canonical binding, compatibility Device row, Site generation/status, expiry/inactivity, and Manager membership where applicable. |
| **Check header** | `SITE#<siteId>` | `CHECK#<checkId>` | status (`in_progress` → `completed`), startedAt, `flowType` (`perimeter` or `single-problem`), running `issueCount` / `maxSeverity` counters that the worker bumps. **At `complete` the header also gets:** `grade`, `summary`, `categories`, `rubricVersion`, `photoCount` / `textCount` / `evidenceKind`, `synthesizedAt`, `completedAt`. See [Scorecard on the header](#scorecard-on-the-header). |
| **Artifact** (one photo or description) | `SITE#<siteId>` | `CHECK#<checkId>#ART#<artifactId>` | S3 key or text, capturedAt, server `receivedAt` (new registrations), latitude/longitude and optional `accuracyMeters` (set at register, or later by AP5b), contentType; `thumbS3Key` (`<s3Key>.thumb.webp`, set by the analyze worker once the card thumbnail is stored — absent until then, so `presignMedia` falls back to the original). See [Old artifact rows](#old-artifact-rows). |
| **Perimeter completion** | `SITE#<siteId>` | `CHECK_COMPLETION#<Pacific date>#<completedAt ISO>#<checkId>` | Immutable `checkId` and `completedAt`, written atomically with perimeter completion; no GSI attributes or TTL. Strongly consistent completion-date queries power capture guidance. Single-problem reports have no marker. |
| **Completion migration readiness** | `SYSTEM#MIGRATIONS` | `CHECK_COMPLETIONS_V1` | `status: "ready"` and migration `completedAt`; written only after the entire historical backfill succeeds. |
| **Analysis** (one per artifact) | `SITE#<siteId>` | `CHECK#<checkId>#ANALYSIS#<artifactId>` | `status` (`analyzed` or `failed`), `analysisId`, `model`, `rubricVersion`, `grade`, `gradeDescription`, `concerns[]` (each with a per-locale `translations` map of its `userFriendlyLabel` / `explanation`, filled in by the background translate worker), `issueCount`, `maxSeverity`, `analyzedAt`, optional `shotType` (`wide` or `detail`, from image manifest index 0), optional lat/lng + `georeferencedAddress`. A `failed` item holds `error` instead of results and may be replaced by a successful analysis retry. The translate worker updates analysis concerns and condition/task translation maps in place. |
| **Complaint header** | `SITE#<siteId>` | `COMPLAINT#<complaintId>` | `status` (`analyzing`, `ready`, or `analysis_failed`), list `label`, generated `detail`/`what`/`where`/`when`/`notes`, optional submitted description, artifact count, timestamps, and numeric one-year `expiresAt`. GSI1 uses `SITE#<siteId>#COMPLAINTS` plus `createdAt#complaintId` for newest-first listing. |
| **Complaint artifact** | `SITE#<siteId>` | `COMPLAINT#<complaintId>#ART#<artifactId>` | Private S3 key, original name, verified content type/length, `status` (`registered` or the retryable deletion tombstone `deleting`), and numeric `expiresAt`. Draft rows expire after one day; submission transactionally advances them to one year after retagging the object `state=complaint`. |
| **Assessment report** | `SITE#<siteId>` | `ASSESSMENT#<assessmentId>` | status, `policyVersion`, `rubricVersion`, grade, `reportedAt`, `assessmentRevision`, `lineageId`, `summary{}` counts, `rawAssessment`. Gets `supersededByAssessmentId` when a refresh replaces it. |
| **Condition** | `SITE#<siteId>` | `ASSESSMENT#<assessmentId>#COND#<conditionId>` | `canonicalCategory` / `analyzerCategory`, severity, `userFriendlyLabel`, `description`, `translations` (per-locale map, see [localization](./localization.md)), `answers`, `outcome`, `selectedRuleId`, status, `taskIds`, `resolvedToTasks`, `needsAnswer`, `source`. See [guidance workflow](./architecture.md#guidance-workflow-rule-driven-tasks). |
| Guidance current pointer | `SITE#<siteId>` | `GUIDANCE_CURRENT#<JSON [checkId, lineageId]>` | points to the current assessment for one artifact. Moved atomically on refresh. See [Guidance refresh lineage](#guidance-refresh-lineage). |
| **Task** (action item) | `SITE#<siteId>` | `TASK#<taskId>` | `shortId`, kind (`action` \| `escalation` \| `non_actionable_escalation`), type (`onsite` \| `city_escalation`, derived from kind), immutable evaluated `ruleId`, policyVersion, optional `actionOverride` (selected rule/custom type, original rule, actor, time), optional recorded `customAction` text/outcome, `canBeInProgress`, `primaryInProgressAgency`, category, severity, status, `userFriendlyLabel`, `description`, `translations` (per-locale map copied from the condition) |
| **Task update event** | `SITE#<siteId>` | `TASK#<taskId>#UPDATE#<occurredAt>#<updateId>` | append-only timeline event for an in-progress task: type, label, actorId, `text` / `notes`, `photoKeys` (artifact IDs), optional `presencePeriod`, `documentationState` |
| Task update pointer | `SITE#<siteId>` | `TASK#<taskId>#UPDATE_ID#<updateId>` | finds an update by ID alone, for documentation and safe retries. Stores the event's full sort key. |
| Task update media | `SITE#<siteId>` | `TASK#<taskId>#MEDIA#<artifactId>` | photos attached to an update. Not analyzer input. A `CHECK#<checkId>#UPDATE_MEDIA#<artifactId>` pointer lets the normal media route serve them. |
| Upload reservation | `SITE#<siteId>` | `UPLOAD_RESERVATION#<checkId>#<artifactId>` | 24-hour record created before issuing a media PUT; binds key, type, and declared bytes. |
| Upload request mapping | `SITE#<siteId>` | `UPLOAD_REQUEST#<check-or-complaint>#<encoded-parentId>#<clientRequestId>` | Optional retry identity committed with quota writes. Binds actor, type, bytes, artifact ID and object key; `renewUntil` is 24 hours after creation and TTL is one day later. Replays revalidate the parent without charging again. |
| Daily check/device media quota | `SITE#<siteId>` | `MEDIA_QUOTA#<yyyy-mm-dd>#CHECK#<checkId>`, `...#DEVICE#<actorId>` | Conservative reserved byte and artifact counts: 200 reservations/512 MiB per site/actor/UTC day; check limits remain 20/50 MiB. Counters expire after the quota day so abandoned upload URLs cannot permanently exhaust a Check. Legacy `...#SITE` rows are no longer read or written and expire via TTL. |
| Task display ID counter | `SITE#<siteId>` | `COUNTER#task-display-id` | `nextTaskDisplayNumber`, a counter that only goes up. Used to mint task `shortId` values. |
| Provider config | `PROVIDER#<providerId>` | `#META` | managed by central admin: name, `status`, timestamps |
| Program config | `PROGRAM#<programId>` | `#META` | managed by central admin: Provider relationship, name, required contact, optional Program Manager reference, migration-placeholder/review flags, status, timestamps |
| Program contact | `PROGRAM#<programId>` | `USER#<userId>` | non-authenticating roster/contact record: name, optional phone and extension, normalized email, `siteManager` directory marker, status, Site-assignment count, timestamps. Archival is blocked while assignments remain. |
| Site manager assignment | `SITE#<siteId>` | `ASSIGNED_USER#<userId>` | assignment to an active Site manager contact in the Site's lead Program, with a contact snapshot for display. A Site may have multiple Site managers; the manager used on a compliance letter is selected when its compliance period is created. |
| Compliance manager directory | `ADMIN_DIRECTORY#PROGRAM_MANAGERS` | `MANAGER#<normalizedEmail>` | City Compliance manager identity keyed by normalized email. It can be imported before a Cognito account exists; a later invitation links the row with `cognitoSubject` and `cognitoRole` after exact-name conflict checks. Stores contact and department details used for administration and letter snapshots. |
| Profile mutation journal | `ADMIN_PROFILE_LOCK#<cognitoSubject>` | `#LOCK` | Serializes profile GET/PUT with an ownership token and 16-minute `leaseUntil` (milliseconds). A `recovery` record stores prior Cognito name attributes, pool/username, and directory key before dual writes. The directory is the commit point; failed repairs retain the journal for retry on the next profile request. No TTL or GSI keys; delete only after completion or recovery. |
| Site Compliance manager assignment | `SITE#<siteId>` | `COMPLIANCE_MANAGER#<managerId>` | Active Site administration assignment for one Compliance manager directory identity. Compliance managers can read globally after Cognito authentication, but Site mutations require this active row. Supervisors bypass Site assignment. |
| Provider manager membership | `PROVIDER#<providerId>` | `PROVIDER_MANAGER#<managerId>` | Provider-scoped manager contact with normalized email, contact details, lifecycle status, and generation. Deactivation advances the generation so every derived Site binding fails closed; reinstatement never restores an older generation. Only Compliance Supervisors administer these rows. |
| Provider manager email directory | `PROVIDER_MANAGER_EMAIL#<emailHash>` | `PROVIDER#<providerId>#MEMBERSHIP#<membershipId>` | Non-secret active-membership pointer maintained transactionally with Provider Manager lifecycle changes. Canonical membership revalidation remains required. |
| Provider Manager enrollment grant | `PROVIDER#<providerId>` | `PROVIDER_MANAGER_GRANT#<createdAt>#<grantId>` | 24-hour, single-use provider-scoped grant issued by a Compliance Supervisor. It snapshots the membership generation but resolves active Sites at redemption. Stores only the token verifier and aggregate Site/delivery evidence. |
| Current Provider Manager grant guard | `PROVIDER#<providerId>` | `PROVIDER_MANAGER_GRANT_CURRENT#<membershipId>` | Conditional singleton for one unexpired provider grant per membership. Redemption, cancellation, or replacement removes or changes the matching pointer atomically. |
| Provider Manager enrollment | `PROVIDER#<providerId>` | `PROVIDER_MANAGER_ENROLLMENT#<enrollmentId>` | Directly addressable root lifecycle record for one physical device's all-or-nothing provider redemption. Stores the membership generation and up to 21 Site/binding pointers so a Supervisor can revoke every still-active projection in one transaction. List responses derive active/partial/revoked state from the authoritative physical-device and binding rows. |
| Perimeter-check compliance period | `SITE#<siteId>` | `COMPLIANCE_TERMS#<effectiveStart>#<versionId>` | Immutable effective-dated period containing one or more reason codes, integer checks/day (1–8), a snapshotted `underEnhancedMonitoring` boolean (reason 6 only), and a snapshot of the selected Site manager plus the authenticated generator. The generator—not a client-nominated manager—appears as sender; Compliance managers must be assigned to the Site while supervisors may generate for any Site. Generator phone is required. Start is the server's current Pacific date; the user-facing end date is inclusive and is stored with an exclusive boundary. Reasons 1 or 6 require an end date. Missing expiry means indefinite. A version with an end date carries GSI3 keys (`COMPLIANCE_TERMS#OPEN` / `<expiresOnExclusive>#<siteId>#<versionId>`) until it ends or is superseded. |
| Global silent 311 control | `SYSTEM#CONTROLS` | `SILENT_311` | `enabled` (missing defaults true), optimistic `revision`, `epochStartedAt`, and authenticated `updatedBy`. Every transition advances the epoch; only new silent task workflows after enablement are eligible. No backlog replay. |
| SF311 job | `SITE#<siteId>` | `SF311_JOB#<taskId>#<phase>` | `SF311_OUTBOX`, committed with task creation, action override, resolution, or a "File 311 ticket" tap (phase `filed-<id>`, `trigger: "user_confirmed"`, `actorId`). Streams dispatches to SQS; status tracks pending/dispatched/retry/complete/failed and results retain ticket checkpoints. Suppressed silent jobs finish `complete` with `suppressionReason: "silent_filing_disabled"`. |
| SF311 worker state | `SITE#<siteId>` | `SF311_LOCK#<taskId>` | Expiring worker lease plus durable integration results shared across jobs. Separate from task snapshots so foreground updates cannot erase a filing checkpoint. |
| Compliance-letter generation job | `SITE#<siteId>` | `LETTER_JOB#<createdAt>#<jobId>` | Transactional outbox item (`COMPLIANCE_LETTER_OUTBOX`) created with a perimeter-check period. DynamoDB Streams dispatches it to SQS; the worker renders the PDF, stores it in S3, and advances the Site letter state idempotently. |
| Requirement-ended notice | `SITE#<siteId>` | `LETTER_JOB#ended-<termsVersionId>` | `COMPLIANCE_LETTER_OUTBOX`, `noticeOnly: true`; created atomically with manual cancellation or scheduled expiry. Copies the period's original email To/CC snapshot. Uses the existing delivery claim/receipt safeguards without a PDF or letter-history counter. |
| System-status site directory | `STATUS_SITES` | `<siteId>` | All Sites, including inactive Sites; versioned name/status projection for supervisor-only reporting. |
| System-status activity snapshot | `STATUS#<siteId>` | `<ISO time>#<kind>#<identity>` | Submission references, check state, generated issue categories, user actions, explicit deletions, and duplicate detection references. Numeric 30-day `expiresAt`; no copied media. `SEEN#issues#<identity>` and `SEEN#duplicates#<identity>` identifier-only guards prevent replay/revision double counts. See [system-status runbook](runbooks/system-status.md). |
| Evidence deletion receipt | `SITE#<siteId>` | `EVIDENCE_DELETION#<JSON array of checkId and artifactId>` | Durable `deletedAt` marker, written atomically with artifact removal. Registration and guidance publication condition-check its absence. Cleanup supersedes only unused open tasks supported solely by the removed artifact, atomically checking the task version, filing lease, and durable filing results. Active leases or unmerged external outcomes return `EvidenceDeletionPending` while retaining the marker; retries finish interrupted cleanup. The filing worker checks the marker after claiming its lease so queued work cannot file a retracted issue. |
| Explicit issue deletion receipt | `SITE#<siteId>` | `ISSUE_DELETION#<checkId>:<artifactId>:<conditionId>` | Pending attempt journal before the analyzer call; confirmed rejection timestamp and category before task cleanup. Only records with `deletedAt` project into counts. Confirmed retries preserve the receipt; ambiguous upstream 404s remain uncounted pending reconciliation. |
| System-status initialization | `SYSTEM#STATUS` | `#META` | `ready` and `trackingSince`; set only after a complete directory/bootstrap pass. The API refuses uninitialized totals. |
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
| Oversight directory option | `ADMIN_DIRECTORY#OVERSIGHT` | `DEPARTMENT#<normalizedName>` or `SYSTEMOFCARE#<normalizedName>` | reusable supervisor-managed dropdown value with display name, type, status, and timestamps. DPH and HSH department entities are created by import when absent; unknown spellings are conflicts requiring manual resolution. |
| Site search row | `SITE_SEARCH#ACTIVE` | `<lowercased name>#<siteId>` | `label`, `searchText`. All active sites in one partition, for the public bootstrap search (AP20). |
| Setup code | `SETUP_CODE#<verifier>` | `#META` | `verifier` is an HMAC of the code the person types. The code itself is never stored. `codeId`, `status`, `expiresAt` (ISO string, 72 hours), `uses` / `maxUses` (3), `accessLevel`, `siteId`, `issuedTo`, `issuedBy`. Carries GSI6 and GSI7 keys while `pending`. |
| Current setup code pointer | `SETUP_CODE_CURRENT#<siteId>#<contactHash>` | `#META` | `currentCodePk` / `currentCodeId`: the code a contact's latest request created |
| Legacy site code | `SITE_CODE#<code>` | `#META` | `type: providerSiteCode`. Rows from before setup codes. `/site-code` still accepts them as a fallback. |
| Setup-code request throttle | `SETUP_CODE_REQUEST#<siteId>#<contactHash>` | `#THROTTLE` | `nextAllowedAt`, a cooldown for the public request route. Written with a conditional Put. |
| Manager-access request controls | `MANAGER_ACCESS_RATE#IP#<ipHash>` / `MANAGER_ACCESS_RATE#EMAIL#<emailHash>` / `MANAGER_ACCESS_COOLDOWN#<emailHash>` | `HOUR#<yyyy-mm-ddThh>` / `#REQUEST` | TTL-bound counters and cooldown marker for the non-enumerating public Manager recovery route. No raw email or IP address is stored. |
| Analytics export watermark | `ANALYTICS#EXPORT` | `#WATERMARK` | `exportToTime` (epoch seconds), `lastExportId`, `updatedAt`. The cursor for the incremental export Lambda ([ADR 0013](./adr/0013-analytics-read-plane.md)). |

Staff enrollment supports multiple concurrent, single-use grants per Manager binding. The access page polls issuer-owned grant metadata (never secrets) and removes redeemed or expired links; secret links are kept only while the page remains open. Reopening restores pending grant metadata and cancellation controls, never the secret URL, QR code, or share control. Legacy `ACTIVE_STAFF_GRANT#` markers are no longer read or written.

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

**311 state.** Tasks expose 311 app-action results as attributes with no dedicated
ticket index. Background jobs and durable integration checkpoints also live in
`SF311_JOB#` and `SF311_LOCK#` records; a task snapshot is not the only stored state.

- `appActions`: the rule's structured actions.
- `appActionResults`: one result per action that ran.
- `appActionStatus`: a rollup of the results.
- `deliberate311DeliveryMode`: `production` or `simulated`, persisted on acceptance
  together with `deliberate311AcceptedAt`. Retries keep the original mode. Async
  user-confirmed outbox jobs also store `deliveryMode`.
- Simulated ticket results contain `deliveryMode: "simulated"`, a stable `SIM-`
  `srNum`, `submittedAt`, `closesAt` (five minutes later), and `closedReason: "1"`.
  Status is derived on read rather than stored as a scheduled mutation. Provenance
  remains in raw analytics exports; City-escalation queries exclude simulations.
- Site metadata stores `deliberate311ProductionEnabled` (default `true`, including
  legacy missing values). Only explicit `false` selects simulation; silent filings
  are unaffected. Supervisor edits write a `site_deliberate_311_delivery_changed`
  audit event atomically with the flag, retaining actor and previous/new values.

- `maxAcceptableResponseHours`: the response window from the rule. Zero turns off overdue
  checks.

**In-progress tasks** also carry `inProgressAt`, `notifiedAt`, an agency snapshot,
`latestUpdateId` and `latestUpdateLabel`. Legacy presence responses may also carry
`lastAnsweredPresencePeriod`; the UI no longer prompts periodically. The permanent
resolution action appends an `issue_resolved` event with an optional documentation
window and sets `completionMethod: "site_team_resolved"`. Task-update
photos use `TASK#<taskId>#MEDIA#<artifactId>` rows with `purpose: "task_update"`,
transactionally paired with `CHECK#<checkId>#UPDATE_MEDIA#<artifactId>` pointers.
They are not ART rows and registration skips the analyzer queue. Events store
artifact IDs in `photoKeys`; the media route follows the pointer and validates the
stored Site/check S3 key before signing. HEIC/HEIF registration preserves the
original `s3Key` and writes a JPEG rendition at `<s3Key>.display.jpg`, recorded
as `displayS3Key` on the media row. The media route returns that rendition as
`downloadUrl` only when the key exactly matches the original's sibling path.
Conversion must succeed before registration; an undecodable upload returns 422
and leaves the user's documentation draft unsaved. Both objects use the uploads
bucket retention policy. The HEIC decoder is loaded lazily in the API Lambda,
not shipped to browsers.

**311 documentation and City-help choice.** Informational `note_photo_update` and
`additional_action` events on filed 311 tasks store `cityHelpNeeded`. A `false`
choice also stores an immutable `cityNotePayload` built from the authenticated
site's name and the first filed SR shown on the card. It uses HUB UpdateSR's
Add Notes contract (`UpdateType: 5`, `NumericSubType: 2`), not a closure update;
the task remains in progress until the external resolution flow completes.

The event and task are saved atomically before note delivery. `cityNoteStatus`
tracks `pending`, `sending`, `sent`, `unknown`, or terminal `suppressed`; `cityNoteLeaseExpiresAt` gives
one sender a 60-second lease. The client reuses the same idempotency key when
retrying an unchanged draft. Successful retries reuse the event and do not
resend the note. Explicit HUB validation rejections return to `pending`.
Timeouts, ambiguous responses, and expired attempts are reconciled against the
City feed using the SR, sending agency, note text, and effective time. If delivery
cannot be confirmed, the API returns `502` with `updateSaved: true`; it does not
blindly resend an uncertain note. Such records may need operational investigation
if the City feed never exposes the matching update. Sending respects
`GNP_311_SUBMISSION_ENABLED`. Suppressed silent notes are never replayed or
reported as sent. Suppression clears an owned or expired lease conditionally and
never overwrites an active sender.

`canBeInProgress` is snapshotted from the versioned guidance rule when the task is
created. The first successful card action moves eligible tasks to `in_progress`; tasks
without that flag complete directly.

`primaryInProgressAgency` is also snapshotted from the rule. When an eligible task enters
progress, it becomes the task's displayed `agency` without interpreting user-facing button
text.

Current resolution atomically writes the completed task, its `issue_resolved` event,
and any applicable 311 closure outbox job. Background closure does not delay or undo
resolution. Legacy `resolving` records and resolution leases remain readable by the
interrupted-action recovery path; they do not describe the normal new resolution flow.

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
  has `serviceCode`, `srNum`, and `status: "closed" | "failed"`, plus `updateId` on
  success or `reason` on failure. New closure requests record `closedReasonCode: "1"`.
  Reconciled closures record the observed HUB reason when available and omit
  `closedReasonCode` when HUB supplies no reason. No `externalId`. On a retry, tickets
  closed by earlier attempts are copied into `closures[]` as they were, so the latest
  result is always complete. The result status rolls up to `submitted`, `partial`, or
  `failed`. A failed closure never blocks task completion. See
  [guidance workflow](./architecture.md#guidance-workflow-rule-driven-tasks). Background
  processing checkpoints integration results in `SF311_LOCK#` and the job, then
  merges them into the latest task. Closure retries reconcile City state rather
  than assuming a lost response means the close failed.

### One query pattern reads a whole check

The header and all its children start with `CHECK#<checkId>`. So the check detail screen
uses `pk = SITE#x AND begins_with(sk, "CHECK#<checkId>")`, following every
DynamoDB page. It returns the header, artifacts, analyses, and any update-media
pointers; handlers select the relevant item shapes.

### Scorecard on the header

Decided 2026-08-14. One `CHECK#<checkId>` is one full perimeter run. There is no separate
"synthesis" item. At `complete`, the API synthesizes the check-level scorecard and transactionally
updates the header with a perimeter completion marker (single-problem reports omit
the marker):

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
| **GSI1** timelines | entity-specific partitions per site: `SITE#<siteId>`, `SITE#<siteId>#ASSESSMENT`, `SITE#<siteId>#TASK`, `SITE#<siteId>#UPDATE`, `SITE#<siteId>#COMPLAINTS`, `SITE#<siteId>#CARE_WORK` | `<startedAt ISO>` (checks) / `<reportedAt>#<assessmentId>` (assessments) / `<createdAt>#<taskId>` (tasks) / `<occurredAt>#<updateId>` (task update events) / `<createdAt>#<complaintId>` (complaints) / `<createdAt>#<workId>` (care logs) | check headers, assessment reports, tasks, task update events, submitted complaints, care logs | checks timeline (AP6, AP12), assessments timeline (AP14), site manager reports (AP27, AP28), complaints, and care-log lists. Each partition holds one entity type; the task and update partitions are stamped at creation and re-derived on every full-item re-put (`taskTimelineGsiFor`), so they sort by when things happened, not by status, a legacy task is stamped on its next transition, and a backfilled stamp survives a re-put from an older snapshot. | built |
| **GSI2** site worklist | `SITE#<siteId>#TASK#<status>` | `<worklist timestamp>#<kind>#<severity>#<taskId>` (creation initially; transitions can restamp it) | tasks | staff's open tasks, newest first. The app re-sorts each page by severity. See AP10. | built |
| **GSI3** cross-site sparse queues | one partition per entity type. Built: `COMPLIANCE_TERMS#OPEN`. Designed, not stamped: `ESCALATION#<status>` | `<expiresOnExclusive>#<siteId>#<termsVersionId>` (terms) / `<severity>#<createdAt>#<siteId>` (escalations) | each site's latest open compliance-terms version that has an end date. Stamped at creation and removed when the version ends or is superseded (`complianceTermsExpiryGsi`), so the partition holds at most one small item per site. | the scheduled expiry sweep (AP39): one query bounded by today's Pacific date instead of a table scan. The city escalation queue (AP11) would be a second sparse partition on the same index. | built 2026-10-28 (terms partition); escalation partition **deferred post-MVP** |
| **GSI6** pending codes by contact | `SETUP_CODE_PENDING#<siteId>#<contactHash>` | `<createdAt>` | `pending` setup codes only. Keys are removed on use or revoke. | cancel a contact's old code when they ask for a new one (AP21) | built |
| **GSI7** pending codes by site | `SETUP_CODE_PENDING_SITE#<siteId>` | `<createdAt>` | `pending` setup codes only | revoke every open code when a site is deactivated (AP22) | built |

GSI4 (condition history by severity) and GSI5 (unresolved conditions) were removed on
2026-10-28; nothing ever read them. Condition items written before then keep their
`gsi4*` / `gsi5*` attributes as plain attributes. New conditions carry no index keys and
are read by assessment prefix (AP15).

`GET /v1/guidance/pending` recovers unanswered questions for the authenticated
site from the existing GSI1 assessment timeline (AP14), including historical
reports. Each response examines at most 25 assessments, filters for pending or
manual-review reports, and retains the cursor even on an empty filtered page.
The client follows every page. Before returning questions, the API reads the
assessment and its conditions from the base table (AP15) with consistent reads,
excluding superseded assessments and conditions already answered. It also reads
the existing `ISSUE_DELETION#<checkId>:<artifactId>:<conditionId>` receipt
consistently and excludes confirmed deletions and app-owned dismissals. When
an expired analyzer result returns `unknown_analysis`, a verified condition in
that Site's stored analysis can be dismissed with `state=dismissed`,
`dismissedAt`, and `dismissalReason=analysis_unavailable`. This is distinct from
an analyzer-confirmed rejection (`deletedAt`) and does not count as one.
Unverified 404s remain errors. No migration
or additional index is needed. Home merges these questions with local in-flight
results and backend tasks without treating a sibling task as an answered question.
Answers use the existing condition-answer transaction and original policy version.
A pending-guidance read failure preserves live task/check reads and cached
questions, exposes a retry, and prevents local-session retirement or snapshot
replacement based on the incomplete recovery result. Expired analyzer results
cannot be edited; the UI explains that a new description can be submitted.
Analyzer retention and an independent historical-edit workflow are deferred.


## Access patterns

Interactive access uses keyed reads and queries, often several paginated reads or
conditional transactions per operation. Maintenance/backfill scripts still scan the
table; no request path or scheduled worker does. The compliance-terms expiry sweep
reads the sparse GSI3 partition instead (AP39).

| # | Pattern | Operation |
|---|---|---|
| AP1 | Get site config | `GetItem` `SITE#x` / `#META` |
| AP2 | List a Site's manager roster | Query `ASSIGNED_USER#` and `MANAGER_MEMBERSHIP#` under `SITE#x`, following pages and resolving current person/contact references as needed. |
| AP3 | Resolve caller scope | Field-device Site comes from verified claims. City administrators use Cognito roles and, for scoped mutations, active Site assignments; they do not have one implicit tenant Site. |
| AP4 | List devices | `Query` `SITE#x`, `begins_with(sk,"DEVICE#")` |
| AP5 | Create a check | conditional `PutItem` of the header with `attribute_not_exists(sk)`. Idempotent on the client-minted `checkId`. A repeat returns 200 instead of 201. This is not a transaction. Artifacts arrive one at a time (AP5a). |
| AP5a | Register one artifact | conditional `PutItem` of `…#ART#…`, then an SQS send. The two are **not atomic**. Registering the same `artifactId` again re-queues it on purpose. The worker's conditional `ANALYSIS#` write (AP8) absorbs the duplicate. |
| AP5b | Add a location that arrived after upload | `Query` the check's `ART#` prefix, `GetItem` the `GUIDANCE_CURRENT#` pointer, and read that assessment's tasks (AP15 + `BatchGetItem`). Then one `TransactWriteItems` sets the artifact's `latitude` / `longitude` / `accuracyMeters` and each unfiled task's `source` the same way, each conditioned on having no location or a less accurate one; tasks filed or queued for 311 are skipped. A row whose condition fails is dropped and the rest retried. |
| AP6 | List recent or today's checks | `Query` **GSI1** `SITE#x` (checks partition), sort-key date range, newest first |
| AP7 | Open one check with artifacts and analyses | `Query` base `SITE#x`, `begins_with(sk,"CHECK#<id>")` |
| AP8 | Worker writes an analysis | conditional `PutItem` of `…#ANALYSIS#…`. Allowed into an empty slot or over a `failed` marker. Then `UpdateItem` on the header: `ADD issueCount` and a running max of `maxSeverity`. Header `status` does not change until `complete`. |
| AP8a | Amend or reject one analyzed condition | consistent `GetItem` of `SITE#x` / `CHECK#<checkId>#ANALYSIS#<artifactId>`, then an analyzer call and guidance publication or rejected-condition task retirement. Explicit rejection also uses an `ISSUE_DELETION#` attempt/confirmation journal. An amendment alone does not retire tasks before guidance publication succeeds. Routes use `checkId` + `artifactId`, which is the item's key. The analyzer's `analysisId` is an attribute on the item. The client never supplies it. |
| AP9 | Create tasks | `TransactWrite` of the tasks |
| AP10 | Staff worklist (open tasks) | `Query` **GSI2** `SITE#x#TASK#open`, newest first. The app re-sorts each page most-severe first. The key is date-first, so severity order holds within a page only. A severity-first index is deferred. |
| AP11 | City escalation queue, all sites | `Query` **GSI3** `ESCALATION#open`. Post-MVP; the index exists (AP39) but nothing stamps the escalation partition yet. |
| AP12 | Compliance: were there N checks on date D? | `Query` **GSI1** `SITE#x` for the Pacific day's instant range and count completed perimeter headers. Served by AP27 for whole periods. |
| AP13 | Cross-site analytics | **not native**. See R2. |
| AP14 | List assessments by site and date | `Query` **GSI1** `SITE#x#ASSESSMENT` (assessments partition), sort-key date range, newest first |
| AP15 | Conditions of one assessment | `Query` base `SITE#x`, `begins_with(sk,"ASSESSMENT#<id>#COND#")` |
| AP16 | Unresolved conditions | Designed, never implemented. The GSI5 index it would have used was removed on 2026-10-28; an implementation would need a new sparse partition. |
| AP17 | Read guidance, record answers | `GetItem` the assessment and condition; `UpdateItem` on answer |
| AP18 | Read one task's update timeline | `GetItem` the task, then a bounded, cursor-paged `Query` of base `SITE#x`, `begins_with(sk,"TASK#<taskId>#UPDATE#")`, newest first. Update mutations look up the `UPDATE_ID` pointer. |
| AP19 | List a provider's sites | `Query` base `PROVIDER#<providerId>`, `begins_with(sk,"SITE#")`, cursor-paged |
| AP20 | Public site search (bootstrap) | `Query` base `SITE_SEARCH#ACTIVE` with a `contains(searchText, :q)` filter and a bounded `Limit`. One small partition, no scan. |
| AP21 | Resolve or replace a setup code | `GetItem` `SETUP_CODE#<verifier>` / `#META`, falling back to `GetItem` legacy `SITE_CODE#<code>`. On a repeat request, `Query` **GSI6** and revoke the contact's older pending code (`REMOVE gsi6pk, gsi6sk, gsi7pk, gsi7sk`). |
| AP22 | Deactivate a site | `Query` **GSI7** `SETUP_CODE_PENDING_SITE#x` and revoke open codes. Delete the `SITE_SEARCH#ACTIVE` row. Set membership and `#META` status. |
| AP23 | List a Program's contacts and Sites | `Query` base `PROGRAM#<programId>` with `USER#` or `SITE#` sort-key prefix. Program contacts are roster records only and have no authentication principal. When program creation includes `firstStaff`, its active `USER#` roster record is written in the same transaction as the program and relationship projections. Program contact details default to that staff member, with `primaryContactUserId` identifying the selected roster record. Staff edits can atomically update this pointer and its contact snapshot; selecting another staff member replaces the primary contact. Legacy snapshots without a pointer are matched to a unique active staff email for display. Site assignment happens separately through AP24. |
| AP24 | Assign a Program contact to a Site | transactionally put `SITE#x / ASSIGNED_USER#y`, increment the Program contact's assignment count, and optionally update the Site primary-contact pointer/snapshot. |
| AP25 | Read or add effective-dated terms | `Query` the Site `COMPLIANCE_TERMS#` prefix. Creation transactionally puts the version, conditionally closes the prior open version, marks the letter draft pending, and writes letter-job and audit rows. |
| AP26 | Preview/apply a Site CSV import | Query active Provider/Program/Site directories, oversight departments, Compliance-manager identities, Site children, and Provider children. Each row exact-matches or creates its Site manager, Site assignment, Site-manager membership, Site Compliance-manager assignment, and Provider-manager membership in the same conditional transaction as Provider/Program/Site changes. Repeated Site rows accumulate managers. Known DPH/HSH names create missing canonical department entities; other unknown or conflicting person/department values remain manual-review conflicts. A TTL-bound ledger and terminal row outcomes make retries idempotent. |
| AP27 | Site manager reports: checks and issues over a period | `GET /app/v1/manager/reports/checks` queries **GSI1** `SITE#x` with `gsi1sk BETWEEN` the Pacific-midnight instants of the period and of the previous period, then counts per day against the cadence in force that day: a `begins_with(sk, "COMPLIANCE_TERMS#")` read of the site partition resolves each day's `requiredChecksPerDay` from the applicable non-cancelled terms version, so a past period is not rewritten when terms change; `#META.compliance` (and the city-wide default of 3) is the rule only for a site with no terms (`backend/src/domain/check-compliance.js`). A day with fewer completed perimeter checks than required is `partial`; none is `missed`; today is `pending`. Nothing is written for a missing check: the gap is derived at read time, which is R3's answer. `…/reports/tasks` does the same over `SITE#x#TASK`. Manager access level required. |
| AP28 | Site manager reports: responses over a period | `GET /app/v1/manager/reports/task-updates` queries **GSI1** `SITE#x#UPDATE` for the period, every task's events in one range. The per-task timeline (AP18) is unchanged. Items written before the stamp exist are filled by `npm run backfill:report-timelines -w backend`. |
| AP39 | List or select this physical device's Site bindings | Query `PHYSICAL_DEVICE#<physicalDeviceId>` with `begins_with(sk,"BINDING#")`, then revalidate each canonical Site binding. Selection conditionally rotates the target binding's session and writes a Site audit event. |
| AP40 | Manager enrolls and manages general devices | Strongly range-query every page of the last hour of `STAFF_GRANT#` rows, counting all statuses against 100 grants per Manager and 200 per Site. Read the Site issuance version before that query and conditionally advance it with the grant transaction; retry conflicts with a fresh count. Query `DEVICE_BINDING#` rows filtered to `general`. Redemption marks the token lookup redeemed atomically; cancellation removes the lookup. Individual revocation conditionally updates the canonical binding, compatibility Device row, and physical-device pointer in one transaction. |
| AP29 | Recover Site Manager access by email | Apply per-IP, per-email, and cooldown controls, then query `MANAGER_EMAIL#<emailHash>`. Revalidate every canonical Site and membership and issue one 15-minute, single-use link per active Site membership. The public response is generic whether the address is known, unknown, throttled, or delivery fails. |
| AP30 | City revokes one Site binding | Consistently read `SITE#x / DEVICE_BINDING#y`, then transactionally mark the canonical binding, compatibility Device row, and physical-device pointer revoked with the same incremented generation and append a Site audit event. Pre-binding dev devices retain a bounded legacy fallback until migration is complete. |
| AP31 | City revokes selected Site bindings | Consistently read up to 20 canonical bindings, then use one all-or-nothing transaction to revoke every canonical/compatibility/pointer projection and write the completed operation plus audit event. Already-revoked selections are reported without changing generations. |
| AP32 | City revokes every device at one Site | Require exact typed Site-name confirmation, atomically advance `siteCredentialGeneration` with an applying operation/audit record, then reconcile canonical and bounded legacy rows. The generation change invalidates canonical Site credentials before display reconciliation; the operation finishes `complete` or `partial` with counts. |
| AP33 | Remove one Site Manager membership | Query current Manager bindings at the Site, then atomically deactivate/advance the membership generation, remove both email-directory pointers, revoke up to 30 matching canonical/compatibility/physical-pointer projections, and append an audit event with the impact count. Other Site memberships are unaffected. |
| AP34 | Revoke one physical device everywhere | Query the physical device's binding pointers, then consistently revalidate each active canonical binding and resolve its Site name. Require exact typed device-label confirmation and atomically revoke the physical record plus up to 20 canonical/compatibility/pointer projections, append one audit event per affected Site, and store one physical-device operation result. |
| AP35 | Emergency revoke across Sites | Preview 2–20 active Sites and every current canonical or bounded-legacy binding. Require the exact generated phrase, then use one transaction to advance every selected Site generation and create the operation, audit, and outbox records. A filtered DynamoDB Stream dispatches one SQS reconciliation job per Site. Device writes are idempotent so transient failures retry; each successful worker result updates its Site operation and the aggregate operation to complete. |
| AP36 | Suspend one Site binding | Consistently read the canonical binding, then atomically advance its token generation and mark the canonical, compatibility, and physical-pointer projections suspended with a bounded reason plus a Site audit event. A bounded legacy fallback updates the legacy Device row. Re-enrollment consumes a new single-Site grant and creates a new binding; it never reactivates the suspended row. |
| AP37 | Manage oversight dropdown directories | Query the bounded `ADMIN_DIRECTORY#OVERSIGHT` partition. Supervisors conditionally create normalized department/system rows. Compliance-manager identities live in `ADMIN_DIRECTORY#PROGRAM_MANAGERS` in every environment so CSV imports can precede Cognito provisioning and later link by normalized email. |
| AP38 | Manage and enroll Provider Managers | A Compliance Supervisor queries `PROVIDER_MANAGER#`, `PROVIDER_MANAGER_GRANT#`, and `PROVIDER_MANAGER_ENROLLMENT#` rows in one Provider partition. Grant issuance rejects more than 21 active `SITE#` relationships. Redemption re-queries active Sites and uses one transaction to consume the link, recheck Provider/membership/Site authority, and create every canonical, compatibility, and physical-pointer projection. Authorization and refresh recheck both the membership generation and each Site's current `providerId`. |
| AP39 | Scheduled compliance-terms expiry | Every 15 minutes the worker queries **GSI3** `COMPLIANCE_TERMS#OPEN` with `gsi3sk < <tomorrow's Pacific day key>`, consistently re-reads each Site's `#META`, and closes only the version that is still the Site's latest (the same transaction as a manual end; see [Perimeter requirement notifications](#perimeter-requirement-notifications)). Versions without an end date are never in the index; closed and superseded versions leave it, so the query is bounded by the number of Sites, not by table size. |

The manager Checks UI uses recorded counts rather than compliance status: 3+,
1–2, or zero completed check records per day (including single-issue reports).
AP27 retains its compliance fields for other consumers and adds compact per-check
rows (`checkId`, `startedAt`, `photoCount`) for the day cards. Raw headers stay
server-side. Issues use the task report's non-superseded tasks. “Issues resolved”
requires `status = completed` and both creation and completion timestamps inside
the selected Pacific period; calls and 311 filings do not count as resolution.
The summary links retain the period and the resolved filter. Report
issue cards open the shared timeline in read-only mode. No operating-day schedule
is currently stored, so absence of a compliance obligation alone does not label
a day “not operating.”

The Issues chart partitions reports created in the period into resolved within
that period and unresolved within that period. Median resolution time uses only
qualifying completed reports, from creation to completion (missing or invalid
durations are excluded). Overview and type metrics filter their full read-only issue-card lists while
keeping the chart and summary totals scoped to the entire selected period.
CSV exports the active list filter (and selected type on the type screen). Current-period trends compare elapsed
Pacific calendar days, including today, with the same number of prior-period
days, capped at that period's end. Completed periods compare full periods.
A zero prior count is described without a percentage. Bar charts have integer
y-axis scales: issue counts for Issues and recorded check totals per Sunday-start
week for the Checks quarter chart. Partial boundary weeks include only checks
inside the selected quarter. Bars start at zero, the current week is darker blue,
and zero-check weeks have no bar. Day-count color bands remain on the calendars.

AP27 task reports include `asOf`: now for current periods, or the last instant
of a completed period. Attention counts cover only reports created in the
selected period. Aging means strictly more than 72 hours unresolved at `asOf`.
Notes and photos alone are not actions: dated action/status events and task
action timestamps determine whether any action occurred by the cutoff. Awaiting
City response means a submitted 311 ticket not closed at the cutoff, using the
City's dated ticket events; updates alone do not close a ticket. Unavailable
statuses or undated historical closures must not be represented as confirmed
open tickets. Attention groups can overlap and are not additive.

### Who owns a task

Decided 2026-08-12. App code in this repo decides who owns each task, not the analyzer.
After the analysis returns, the app derives conditions, creates tasks, marks each as
`onsite` or `city_escalation`, assigns them, and writes them in one batch (AP9). The owner
is set before anyone sees the task.

The original evaluated `ruleId` and `policyVersion` are retained. An authorized
action override can replace executable fields, including `kind` and `type`, while
recording `actionOverride`. `type` itself has no dedicated index.

- **In MVP:** the classification logic and the per-site worklist (GSI2, AP10).
- **Built:** 311 integration and its task-linked outbox/worker checkpoints, gated by
  environment configuration.
- **Deferred:** the cross-site city queue (AP11). GSI3 itself is provisioned for the
  expiry sweep; nothing stamps the escalation partition yet.

## Scale

- 400 sites × 3 checks a day = **1,200 checks a day**, about 438k a year. Trivial for
  DynamoDB.
- Each site's partition grows by about 1,095 checks a year. It will take **years** to get
  large. TTL is enabled on numeric epoch-seconds `expiresAt` values. It does not expire
  ordinary check/task history without that numeric attribute, and legacy ISO-string
  expiries still require application checks (see fact 4 above).
- Writes are spread across 400 sites. There is **no hot partition**.
- Capacity is on-demand, pay per request. It scales to zero. Nothing to size.

## Idempotency and the existing code

The client makes a UUID `checkId` and sends it as the `idempotency-key` header.
`createCheck` writes the header with `attribute_not_exists(sk)`. A repeated request
cannot create a duplicate. That is what lets the app's offline check queue
(`services/check-submissions.js`) resend checks finished with no connection. AI
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
`infra/modules/app/main.tf`). Two stream mappings are defined: the shared outbox/System Status consumer
(`lambda.tf`, `revocation_outbox`) and the feature-gated duplicate dispatcher
(`duplicates.tf`, `duplicate_analysis_stream`). The first handles revocation,
compliance-letter and 311 outboxes as well as Site reporting projections. A future
aggregator must account for both mappings and their enabled state.

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
| `analytics-report` | EventBridge `cron(0 14 * * ? *)`, 14:00 UTC (06:00 Pacific standard time, 07:00 Pacific daylight time) | builds the daily citywide report |

ADR 0013 replaced the Glue and Athena tooling we first sketched. Athena could still be
added over the same Parquet later. We also considered a streaming Firehose-to-Parquet
build (T2b) and **rejected** it. Near-real-time feeds are more than leadership reporting
needs. The 6-hour export is the design.

### Infrastructure

All of it is Terraform. Nothing is set up by hand.

- **Built:** DynamoDB Streams on the table (shared outbox/System Status mapping and a feature-gated duplicate mapping), the S3 analytics lake bucket
  (KMS, lifecycle rules), the four Lambdas, and the two EventBridge schedules above.
- **Not built:** the Tier-1 Streams aggregator and the `#STATS#` counter items. No
  Firehose (see T2b above). The admin Analytics page already renders query results; System Status uses its
  separate operational projections, not the lake or the proposed Tier-1 counters.

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
- **Lake regularity uses a fixed three-check threshold.** It lives as the literal
  `>= 3` in the analytics SQL. This is not the Site-specific compliance calculation:
  manager reports use effective-dated terms and Pacific days (AP27), with a default
  of three only when cadence is unconfigured. The lake query uses UTC dates. There is **no grace period** for device outages. The duty is per day, so
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
| **R1** | The city needs a **cross-site** view, which breaks per-site partitioning | Deferred post-MVP | A sparse `ESCALATION#<status>` partition on GSI3 (the index already built for the expiry sweep) would collect `city_escalation` tasks across sites. Toxic escalations are rare, so the `ESCALATION#open` partition stays small. Shard the key later only if volume demands it. |
| **R2** | **Cross-site analytics** for city-wide reports. See [City-wide reporting](#city-wide-reporting-and-analytics). | Tier 2 built; Tier 1 deferred post-MVP | The Tier 2 lake (S3 export → Parquet → DuckDB, [ADR 0013](./adr/0013-analytics-read-plane.md)) serves the admin analytics routes today. Tier 1 live counters (Streams → counter items) are design only. Cheap at this volume. |
| **R3** | Detecting a **missing** check (a site did fewer than N today). You cannot query for something that was never written. | Per site: built (AP27). Cross-site: not built | Per site, the manager reports derive the gap at read time: one GSI1 range query per period, counted per Pacific day against the site's own `requiredChecksPerDay`. A cross-site sweep (EventBridge over the site registry) is still the design for city-wide alerting; the daily Tier 2 lake report answers it after the fact today, in UTC days. |
| **R4** | Photos/audio exceed the **400 KB item limit** | Handled by design | Check/task blobs go to the S3 uploads bucket and complaint evidence goes to its dedicated S3 bucket. Items store the S3 key and use presigned URLs. Never store media in the item. |
| **R5** | Tenant isolation must be **airtight** across 400 tenants | **Runtime authorization and negative tests enforced; shared-role IAM cannot express caller-dynamic scoping.** | Every protected route authenticates, derives `siteId` from the verified principal, and builds partition keys server-side. Media also uses exact server-owned keys and refuses to sign a stored pointer outside that Site/check. A `LeadingKeys = SITE#${custom:siteId}` condition cannot be applied to the shared API Lambda execution role: DynamoDB sees the Lambda role, not the JWT/device principal, and central-admin operations intentionally access global partitions. A future platform backstop requires a separate tenant-only data-plane function/role or per-request tagged-role assumption; do not add a misleading `SITE#*` condition. |
| **R6** | Anonymous staff, so **no per-person attribution** | By design | Attribution is site + device. If per-person is ever needed, add a device-local PIN or roster. Not required now. |
| **R7** | Each task status change rewrites its GSI2 entry | Normal | Expected DynamoDB behavior. Volume is tiny. |

R1 (the GSI3 escalation partition) and the rest of R2 are post-MVP and tracked on the issue tracker. The others are
routine.

## Settled questions

1. **City cross-site queue.** Deferred post-MVP. It would be a second sparse partition
   on GSI3, added with no rebuild. The 311 integrations exist independently of that
   deferred queue view.
2. **Retention.** A bucket-wide rule expires every check/task photo 30 days after upload.
   Complaint evidence lives in a separate bucket with a bucket-wide one-year rule. In
   either bucket, upload-state tags only shorten retention: never-registered (pending)
   and rejected media expire after one day. Bucket versioning is suspended, so expiry
   removes the bytes outright.
3. **Analytics scope and metrics.** The Tier 2 S3-export lake is built
   ([ADR 0013](./adr/0013-analytics-read-plane.md)). Tier 1 live KPIs are post-MVP. Metric
   definitions are settled (see above).
4. **Single application table.** Confirmed; tenant isolation is enforced by current
   authorization and server-built keys, not caller-specific IAM on the shared role. The non-tenant item
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

### Duplicate issue records (feature-gated)

The Site records below use the authenticated `pk=SITE#<siteId>` partition. No new GSI or
media bytes are stored in these records. Issue identity is
`(checkId, artifactId, conditionId, analysisRevision)`; readable short IDs are
resolved from current guidance/tasks rather than treated as identity.

| Sort-key prefix | Meaning |
| --- | --- |
| `DUP_OBSERVATION#<generatedAt>#<checkId>:<artifactId>` | Current revision, condition/category descriptions, immutable media reference and optional derived hashes. Generation time, not capture time, indexes the 72-hour lookup. |
| `DUP_COVERAGE` | Earliest completely indexed generation time for this Site. |
| `DUP_RESULT#<observationId>#<revision>` | Pending/final evaluation, per-condition results, safe timing diagnostics and target revisions. |
| `DUP_PEER_RECONCILIATION#<observationId>#<revision>` | Peer fanout claim (`owner`, `leaseUntil` in epoch milliseconds) and durable completion checkpoint (`completedAt`). `lastPeerKey` records successful sends in ascending observation-projection key order. Each acknowledged send checkpoints progress and renews the 60-second lease; retries resume after that key. Conditional writes fence acquisition/progress/completion/release by owner and cursor; expired claims are retryable. Completion suppresses future job fanout, while dependent-link reconciliation still runs after recovery. |
| `DUP_ISSUE#<observationId>#<revision>#<conditionId>` | Incrementally published high-confidence explicit link with revision/lifecycle validation keys. |
| `DUP_COMPARISON#<requestDigest>` | Comparison response cache, including matcher/request version; five-day TTL and no image bytes. |
| `DUP_LINK#<taskId>` | Idempotently materialized original-task link and its duplicate-detection timeline event ID. |
| `DUP_OVERRIDE#<JSON check/artifact/condition tuple>` | Durable human separation, actor/time and original-task reference; prevents automatic relinking of that observation. |

The internal request-pacing record uses `pk=DUP_COMPARISON_PACER` and
`sk=sha256(normalized comparison endpoint URL)`, shared across Sites and workers
in one application table. Conditional updates of `nextAllowedAt` (epoch milliseconds)
pace every HTTP attempt, including 429 retries. A unique `owner` and millisecond
`leaseUntil` protect each HTTP start; the owner sets the next cooldown after starting
the fetch and conditionally releases the lease. Expired or nearly expired lease
acknowledgements must reacquire. Numeric `expiresAt` is a one-day housekeeping TTL;
TTL deletion is never needed to grant a permit. It contains
no credentials, media, issue IDs or narratives and is not part of Site APIs.

Duplicate detections and separations use existing `TASK#…#UPDATE#…` timeline keys
with `duplicate_detected` / `duplicate_separated` types. UI copy comes from the
translation catalogs. Raw observations and prior action records are retained.
If separation follows an action performed before matching, a fresh open task
identity supersedes the old task under the same condition/short ID. The original
retains the group's action; new external-action idempotency is scoped to the new
task identity. Conditional transactions guard revisions, membership and action
leases. Existing groups remain effective when new detection is disabled.

## Proactive care work records

These records do not reference a Check, Assessment, Condition, or Task. All keys
are derived from the authenticated Site, and general and manager devices share
the same create/read access. There are no mutation routes after submission.

| Item | PK | SK | Attributes / lifetime |
|---|---|---|---|
| Work log | `SITE#<siteId>` | `CARE_WORK#<workId>` | `type: careWork`, `kind`, `note`, `createdAt`, `createdBy`, payload `fingerprint`, `photos` containing IDs, server-owned S3 keys and photo expiry; `expiresAt` is submission + 365 days. |
| Upload reservation | `SITE#<siteId>` | `CARE_UPLOAD#<workId>#<photoId>` | `type: careUpload`, creator, declared type/bytes, creation time and one-day TTL. Used only to authorize submission. |
| Per-log upload budget | `SITE#<siteId>` | `CARE_QUOTA#<workId>` | Live reservation IDs with byte counts and expiry timestamps, optimistic revision, and one-day TTL. Expired slots are reclaimed before asynchronous TTL deletion; device daily media budgets remain charged and are shared with existing uploads. |

Work logs project `gsi1pk = SITE#<siteId>#CARE_WORK` and
`gsi1sk = <createdAt>#<workId>` onto GSI1. `GET /v1/care-work` returns newest-first
pages of at most 50 evaluated rows, filtering expired headers. Cursor validation
prevents crossing Site partitions. `GET /v1/care-work/{workId}` consistently reads
the header and rejects expired records before DynamoDB's asynchronous TTL cleanup.

`POST /v1/care-work` conditionally puts one immutable header, with transaction
conditions on each supplied upload reservation. Replays with the same UUID and
payload/actor fingerprint return the saved result; different payloads conflict.
The seven fixed kinds are `power_washed`, `called_hauler`, `cleaned_graffiti`,
`offered_help`, `referred_non_client`, `called_shelter`, and
`addressed_client_issue`; `other` requires a nonblank `note`. Display labels are
localized in the frontend. Notes are limited to 4,000 characters.

Photo metadata remains with the log for a year, but photo bytes use the uploads
bucket's existing 30-day retention. The photo signing route verifies both the
Site-specific key and photo expiry, never signs arbitrary stored pointers, and
caps the URL lifetime at the expiry boundary. These records do not affect manager
reports or check-compliance counts.


### Multiple Site managers and primary contact

A Site may have multiple active managers. New linked `MANAGER_MEMBERSHIP#` writes
create the corresponding `ASSIGNED_USER#` projection and update the staff assignment
count in the same transaction. `MANAGER_USER#<userId>` enforces one new linked membership
per person per Site. Removing a membership removes only that person's projection,
updates their count, and invalidates only bindings belonging to that membership.
Other managers, their pending enrollment links, and their bindings are retained.

The Site's `primaryContactUserId` and `primaryContact` snapshot are derived from the
oldest active site-manager assignment (by `createdAt`, preserving the current primary
on equal timestamps and otherwise using a stable identity tie-break).
There is no independent primary-contact selector. Assignment and membership writes
recalculate the contact atomically; removing the primary promotes the next oldest,
and removing the last manager clears both fields. Older imported assignments resolve
contact details from their program staff record. Standalone memberships can supply a
contact snapshot without a staff pointer. A `managerRosterRevision` compare-and-set
on site metadata prevents concurrent roster writes from choosing inconsistent primaries.
Changing the derived contact does not itself grant or revoke app access.

Admin views combine older assignment-only records with active memberships, deduplicate
by staff identity (or legacy email), and show all managers. Enrollment of an older
assignment creates its missing membership without replacing other managers. Letter
creation accepts either an active assignment projection or an active membership
for active staff in the Site's lead Program; the selected letter recipient remains
an immutable snapshot. Linked enrollment emails use the current staff email address.

### Staff contact removal consistency

Program metadata carries an opaque `staffContactRevision` for program contact changes
and staff removal. Site manager deletion marks staff `removing` before access cleanup;
new assignments require active staff. Cleanup recalculates each affected site's primary
contact in the same transaction that removes its assignment. The site roster revision
prevents concurrent cleanup or assignment from overwriting a newer contact selection.
Program primary contacts are cleared when their manager record is deleted. Ordinary
non-manager staff deactivation still requires reassignment of dependent contacts.

The site detail endpoint supports `?roster=1` for staff assignment enrichment. This returns
canonical site metadata plus fully paginated `ASSIGNED_USER#` and `MANAGER_MEMBERSHIP#`
prefixes, without reading historical reports, audits, or compliance artifacts.

### Reusing staff when creating a program

Program creation accepts either `firstStaff` (first name, last name, email, and
optional phone) or `existingStaff`: `{programId, userId}` for another program
under the same provider, or `{providerManagerId}` for that provider’s staff.
The server reads the active source and verifies provider ownership; transaction
conditions protect against source deactivation, edits, or program reassignment.

Selection creates an additional `PROGRAM#… / USER#…` contact with its own
program-scoped identifier and a `staffSource` reference to the original record.
Contact details are copied at creation. Once linked to a canonical person, later
profile edits update that person and its registered projections transactionally;
legacy unlinked contacts retain the compatibility edit path. See ADR 0017 and the
people-migration runbook.
The original program/provider affiliation and its device access are unchanged.
This operation does not move a staff record or grant new device access.

### Phone extensions in administrator profiles

Phone extensions are stored separately as `phoneExtension`, preserving leading zeroes.
Compliance managers use their existing directory record. Supervisors without a manager
directory record use `ADMIN_PROFILE#<cognitoSubject>` / `#META`; this profile metadata
is not a manager assignment. Profile writes use the existing profile mutation lock and
recovery journal. Site public contacts and derived primary contacts also retain the
extension separately from the phone number.

## 311 media bearer leases

`SF311_MEDIA_LEASE` items use `pk=SF311_MEDIA#<SHA-256 token hash>` and
`sk=LEASE`. Attributes are `s3Key` (a fresh `sf311-media/` image snapshot),
`sourceS3Key` (the original upload, for incident revocation), and `expiresAt` (epoch
seconds, issuance plus 172800 seconds). There are no GSI keys or raw tokens.
The 311 attachment writer conditionally puts each lease; the anonymous media
handler performs a strongly consistent Get by token hash and rejects expired
leases independently of asynchronous TTL cleanup. This access path is shared by
silent and manual filings. See [311 attachment image leases](architecture.md#311-attachment-image-leases).

### Enhanced-monitoring conversion

Before deploying readers of the enhanced-monitoring flag to a table with legacy
site tiers, run backend/scripts/migrate-enhanced-monitoring.mjs in dry-run mode.
It converts site compliance and compliance-period snapshots without changing
issued PDFs or stored letter inputs. Explicit boolean values are preserved.

Local command: node --env-file=.env.local backend/scripts/migrate-enhanced-monitoring.mjs
(add --apply to write).

Deployed table: use authorized AWS credentials and
node backend/scripts/migrate-enhanced-monitoring.mjs --remote --table=TABLE --region=REGION.
After reviewing the target and candidate count, add --apply --confirm-table=TABLE
to write. Remote mode ignores configured emulator endpoints. There is no automatic
deployment migration. Conditional checks prevent overwriting concurrent changes;
conflicts produce a nonzero exit status and should be reviewed before rerunning.

### Perimeter requirement notifications

New requirement emails address the selected Site manager in To and CC the other
active Site managers, all active Provider managers, and the authenticated generator.
Addresses are deduplicated case-insensitively and saved on the terms version so
resends and ending notices retain the original recipients.

Manual cancellation and scheduled expiry atomically archive the current letter,
clear the active Site projection, audit the ending, and create a deterministic
notice outbox row. An EventBridge rule invokes the background worker every 15
minutes; the local worker sweeps once a minute. The sweep queries the sparse GSI3
partition of open, end-dated versions (AP39), uses Pacific dates, and only closes a
Site's latest terms version, never an older superseded version.
Legacy terms without an email snapshot can still end but cannot notify original
recipients. End notices use the same transport claim and receipt handling as
letters: proven non-submission can retry; ambiguous sends require reconciliation.
Local deliveries are captured under `/tmp/good-neighbor-letter-emails`.

### Independent people and affiliations

See [ADR 0017](adr/0017-independent-people-and-site-affiliations.md) for the current
relationship model and migration. `PEOPLE / PERSON#<personId>` stores canonical contact
fields, optional independent primary provider/program IDs, source references, and an
optimistic revision. `PERSON#<personId> / AUDIT#...` records profile changes. Existing
program staff, provider manager, site membership, and roster projections may carry
`personId`; their original keys and access generations remain stable.

A direct site membership can reference a person without a `programId`/`userId` pair.
`SITE#<siteId> / MANAGER_PERSON#<personId>` prevents duplicate new direct assignments.
Program selection no longer requires the site's provider to own that program.
`providerAccessGeneration` on Site metadata and its provider-site projection advances
only on a provider change; provider-derived bindings snapshot it and authorization,
refresh, and discovery compare it with the canonical Site value (missing means zero).

### Analytics classification and deletion limits

`backend/src/analytics/entity-keys.js` defines the reporting allowlist by complete
partition and sort-key shape. Task/check headers must have bare `TASK#<id>` or
`CHECK#<id>` keys. Update events, update-ID pointers, task media, check update-media
pointers and unknown children are excluded. Current ART keys and legacy ART keys
with a place segment remain supported. Assessment/condition and device shapes are
also matched explicitly; identifiers need not be UUIDs.

Both export conversion and lake views use this contract. View filters exclude
misclassified children in older Parquet files, while latest-wins deduplication
still uses the full `pk, sk`. Filtering does not rewrite or remove those files;
physical cleanup requires a separate assessment. Re-conversion alone does not
remove an old file when its partition has no accepted rows left to replace it.

DynamoDB incremental exports include deletions as keys without a `NewImage`, even
with `NEW_IMAGE_ONLY` ([AWS export format](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/S3DataExport.Output.html)).
The current parser skips those records. ART rows can be hard-deleted by the
artifact route, so previously exported artifacts can remain visible in the lake.
Latest-wins deduplication does not remove a key absent from a later export.
Deletion propagation is deferred and is not part of the classification fix.
ADR 0013 records the earlier assumption that reporting entities were not deleted;
that assumption no longer holds for artifacts. Raw exports and Parquet are
analytics copies, not media backups.

### Resolution proof

Explicitly completed tasks (including actions that cannot stay in progress) move
straight to History. `proofAddedAt` is null until a site user saves a nonempty note
or registered photo through a `resolution_proof` task update. This transaction
appends the attributed timeline event and stamps the task, preserving its original
completion time/status and avoiding another City closure job. Site authorization
still applies; the proof author need not be the session that completed the task.
Concurrent saves use the task snapshot condition and idempotency pointer, so only
one proof submission wins and retries cannot add duplicate events.

For legacy completed tasks without the summary field, worklist/detail reads inspect
the latest completion event's notes/photos. Earlier progress evidence and an empty
closed documentation window do not count. Expiry alone never requires proof.
The History badge, Add proof button, and orange ticker use this shared summary.

### Artifact analysis recovery fields

New `ART` records include `analysisGeneration` (initially the artifact ID),
`analysisStatus` (`queued`, `running`, `succeeded`, `exhausted`, or
`permanent_failure`), and a temporary `analysisLeaseUntil` epoch-millisecond
value while running. Terminal `ANALYSIS` records carry the matching generation;
failed analyses include `retryable`, true only for exhausted transient work.
Artifact status and analysis publication are one transaction. Restart changes
the generation only if the expected generation is exhausted; the request's
stable retry identity becomes the new generation. Reads and completion ignore
analyses from a prior generation. Records without these fields retain legacy
behavior; a legacy exhaustion marker can be adopted into the new protocol only
after its failed/retryable state is verified transactionally.
