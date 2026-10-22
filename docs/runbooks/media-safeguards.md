# Media safeguards runbook

Captured photos are private, KMS-encrypted S3 objects. Clients receive five-minute,
single-key PUT URLs; registration verifies the object's type, exact byte count, and signed
declared-size metadata. Analyzer input is independently decoded and re-encoded as JPEG, which
strips metadata and applies orientation while enforcing byte, pixel, edge, and single-page limits.

## Limits

- one object: 10 MiB
- one check: 20 artifacts and 50 MiB
- one device per UTC day: 50 artifacts and 100 MiB
- one Site per UTC day: 1,000 artifacts and 1 GiB

Reservations are deliberately conservative: issuing a PUT URL consumes quota even if the client
abandons the upload. Reservation records and check/device/Site daily counters expire after
24 hours, so an abandoned URL cannot permanently block its Check. Do not manually lower counters during an active incident—doing so weakens the cost
control and can race in-flight uploads.

There is no global daily upload quota. Upload reservations do not update a shared
cross-site counter. Existing global counter rows are unused and expire through their
existing DynamoDB TTL; no counter deletion or migration is required.

## Alarms

`MediaRejected` alarms after five worker validation failures in five minutes. Inspect the safe
structured fields (`siteId`, `checkId`, `artifactId`, and reason); never fetch or copy private media
into tickets or chat. A single rejection is normally bad camera/upload data. A concentrated burst
from one Site or device may indicate abuse or a broken client release.

`MediaQuotaExceeded` alarms after five rejected reservations in five minutes. Determine which
counter is near its conditional limit from the Site's `MEDIA_QUOTA#` rows.
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
error: `presignMedia` returns only the original and cards use that. Task-update photos
are never analyzed, so they have no thumbnail and always serve the original. Photos
analyzed before thumbnails existed can be filled in with
`npm run backfill:thumbnails -w backend` (dry run by default, `--apply` to write,
`--site <id>` to scope; needs `DYNAMO_TABLE` and `S3_UPLOAD_BUCKET`). A backfilled
thumbnail gets its own 30-day clock, so the script skips photos older than 25 days
rather than create a thumbnail that would outlive its original.

Proactive care photos share this bucket under the isolated `care-work/` prefix. Their
source uploads retain the one-day pending tag; validated, EXIF-stripped JPEGs use the
active tag. The API refuses photo access after 30 days even if lifecycle deletion has
not yet run. Their underlying work logs retain text and photo-expiry metadata for one
year. Care-work processing never enqueues analyzer jobs or retags check/task images.
Complaint evidence remains in its separate one-year bucket.


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
device subject, site, route, status, and timing without tokens or viewer IPs. Do not enable query/body logging on
this route, and do not paste full links or bearer tokens into incident records.
The application redacts bearer query parameters from failed SF311 request and
response diagnostics before persistence. Local tunnel access also requires
`S3_PUBLIC_PRESIGN_ENDPOINT` to reach the MinIO proxy.

## Daily cost warning

Terraform creates a warning-only AWS COST budget of USD 100 per UTC day. It sends
an ACTUAL-cost notification when attributed daily spending is greater than $100
to `alarm_emails` (currently `aaron.hans@sf.gov` in both environments). It has no
budget actions and cannot stop uploads, revoke permissions, or throttle processing.

The filter is `user:Application$Good-Neighbor-App` (using `var.application`), across
all regions in the deployment account. Dev and prod have separate accounts and
therefore separate daily warnings; this is not a combined cross-account budget.
Only charges allocated to that tag count. Untagged charges and the separately
tagged analyzer/Bedrock service are outside this warning, even when Good Neighbor
caused that usage. This is attributed application cost, not full end-to-end cost.

The same Terraform change activates the existing Application cost-allocation tag.
Activation is account-wide: if already managed in another Terraform state, move or
import that ownership through the infrastructure workflow rather than managing it
twice. In an AWS Organization, billing/tag activation may require management-account
permissions; ensure the CI role can manage cost-allocation tags and budgets. A new
tag can take up to 24 hours to become available for activation. Billing ingestion
and budget evaluation are delayed (typically 8–12 hours between budget updates),
so this is not a real-time spend guard and can notify after the threshold was crossed.

After the normal CI deployment, inspect the budget in the Billing Console: verify
DAILY, USD 100, ACTUAL > 100, the Application filter, and the recipient list. Verify
the Application tag is active and compare attributed cost with Cost Explorer after
billing data arrives; zero reported cost alone does not prove the filter works.
No console configuration changes are required. Existing global quota rows can expire
normally; the cost warning uses billing data, not those counters.
