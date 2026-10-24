# System status reporting

The Compliance dashboard's Settings → System status page is restricted to
`compliance-supervisor` in both navigation and every reporting/media API handler.
All sites, including inactive sites and sites without a check requirement, are
included. The page refreshes on entry, when the tab becomes visible, and every
60 seconds while visible. Counts are operational observations, not uptime probes.

## Definitions and sources

| View | Source and population | Window |
| --- | --- | --- |
| Network activity | Distinct sites with at least one registered check photo or description, divided by all sites | Since Pacific midnight |
| Analysis health | Final `analyzed` outcomes divided by `analyzed` plus `failed` outcomes for registered submissions; missing results are pending and excluded from the denominator | Submissions received since Pacific midnight |
| Submissions | One registered artifact per photo or description; server `receivedAt`, never client capture time | Since Pacific midnight |
| Checks | Perimeter check headers, grouped by current unfinished/completed status; single-problem reports excluded | Checks started since Pacific midnight |
| Issues | Positive analyzer concerns, once per check/artifact/condition identity, even after amendment, deletion or resolution | First generation since Pacific midnight |
| Actions | User task timeline events and proactive care logs; automatic duplicate-link events and copied/adopted actions excluded | Event time since Pacific midnight |
| Deletions | Immutable receipts written after an explicit condition rejection; not automatic supersession | Rejection since Pacific midnight |
| Duplicates | First duplicate link per issue/task, preserving source and directly matched observation references | Detection since Pacific midnight |

Network thresholds are 75%/25%; analysis thresholds are 90%/75%. Comparisons use
unrounded ratios. Display percentages are truncated to one decimal so a displayed
value cannot cross a threshold that the underlying ratio has not met. A zero
denominator is gray, not green or red. Analysis pending counts appear separately.
Complaint artifacts and action-update photos do not become submissions or analysis
requests in this report. Updates still count as actions.

Hourly sparklines use elapsed hours from Pacific midnight (23 or 25 buckets on
DST-change days). Missing analysis samples are gaps, not 0% success. Analysis
charts share a 0–100 scale; submission charts share the largest site/hour count
in the current view. Both health indicators, site counts, and charts use data
since Pacific midnight. Indicator tooltips explain their thresholds.

## Storage and delivery

`STATUS_SITES / <siteId>` contains all site names and lifecycle states.
`STATUS#<siteId> / <ISO time>#<kind>#<identity>` contains reporting snapshots.
Snapshots have 30-day `expiresAt`; they are not an alternate media archive.
`SEEN#issues#<identity>` and `SEEN#duplicates#<identity>` in the same partition
are identifier-only deduplication guards, atomically written with the first event.
`SITE#<siteId> / ISSUE_DELETION#<checkId>:<artifactId>:<conditionId>` is the explicit rejection
receipt. No new GSI is needed.

The existing outbox DynamoDB Stream consumer also projects relevant site records.
This retains the existing two stream consumers rather than adding a third reader.
Projection writes do not match the source filter. Failures use the worker's
partial-batch response and retry mechanism. Check and site projections reject
older versions; immutable events and transactional guards make retries safe.
The view is eventually consistent with stream processing. Inspect the background
worker errors and DynamoDB stream iterator age if recently recorded events are
missing; do not interpret missing projection data as a healthy pipeline.

Overview reads include all directory/query pages, use bounded concurrency, and fail
instead of publishing partial totals on a read error. Analysis outcomes are read
from current source records, so a successful retry replaces its prior failure.
Submission/duplicate lists page through bounded queries and load as they enter the
viewport. Media URLs are short-lived and only minted after supervisor authorization.
Deleted/expired media shows an unavailable message; counts remain intact. Duplicate
previews read the retained detection event, not a potentially changed current link,
and label subsequent human separation. Disabling detection does not erase history.

## Rollout

1. Deploy API, worker, frontend and stream-filter changes through the normal CI
   promotion pipeline. This does not enable duplicate detection.
2. Initialize the reporting directory from the existing table using the backend
   operational runtime and its deployment credentials:

   ```sh
   node backend/scripts/bootstrap-system-status.mjs
   node backend/scripts/bootstrap-system-status.mjs --apply
   ```

   The first command is a read-only dry run. The second populates the reporting
   records and marks `SYSTEM#STATUS / #META` ready only after a complete scan.
   Rerunning is safe. This is a data operation, not a Terraform apply.
3. Verify supervisor access and a manager's 403 response, then submit one photo and
   one description. Check counts, pending-to-terminal analysis, a check completion,
   an explicit deletion, and action history. When separately enabled, verify a
   duplicate pair and its subsequent separation.
4. The first complete reporting day starts at the next Pacific midnight. Legacy artifacts do
   not have a trustworthy server receipt timestamp, so the initializer deliberately
   does not substitute capture time. Before initialization the API returns 503
   rather than a misleading all-zero dashboard.

The local worker maintains the same projections with a loopback-only polling
bridge because DynamoDB Local does not emit Lambda stream events. It initializes
the local reporting directory automatically. It does not enable the duplicate
matcher. Tests can run without AWS or the local data stack:

```sh
npm run test -w backend -- src/domain/system-status.test.js src/handlers/system-status.test.js
npx playwright test -c e2e/system-status.config.js
```

The browser tests use intercepted fixture APIs and local Chrome, exercise role
visibility, navigation, lazy loading, preview dialogs and check pills, and run an
axe WCAG AA check at a narrow viewport. English copy is cataloged in all locales
using the established English fallback pending translation overlays.

## Data-integrity review

The agreed product definitions are the basis for these resolved implementation
findings. The [projection](../../backend/src/domain/system-status.js),
[reporting handlers](../../backend/src/handlers/system-status.js), and
[metric fixtures](../../backend/src/handlers/system-status.test.js) are the
primary sources for the figures; the source/population table above describes each
published row. Drilldowns are live reads with their own visible update timestamps,
so activity arriving between views can change a total.

| # | Finding | Dimension | Severity | Status |
| --- | --- | --- | --- | --- |
| 1 | Active-site or compliance-required-site denominators would overstate network participation. The directory includes inactive and non-required Sites. | Population integrity | High | Resolved |
| 2 | Pending analysis counted as failure, or failed attempts counted after recovery, would distort health. Reports read final outcomes and show pending separately. | Accuracy | High | Resolved |
| 3 | Current task state loses generated issues after edits/deletion and misses rejection before task creation. First-generation records and explicit rejection receipts preserve activity. Legacy analyzer concerns receive the capture UI's fallback identity. | Source integrity | High | Resolved |
| 4 | Stream retries, revisions and automatic duplicate-action adoption could inflate activity. Conditional writes, first-detection guards and exclusion of copied actions prevent this. | Accuracy | High | Resolved |
| 5 | Capture time and device timezone could move activity into the wrong day. Submission time is server receipt, with Pacific day boundaries. | Recency | High | Resolved |
| 6 | A new reporting installation or disabled duplicate matcher could appear to report trustworthy zeroes. Initialization gates and unavailable messages distinguish those states. | Headline fidelity | High | Resolved |
| 7 | Independently scaled percentage charts or filled-in missing samples could mislead. Analysis charts use 0–100; missing samples remain gaps; submission charts share one scale. Color indicators also have text labels and hourly charts expose their values to assistive technology. | Visual clarity | Medium | Resolved |
