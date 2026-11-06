# Care log deletion

`DELETE /v1/care-work/{workId}` follows public complaint deletion: any authenticated
Site device (general or manager) can delete a saved log at its own Site, including
one recorded by another team member. The Site comes from the verified authorizer,
not the request body. Other Sites receive a not-found response. API Gateway protects
the route with the existing device authorizer; no additional IAM grants are needed.

Deletion first transactionally marks the header `deleting` and removes its
system-status action projection. Media signing and create replays stop immediately.
It then deletes raw uploads, normalized JPEGs and thumbnails for both submitted
photos and unused upload reservations, using only keys derived from the authorized
Site and validated photo IDs. All reservation pages are visited. A cleanup failure
leaves the row available in the list for another delete attempt; no success is
reported until cleanup finishes. Already-missing objects are safe to delete again.

The final transaction removes the per-log upload budget and replaces the header
with a minimal `deleted` tombstone, expiring one year after deletion. It contains no
note, photo metadata or author identity, and has no list-index keys. This prevents
a delayed offline create from recreating the same UUID. Repeat deletes succeed.
Daily device abuse quotas are not refunded.

The UI confirms deletion, retains the dialog on failure, removes local saved
receipts and cached rows on success, and filters stale index results during the
current view. After a complete online list refresh, saved local receipts missing
from the index are checked against the strongly consistent detail endpoint. A
not-found response removes the receipt; index lag or network errors preserve it.
Pending uploads keep their existing retry/edit controls and do not
expose deletion controls.

System-status action counts decrease when a care log is deleted. Projection writes
check the current source row in a transaction, so delayed stream events cannot
restore a deleted action. Care logs do not contribute to manager Check/Task reports,
check-compliance counts or the analytics entity allowlist.

Object deletion uses the same S3 semantics as complaints. Bucket lifecycle rules
still govern retained versions. Previously issued upload URLs can remain usable
for up to five minutes; a late raw upload remains tagged pending and expires under
the one-day lifecycle rule. It cannot be submitted or signed after deletion.
