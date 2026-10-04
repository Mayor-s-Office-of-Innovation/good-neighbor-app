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
- global per UTC day: 10,000 artifacts and 10 GiB

Reservations are deliberately conservative: issuing a PUT URL consumes quota even if the client
abandons the upload. Reservation records expire after 24 hours; daily counters expire with their
quota window. Do not manually lower counters during an active incident—doing so weakens the cost
control and can race in-flight uploads.

## Alarms

`MediaRejected` alarms after five worker validation failures in five minutes. Inspect the safe
structured fields (`siteId`, `checkId`, `artifactId`, and reason); never fetch or copy private media
into tickets or chat. A single rejection is normally bad camera/upload data. A concentrated burst
from one Site or device may indicate abuse or a broken client release.

`MediaQuotaExceeded` alarms after five rejected reservations in five minutes. Determine which
counter is near its conditional limit from the Site's `MEDIA_QUOTA#` rows and the global daily row.
Confirm whether traffic is expected before changing a limit in code. The public response
intentionally does not reveal which budget was exhausted.

For either alarm, correlate request IDs and deployment time, verify the alarm returns to OK, and
record the diagnosis without codes, tokens, email addresses, or media content.

## Retention and recovery

Lifecycle tags expire pending and rejected objects after one day, registered objects after two
days, and accepted objects after seven days. Noncurrent media versions expire after one day.
Lifecycle deletion is asynchronous and is not an immediate-delete mechanism. If worker processing
is delayed near two days, restore the queue before registered objects age out; do not retag objects
unless incident command explicitly approves extending sensitive-data retention.
