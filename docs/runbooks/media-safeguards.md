# Media safeguards runbook

Captured photos are private, KMS-encrypted S3 objects. Clients receive five-minute,
single-key PUT URLs; registration verifies the object's type, exact byte count, and signed
declared-size metadata. Analyzer input is independently decoded and re-encoded as JPEG, which
strips metadata and applies orientation while enforcing byte, pixel, edge, and single-page limits.

## Limits

- one object: 10 MiB
- one check: 20 artifacts and 50 MiB
- one site/actor pair per UTC day: 200 reservations and 512 MiB

Reservations are deliberately conservative: issuing a PUT URL consumes quota even if the client
abandons the upload. Rejection, deletion, and expiry do not refund that charge. Check/device
counters retain their existing 24-hour TTL; application quota keys use the UTC day.

Checks and complaints accept an optional `uploadRequestId`. Its mapping is committed atomically
with the quota charge and binds the actor, parent submission, server-generated artifact/key,
content type, and byte count. Identical retries reuse that reservation; different metadata or
actors cannot reuse it. Renewed URLs keep the same key and no-overwrite constraint, and expire
within five minutes or at the original 24-hour renewal deadline, whichever is earlier. Mappings retain an
extra day of TTL for explicit expired-request rejection. DynamoDB TTL deletion is not an expiry
check. Expired recovery uses a new request ID and object key and consumes today's quota.
Older clients omitting the ID retain their previous behavior.

The client saves request IDs in IndexedDB before presigning, scoped to the current site/device,
submission, attachment identity, and a SHA-256 fingerprint of the file bytes and effective
content type. Lost responses keep the same identity; an explicit server `upload_expired`
response rotates it. Metadata older than two days is pruned during subsequent reservation lookups and sign-out clears it. Signed URLs and media
are not stored in these records. Check queues retain their existing recovery behavior; complaint
and task-update selections do not gain an offline submission queue. Retrying the same
attachment reuses its request ID; selecting another attachment creates a
separate identity even when its bytes match. Check photos use their durable evidence-item ID.
Complaint entries and task-update File objects retain attachment identity for the lifetime of
their in-memory draft; these drafts do not survive reload. Care-work keeps its existing
per-photo reservation reuse.

A PUT retry may return 412 because the original object exists. Clients then continue to
registration, whose metadata validation remains mandatory. Never manually lower counters
during an incident: outstanding write-capable URLs can race such a change.

There is no Site-wide or global daily upload quota. Upload reservations do not
update shared Site or global counters: these counters made independent checks
compete for the same DynamoDB item and could reject valid uploads. Per-file,
check/complaint/care-work, and device safeguards remain enforced. Existing Site
and global counter rows are unused and expire through their existing DynamoDB
TTL; no counter deletion or migration is required. There is no aggregate daily
ceiling across devices at a Site.

## Alarms

The `media-rejected` alarm fires after five rejections in five minutes, on any upload path:
care work, complaints, perimeter checks, thumbnails, duplicate detection, and 311. It adds two
counts: `ImageRejected` (each time the shared downscale step refuses an image) and `MediaTooLarge`
(perimeter-check uploads over the byte limit, which are rejected before downscale). It counts
rejections, not files: a file downscaled more than once, such as a complaint photo tried for both
its thumbnail and analysis, counts each time. A single rejection is normally bad camera/upload data. A concentrated burst from one Site
or device may indicate abuse or a broken client release. Never fetch or copy private media into
tickets or chat.

To find the source, check the two log markers:

- `MediaRejected` (perimeter-check worker only) carries the safe IDs: `siteId`, `checkId`,
  `artifactId`, and `reason`. Use it when the burst is on perimeter checks.
- `ImageRejected` (every Lambda that runs downscale) carries `reason`, `stage` (`signature`: the
  leading bytes are not an accepted JPEG/PNG/WebP, or the file is HEIC/HEIF, so sharp never parsed
  it; `decode`:
  sharp rejected it), `declaredType`, `signature`, `brand` (the container brand for HEIC-family
  files), and the byte size. It has no Site or upload IDs, so narrow it down by the Lambda log group
  and the time window. Find entries with CloudWatch Logs Insights:
  `filter marker = "ImageRejected" | stats count() by stage, reason, declaredType, brand`.

HEIC/HEIF photos are always rejected by downscale at the `signature` stage. The libvips bundled
with sharp has no HEVC decoder, so it cannot decode a real HEIC photo, and the only HEIF it can
decode is AVIF, which an uploader can disguise as HEIC. A steady stream of `declaredType:
"image/heic"` rejections therefore means users are uploading HEIC photos on a path that needs them
converted first, not an attack.

`MediaQuotaExceeded` alarms after five rejected reservations in five minutes. Determine which
check or device counter is near its conditional limit from the Site's
`MEDIA_QUOTA#` rows. Check upload transaction conflicts use `MediaReservationConflict` and HTTP 409 rather than
being reported as exhausted quota. Inspect cancellation reasons; failures without explicit quota
conditions also return a conflict rather than inventing an exhaustion diagnosis.
Confirm whether traffic is expected before changing a limit in code. The public response
intentionally does not reveal which budget was exhausted.

For either alarm, correlate request IDs and deployment time, verify the alarm returns to OK, and
record the diagnosis without codes, tokens, email addresses, or media content.

## Retention and recovery

The uploads bucket has an unconditional 30-day expiry for current objects. Pending and
rejected tags shorten this to one day; active photos retain the 30-day window. Legacy
noncurrent versions expire after seven days (one day for pending/rejected objects).
Lifecycle deletion is asynchronous and is not an immediate-delete mechanism.

The analyze worker stores a card thumbnail beside every check photo it analyzes
(`<key>.thumb.webp`, ≤480 px WebP, tagged active; `backend/src/media/thumbnail.js`). It
sits under the same `checks/<site>/<check>/` prefix, so the 30-day expiry and the media
route's tenant check cover it without separate rules. A missing thumbnail is never an
error: `presignMedia` returns only the original and cards use that.

Task-update photo registrations emit durable DynamoDB stream inserts. The
existing stream dispatcher queues `update_media_thumbnail` jobs on the background queue;
the worker reads the current media row, creates the thumbnail and records its key.
Duplicate deliveries skip rows that already have thumbnails. Transient failures
retry through SQS and its existing dead-letter queue; expired originals and
undecodable images are acknowledged. Registration does not wait for image work.
Until a thumbnail exists, the timeline serves the original. Photos missing
thumbnails can be filled in with
`npm run backfill:thumbnails -w backend` (dry run by default, `--apply` to write,
`--site <id>` to scope; needs `DYNAMO_TABLE` and `S3_UPLOAD_BUCKET`). A backfilled
thumbnail gets its own 30-day clock, so the script skips photos older than 25 days
rather than create a thumbnail that would outlive its original.

Card and history photos renew their signed URLs before the one-hour expiry (capped
to the photo's remaining 30-day retention; upload URLs stay at five minutes).
Hidden/offscreen photos wait until visible to renew. Concurrent requests for the
same artifact share one signer request. Transient signing failures back off and stop after three consecutive failed
attempts; returning to the view can retry again. An image-load failure gets one fresh signing attempt, then falls
back from the thumbnail to the original. Missing originals show a gray
image-slash placeholder with an accessible “Image unavailable” label, not a
broken image or a working lightbox button. Missing-media results are cached for
one minute to prevent repeated requests on rerender. Old history metadata may
remain after S3's 30-day photo expiry; refreshing a URL cannot restore that photo.

Proactive care photos share this bucket under the isolated `care-work/` prefix. Their
source uploads retain the one-day pending tag; validated, EXIF-stripped JPEGs use the
active tag. The API refuses photo access after 30 days even if lifecycle deletion has
not yet run. Their underlying work logs retain text and photo-expiry metadata for one
year. Care-work processing never enqueues analyzer jobs or retags check/task images.
Complaint evidence remains in its separate one-year bucket.

Database PITR does not restore S3 media. Upload/complaint bucket versioning is
intentionally suspended to avoid retaining sensitive media beyond its approved
expiry. A recovered database may reference expired or deleted images; keep the
existing unavailable-media behavior and never extend retention as a recovery
shortcut. See [recovery.md](recovery.md) for the database restore procedure.

## Media access cookies

Check photos are read through the app distribution as plain `/checks/<site>/<check>/<key>`
paths (the object key; the SPA's own route is the singular `/check`) behind a CloudFront signed cookie (`infra/modules/app/media.tf`;
`notes/media-signed-cookies-plan.md`). The api Lambda mints the cookie for the caller's site
prefix with a one-hour lifetime and renews it on every token refresh. The S3 presigned media
route remains for the admin app, care-work and complaint media, 311 attachments and the local
harness.

The whole feature is gated on the `media_signing_public_key_pem` variable of each environment
root. While it is empty (the default) Terraform creates only the private-key secret container
and nothing else changes; the api Lambda sees no `MEDIA_KEY_PAIR_ID` and does not advertise
media cookies.

### Enabling an environment

1. Deploy once with the variable empty so `aws_secretsmanager_secret.media_signing_key`
   exists (`<prefix>-media-signing-key`, for example `gnp-dev-media-signing-key`).
2. Generate the key pair on a workstation, never in CI and never in the repo:

   ```sh
   openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out media-signing-private.pem
   openssl pkey -in media-signing-private.pem -pubout -out media-signing-public.pem
   ```

3. Store the private half out-of-band, then delete the local file:

   ```sh
   aws secretsmanager put-secret-value \
     --secret-id <prefix>-media-signing-key \
     --secret-string file://media-signing-private.pem
   rm media-signing-private.pem
   ```

4. Commit the public half in the environment's `terraform.tfvars` (a public key is not a
   secret):

   ```hcl
   media_signing_public_key_pem = <<-PEM
     -----BEGIN PUBLIC KEY-----
     ...
     -----END PUBLIC KEY-----
   PEM
   ```

5. The next deploy creates the CloudFront public key and key group, the uploads-bucket origin
   access control and bucket policy statement (read limited to `checks/*`), the `/checks/*`
   behaviour with its one-hour cache policy, and sets `MEDIA_KEY_PAIR_ID` and
   `MEDIA_SIGNING_KEY_SECRET_ARN` on the api Lambda.

### Verifying

Without cookies every `/checks/*` request is a 403 from the edge:

```sh
curl -sS -o /dev/null -w '%{http_code}\n' https://<app host>/checks/<site>/<check>/<artifact>.thumb.webp
```

With cookies signed by the private key for the matching site prefix the same request is a 200
(sign with `@aws-sdk/cloudfront-signer` `getSignedCookies` and a custom policy whose
`Resource` is `https://<app host>/checks/<site>/*`). A path outside `/checks/`, a trailing
slash, or `..` is a 404 from the viewer function before any origin call; the function never
rewrites the URI, so the URL the signature is checked against is the one S3 receives. Also
confirm that the cache policy's `cookies: none` leaves signed-cookie validation intact (AWS
documents the validation but not its interaction with cache policies). The `/checks/*` 4xx rate
is visible in the distribution's CloudFront metrics.

### Rotation

Rotation is a cutover, not an overlap: the variable holds one public key, so an apply with a
new PEM creates the new CloudFront key, points the key group at it, updates the Lambda's
`MEDIA_KEY_PAIR_ID` (which also makes new execution environments read the new private key)
and removes the old key. Put the new private key in Secrets Manager first, then change the
tfvars and deploy. Cookies signed with the old key fail with 403 for the few minutes the edge
and the Lambda disagree; the client treats a media 403 as "cookie stale", re-mints through the
token refresh and retries the image once, so users see at most one placeholder flash. If a
graceful overlap is ever needed, widen the variable to a list and add both keys to the group.

Revocation of a device or site follows the cookie lifetime: at most one hour, the same window
a presigned URL has today.

Successful online sign-out expires all three media cookies on the current host, including
when media signing has since been disabled. Offline sign-out or a failed server retirement
cannot clear HttpOnly cookies; those expire naturally. Cookie removal does not erase
already downloaded photos or unexpired browser HTTP cache entries.

Reports registers the check's media paths before loading its photo strip. If a cookie path
fails, the client retains it while using presigned URLs for a 15-minute cooldown. The photo
owner retries the retained path when the cooldown expires (when visible and online), without
requiring the Reports view to reload; another failure starts another bounded cooldown.

### What the cookie does not change

Deleting a check photo removes it from the check and its generated tasks. The API also
attempts to delete its original and thumbnail from S3, but this is best effort, not a
guarantee of immediate erasure. Failed cleanup logs `MediaObjectDeleteFailed`; there is no
durable cleanup retry, and retrying the request after row removal cannot recover the keys.

If cleanup fails or is interrupted, someone with the object URL and a valid cookie for
that site can still read it until lifecycle deletion. The 30-day expiry is measured from
each object's creation, not removal from the check, and lifecycle deletion is asynchronous.
An authorized user can renew their one-hour cookie, so cookie expiry does not shorten this
retention window. Successful S3 cleanup stops origin reads, but existing edge and browser
cache entries can remain for their one-hour cache lifetime; downloaded copies cannot be
recalled. This is an accepted limit of check-photo removal, not a sensitive-media erasure
workflow. Care-work deletion has its own object cleanup.

## 311 attachment leases

Silent and manual 311 filings snapshot each image into `sf311-media/` in the
uploads bucket before issuing a 48-hour lease. The copy has a new creation time,
retains its image content type, and replaces all lifecycle tags. A three-day
prefix lifecycle rule cleans up copies (including failed-submission orphans);
the source's 30-day rule is unchanged. Expired links are refused immediately,
independently of asynchronous S3/DynamoDB cleanup.

For privacy removal or immediate revocation, locate all `SF311_MEDIA_LEASE`
items matching the original `sourceS3Key` using authorized operational access.
There is no index on this attribute; use a filtered scan with pagination when
necessary. Delete each lease row by lowercase `pk`/`sk` and delete its snapshot
object at `s3Key`; remove any noncurrent versions if present. Purge the source
separately when required. Deleting only the source or its artifact row does not
revoke previously issued snapshots. Deleting the lease alone stops future
redirects, but an existing S3 redirect can remain usable for up to five minutes;
deleting the snapshot also stops access through those redirects.

Bearer links use a dedicated `media.<frontend-domain>` CloudFront distribution
with a validated certificate, HSTS/CSP, `no-referrer`, WAF, and no caching.
Standard CloudFront logging is intentionally disabled for this distribution
because it includes query strings. API Gateway's access log retains request ID,
device subject, site, admin user sub, route, status, and timing without tokens
or viewer IPs. Do not enable query/body logging on
this route, and do not paste full links or bearer tokens into incident records.
The application redacts bearer query parameters from failed SF311 request and
response diagnostics before persistence. Local tunnel access also requires
`S3_PUBLIC_PRESIGN_ENDPOINT` to reach the MinIO proxy.

## Daily cost warning

Terraform creates a warning-only AWS COST budget per UTC day: **USD 50 in PROD**
and **USD 100 in DEV**. The shared module's `daily_cost_warning_usd` input controls
both the budget amount and the absolute ACTUAL-cost notification threshold.
PROD explicitly sets 50; DEV retains the default of 100. Notifications go to
`alarm_emails`: `aaron.hans@sf.gov` (primary) and `beaudry.kock@sfgov.org` (secondary)
in PROD, and the independently configured DEV list. Budget notifications are
configured directly as email subscribers, separately from the two SNS topic
confirmations. It has no budget actions and cannot stop uploads, revoke
permissions, or throttle processing.

The filter is `user:Application$Good-Neighbor-App` (using `var.application`), across
all regions in the deployment account. Dev and prod have separate accounts and
therefore separate daily warnings; this is not a combined cross-account budget.
Only charges allocated to that tag count. Untagged charges and the separately
tagged analyzer/Bedrock service are outside this warning, even when Good Neighbor
caused that usage. This is attributed application cost, not full end-to-end cost.

Tag activation is optional in the application module. DEV sets
`manage_application_cost_allocation_tag=false` because it is a linked account;
the daily budget remains configured and deployment does not require activation.
PROD also sets `manage_application_cost_allocation_tag=false` because it is a linked account. Where activation is managed locally,
Terraform activates the existing Application cost-allocation tag.
Activation is account-wide: if already managed in another Terraform state, move or
import that ownership through the infrastructure workflow rather than managing it
twice. In an AWS Organization, billing/tag activation may require management-account
permissions; ensure the CI role can manage cost-allocation tags and budgets. A new
tag can take up to 24 hours to become available for activation.

The deployment role is externally owned and explicitly denies changing its own
IAM policies. Do not add a self-attached policy to the application Terraform: it
cannot bootstrap these permissions. The role's administrator must provision the
supplemental policy from `infra/policies/deploy-billing.json.tftpl` through the
authoritative role infrastructure. Render `account_id` from the target account
and `budget_name` as `<app-prefix>-daily-application-cost`. The Cost Explorer
actions require account-wide resource scope; budget permissions are restricted
to that one named budget. DEV uses the inline policy
`good-neighbor-app-dev-billing`, installed with an explicitly approved one-time
administrator repair; the template is retained in Git for reconciliation with the
external role infrastructure. This does not provision PROD's permissions.
Keep the role's trust policy and existing self-mutation deny intact. After provisioning, rerun the latest normal CI deployment.

If the error changes to `Linked account doesn't have access to cost allocation
tags`, IAM permissions are no longer the blocker. AWS permits activation only
from the Organizations management account or a standalone account. DEV and PROD
are linked accounts, so their application Terraform cannot own activation.
CI relinquishes only `module.app.aws_ce_cost_allocation_tag.application`
(including its indexed form) using locked `terraform state rm` before planning.
This forgets Terraform ownership without deactivating the actual tag; S3 backend
versioning retains earlier state versions. The step is idempotent in both environments and
fails the deployment if state migration fails. A plan guard rejects any later
cost-tag create/update/delete in either environment. Do not re-import the entry or
re-enable local activation there. Activation belongs in the billing management
account's infrastructure. Tag-filtered budget alerts remain incomplete until the
payer activates `Application`; application deployment is independent of that work.

Billing ingestion and budget evaluation are delayed (typically 8–12 hours between budget updates),
so this is not a real-time spend guard and can notify after the threshold was crossed.

After the normal CI deployment, inspect the budget in the Billing Console: verify
DAILY, USD 50 and ACTUAL > 50 in PROD (USD 100 and ACTUAL > 100 in DEV),
the Application filter, and the recipient list. Verify
the Application tag is active and compare attributed cost with Cost Explorer after
billing data arrives; zero reported cost alone does not prove the filter works.
No console configuration changes are required. Existing Site and global quota rows can expire
normally; the cost warning uses billing data, not those counters.

## Diagnosing photo upload validation failures

The API Lambda logs `UploadValidationRejected` when the check-artifact presign
endpoint rejects input with HTTP 400. The public response is unchanged. Fields
include the API Gateway `requestId`, `siteId`, `reason`, `declaredBytes`, and
`maxBytes`. No request body, photo, credentials, or raw content-type value is logged.
`declaredBytes` is null when unavailable or not a finite number; it is the client's
declaration, not an independently measured S3 object size.

Reasons distinguish `photo_too_large`, `non_positive_content_length` (zero or
negative), `invalid_content_length` (missing, wrong type, or fractional),
`unsupported_content_type`, `invalid_json`, and `missing_check_id`.

In AWS Console, select the environment's API Lambda log group in CloudWatch Logs
Insights, choose the incident time window, and run:

```sql
fields @timestamp, requestId, siteId, reason, declaredBytes, maxBytes
| filter marker = "UploadValidationRejected"
| sort @timestamp asc
| limit 200
```

Match `requestId` to the HTTP 400 in the API Gateway access log. These records
become available after deployment; they cannot explain historical rejections
retroactively. Quota rejections (429) retain their existing `MediaQuotaExceeded`
marker and are separate from this input-validation diagnostic.

## Assessment evaluation size and WAF blocks

`POST /v1/assessments:evaluate` accepts up to 65,536 decoded UTF-8 JSON bytes.
This accommodates AI-generated descriptions and translations sent back by the browser.
The handler returns JSON `413 {"error":"assessment_too_large","maxBytes":65536}`
above that limit, before parsing or writing data. Photo upload limits are unchanged.
Each evaluation attempt reaching the handler emits `AssessmentEvaluationRequestSize`
with `requestId`, `siteId`, `requestBytes`, `maxBytes`, and `sizeRejected`; it does not
log the assessment text. `sizeRejected: false` means only that the size check passed,
not that evaluation succeeded.

In Terraform (`infra/modules/app/main.tf`), only the Common Rule Set's
`SizeRestrictions_BODY` action is changed to Count. A subsequent label rule restores
its block except for exact `POST /v1/assessments:evaluate` and
`POST /admin/v1/site-imports/preview` requests. The CSV handler enforces a decoded
1 MiB file limit and 500 rows; JSON encoding adds transport bytes. Other managed
rules and rate limits remain active. CloudFront's WAF inspection window is 64 KiB:
it covers the evaluation body and only the first 64 KiB of larger CSV import
requests. Inspection above the default 16 KiB incurs additional WAF charges.
Size-rule blocks on other routes return JSON `413 {"error":"request_too_large"}`
with `Cache-Control: no-store`. Admin HTTP rejections stay in the operation's error
UI rather than raising a connectivity banner; network errors and HTML server
failures still trigger outage detection.

`infra/modules/app/waf-logging.tf` enables BLOCK-only logs in **us-east-1** under
`aws-waf-logs-good-neighbor-app-dev` (or the corresponding production prefix),
retained for 365 days and encrypted with a dedicated, rotating KMS key in us-east-1. Authorization, Cookie, X-API-Key, Referer, and query strings are
redacted. Logs still contain IP addresses, paths, request identifiers, and other
headers; keep access restricted. Logging redaction does not apply to the existing
WAF sampled-requests view. Allowed requests, including size-rule Count matches that
ultimately pass WAF, are dropped from these logs.

Deploy the handler and Terraform through CI. The deployment role needs permission
to configure WAF logging and CloudWatch log delivery/resource policies; WAF manages
the delivery policy. Do not run Terraform plan/apply or AWS CLI locally.

In CloudWatch Console Logs Insights, select the WAF log group in us-east-1 and the
incident time range:

```sql
fields @timestamp, httpRequest.httpMethod, httpRequest.uri,
       httpRequest.requestId, terminatingRuleId, ruleGroupList,
       requestBodySize, requestBodySizeInspectedByWAF, labels
| filter action = "BLOCK"
| sort @timestamp desc
| limit 200
```

For managed-rule blocks, expand `ruleGroupList` to find the inner terminating rule.
For size blocks outside the two exempt POST routes, the top-level rule remains
`BodySizeRestrictionsOutsideAssessmentEvaluation`. WAF's CloudFront request ID is
not the API Gateway request ID; correlate with time, route, and available identifiers.

In the API Lambda log group (app region), measure assessment sizes:

```sql
fields @timestamp, requestId, siteId, requestBytes, maxBytes, sizeRejected
| filter eventType = "AssessmentEvaluationRequestSize"
| sort @timestamp desc
| limit 200
```

After deployment, use an authenticated dev test site to verify a valid evaluation
above 8 KiB succeeds, one above 64 KiB returns the JSON 413, and another route still
blocks above 8 KiB with a WAF log entry. Terraform validation and handler tests do
not prove deployed WAF behavior. Logging begins at deployment and cannot recover
historical blocked requests.

## Local reservation verification

Run the focused upload handler suites and `frontend/src/services/upload-reservation.test.js`.
`node --test e2e/upload-reservation-storage.test.mjs` checks real browser IndexedDB persistence,
cross-tab serialization, expiry rotation, and site isolation using synthetic data and a loopback
server, without AWS or app startup. Chromium must already be installed for Playwright.
