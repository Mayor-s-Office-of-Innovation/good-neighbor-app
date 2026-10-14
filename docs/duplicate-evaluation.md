# Duplicate detection evaluation harness

As of October 14, 2026, the agreed next experiment is image-first: assess images
alone, then use additional metadata only for low-confidence assessments. The
same-site, five-day eligibility rules still apply before assessment. The image matcher and runner are now implemented; their live comparison endpoint
must be deployed separately in the analyzer repository. The initial gate uses
strong/tentative/none visual evidence, not calibrated probabilities. Field accuracy
and thresholds remain unvalidated. The text commands below remain a comparator. See [the handoff](duplicate-detection-handoff.md)
for the revised execution sequence.

The local, text-and-metadata experiment compares individual condition observations
at the same site within five days. It favors coverage and produces advisory
suggestions with a specific target. It does not run in the deployed analyzer flow,
write database records, change UI, merge reports, or suppress guidance/311 actions.

## Run

From the repository root:

```sh
npm run duplicates:evaluate -w backend
npm run duplicates:evaluate -w backend -- --dataset /private/tmp/incidents.json --thresholds 0.25,0.35,0.5
npm run duplicates:evaluate -w backend -- --dataset /private/tmp/incidents.json --split test --thresholds 0.35
```

The bundled synthetic fixture verifies behavior and demonstrates failure modes. Its
labels are authored examples, not evidence of field accuracy. Default runs evaluate
the development split only. Choose a threshold using development data, then freeze
it before testing; the CLI requires one threshold for baseline test runs.

Output includes counts, denominators, aggregate rates, candidate IDs, and individual
predictions. Scores are ranking signals, not calibrated probabilities. The lexical
baseline uses descriptive token overlap, category agreement, recency, and a small
device-location bonus. It has no learned semantic understanding or multilingual
equivalence and can confuse opposite landmarks or miss paraphrases. These are
deliberate comparison cases for a subsequent model experiment, not claims that the
baseline solves incident identity. Threshold defaults are experimental.

## Dataset contract

Use a JSON object with `name`, `synthetic`, `observations`, and `cases`. The complete
sample is `backend/src/analysis/duplicates/fixtures/synthetic.json`.

Each observation has:

- `id`: globally unique reference to one condition observation/revision, not a photo
  or task ID; retain a mapping to assessment/condition keys outside the experiment.
- `siteId`, `category`, `description`; optional `label`, `originalText`, `issueNumber`.
- `observedAt`: capture timestamp; `availableAt`: when this revision became available
  to the backend. Both are ISO timestamps with explicit timezone. Validate device
  clock quality during dataset preparation; do not silently substitute analysis time.
- Optional `sourceId`: stable artifact-and-condition lineage shared by revisions.
  Different conditions in one image must have different lineage IDs.
- Optional `resolvedAt`: explicit physical-resolution time. Do not infer this from
  task completion, guidance generation, or 311 filing. Propagate confirmed incident
  resolution to all its prior observations when preparing a labeled replay.
- Optional `supersededAt`: when this analysis revision was superseded.
- Optional `location`: `latitude`, `longitude`, `source` (`device` or `site`), and
  `accuracyMeters`. Missing GPS is unknown; fallback site coordinates receive no
  proximity bonus. The existing capture flow does not yet persist GPS accuracy.

Each case has `sourceId` (an observation ID), `split` (`development` or `test`),
`label` (`duplicate`, `distinct`, or `indeterminate`), and `duplicateIds`. A duplicate
case lists all acceptable prior target observation IDs; other labels have an empty
list. Keep targets outside the five-day window or unavailable at replay time in
the truth set when genuinely the same incident: this exposes retrieval limitations
instead of silently excluding them from recall. Never label a post-resolution
recurrence as a duplicate of the resolved incident.

Prepare labels independently of algorithm predictions using photos, context, and
reviewers with site knowledge where available. Preserve reviewer disagreements as
indeterminate until adjudicated; do not force artificial certainty. Record reviewer
agreement separately. Keep each physical incident and its related observations in
one split, and hold out sites or later periods to assess generalization. The tool
cannot verify independence or truth of supplied labels. Avoid using only obvious
positive pairs: include ordinary new reports and difficult same-category negatives
at realistic frequencies.

Candidate replay checks site, time window, availability, lineage, supersession, and
resolution before comparison. It retains all eligible candidates without category
or distance cutoffs. Same-time records already available are included. Missing
concurrent records count as retrieval misses; this offline harness does not implement
production reconciliation. Resolution after the source observation does not erase a
historically valid match. A later production integration must revalidate a target's
current eligibility before presenting it.

## Compare a model

Export versioned prompts containing source evidence and all eligible candidates:

```sh
npm run duplicates:evaluate -w backend -- --dataset /private/tmp/incidents.json --prompts /private/tmp/duplicate-prompts.json
```

The export uses exclusive creation and owner-only permissions. It omits labels,
future lifecycle events, and arbitrary extra fields. Evidence is explicitly treated
as untrusted data in the prompt. Run these prompts through an approved model with
fixed model version/settings; the harness makes no remote calls. Save responses as:

```json
[
  {
    "sourceId": "repeat-new",
    "prediction": {
      "status": "evaluated",
      "possibleDuplicate": true,
      "duplicateOf": "repeat-prior",
      "matchStrength": "tentative",
      "score": null,
      "reasons": ["Matching distinctive object and entrance"],
      "matcherVersion": "configured-model-id/incident-comparison-v1"
    }
  }
]
```

Then evaluate the complete response batch against the same dataset/split:

```sh
npm run duplicates:evaluate -w backend -- --dataset /private/tmp/incidents.json --predictions /private/tmp/duplicate-predictions.json
```

Missing responses must be represented explicitly with `status: "failed"`,
`possibleDuplicate: null`, `duplicateOf: null`, `matchStrength: null`, and `score: null`.
Insufficient evidence uses the same null fields with `status: "insufficient_evidence"`.
Negative evaluated results use `possibleDuplicate: false` and no target/strength.
Malformed responses and ineligible target IDs fail validation, rather than being
scored as successful non-matches. The batch must contain exactly the selected cases.
Keep real evidence, prompts, and responses out of source control and normal logs.

## Interpret results

- Candidate recall: actual repeats whose acceptable target was retrieved / repeats.
- Flag recall: actual repeats receiving any suggestion / repeats.
- Correct-target recall: actual repeats linked to an acceptable target / repeats.
- Suggestion precision: correct targets / suggestions on determinately labeled cases.
- False-flag rate: new incidents receiving a suggestion / new incidents.
- Incorrect suggestions per labeled report: false flags plus wrong targets / labeled
  reports. This catches a duplicate flag pointing to the wrong existing issue.
- Coverage, uncertainty, failure, and indeterminate-label rates remain separate.
  Failed or uncertain duplicate cases still count in recall denominators.

Undefined rates are `null`, never fabricated zeroes. Indeterminate cases do not
contribute to precision/recall denominators. Review per-case errors and category/site
slices alongside aggregate rates; small sample rates are not deployment guarantees.

The release gate is useful coverage on independently reviewed real observations
with an acceptable misleading-suggestion burden. The next experiment compares
image-only matching with metadata fallback for low-confidence assessments on the
same held-out cases. Evaluate confident mistakes separately, since fallback will
not address them. Assume a 30-day image-retention window and retain
the five-day candidate window for that experiment; this harness does not modify
the deployed storage lifecycle. If ground truth remains unreliable, retain explicitly
advisory behavior or abandon detection. Production flags require durable retryable
evaluation, revision invalidation, resolution revalidation, and concurrent-report
reconciliation, none of which are established by synthetic success.


## Executable image-first experiment

`src/analysis/duplicates/image-matcher.js` is shared by the local runner and the
isolated SQS worker. The app owns candidate eligibility, hashes, escalation and
advisory decisions. Every Bedrock call stays in the analyzer's comparison handler.
Normal analysis, guidance, and task creation have no dependency on duplicate work.

Image SHA-256 and dHash order candidates without excluding distant viewpoints.
All candidates are examined before a negative result. Once all identified source
conditions have strong mapped targets and the current batch has no ambiguity,
further batches are skipped; output explicitly lists unassessed candidates. The
first model pass contains image bytes and opaque IDs only. Every possible positive,
including single-condition images, requires a second pass using analyzer issue
IDs, descriptions, labels, and available time/location metadata. Uncertain visual
evidence also receives this context. A duplicate requires an explicit valid
source-condition to candidate-condition mapping with strong evidence; matching
scenery or photos alone cannot set a duplicate flag. No issues means no duplicate
suggestion. A strong issue suggestion is not proof of uninterrupted existence.
Visual evidence takes precedence over fallible analyzer descriptions and labels:
viewpoint differences or a misidentified object must not become a strong negative
solely because wording differs. Explicit issue references remain mandatory. If
the images cannot resolve a description conflict, the assessment stays uncertain.
The contextual pass receives the earlier image-only correspondence to verify
against the images. A contextual rejection that contradicts a strong image-only
match stays uncertain in app logic; it cannot silently become a confident negative
or an automatic issue mapping. Comparison caches include the matcher version.

`issue-evidence-v5` returns structured evidence for each comparison and each
explicit issue link. The app assigns high/medium/low confidence bands, not
probabilities. High positive confidence requires clear visual identity, grounded
issue mapping, distinctive matching features, no unresolved contradiction, and
no continuity concern. Partial visibility or unknown continuity caps confidence
at medium; stage disagreement or unresolved description conflict makes it low.
High negative confidence requires concrete visible differences. Resolved
description errors do not reduce confidence. Only high explicit links set
advisory flags; medium links remain review suggestions. The local report displays
evidence and confidence reasons for positives, negatives and uncertainties.

Condition outcomes include a versioned observation/condition reference; there is
no automatic mapping to a displayed issue number yet.

Prepare `backend/.env.duplicates` (gitignored, owner-only) with the existing dev
analyzer URL/key, separate duplicate URL/key, and private output directory. The
comparison URL uses the same dev API base after the analyzer deployment adds
`/v1/image-comparisons`; its key is a separate, generated API Gateway key. Never
reuse the normal analysis key or put real evidence into Git.

From repository root:

```
npm run duplicates:images -w backend -- --folder /absolute/private/image-folder --assess --features-only
npm run duplicates:images -w backend -- --folder /absolute/private/image-folder
```

The first command caches actual dev analyzer assessments and normalized image
features. Assessment timestamps are explicitly evaluation time, not capture time;
mandatory location placeholders do not establish site identity. The second calls
the real comparison endpoint through the app matcher. JSON results, private
response caches, images, and `review.html` are written to DUPLICATE_OUTPUT_DIR.
Restarting reuses successful cached calls. Change cache version or output directory
when changing the remote model/prompt configuration. `--max-calls N` bounds remote
comparison calls; exhausted/unavailable work is failed or unassessed, never a
negative. A folder run compares unordered pairs; it does not test five-day/site
eligibility or resolution without an independently supplied observation manifest.
Known duplicate groups are withheld until the machine results are recorded.

## Isolated shadow rollout

1. Review and deploy the analyzer changes through its existing dev workflow. It
   creates CompareFn, a separate operation-authorized API key, usage plan, logs,
   and alarms; analyses keep their existing function and credentials. Retrieve
   the key identified by the ComparisonCallerApiKeyId stack output and add its
   value to the private environment file. Complete the real-folder experiment.
2. Deploy the app's Terraform through CI. The new queue, dispatcher, worker and
   dedicated key secret are separate from normal analysis. Stream and SQS mappings
   default disabled (`enable_duplicate_detection=false`). Provision the generated
   comparison key into the duplicate secret out-of-band, never Terraform state.
3. Before enabling a site, initialize its full candidate projection using the
   site-scoped maintenance script with AWS credentials and DYNAMO_TABLE and
   DUPLICATE_QUEUE_URL configured:
   `node backend/scripts/bootstrap-duplicate-observations.mjs --site SITE_ID`.
   It paginates that site's CHECK partition, seeds analyzed images captured in
   the preceding five days, and publishes a coverage marker only after successful
   writes. It makes no model calls. Older source windows outside the marker remain
   insufficient evidence. Use a controlled maintenance job for large site histories.
4. Enable the dev mappings via CI only after provisioning and evidence review.
   Source revisions and target lifecycle are rechecked; positives use atomic
   condition checks. Resolution changes to projections invalidate dependent results
   and queue re-evaluation. Translation-only analysis changes do not dispatch jobs.
   Keep flags shadow-only and revalidate referenced revisions when adding a reader;
   historical evaluation snapshots must not be treated as current truth.

Retries use cached comparison responses and do not rerun normal analysis. Queue
and stream failures have independent dead-letter handling. Source/target revisions,
unknown evidence, failed calls, and incomplete candidate history remain distinct.
The dispatcher filters normal table records but adds a stream consumer and table
read/write load. Separate Lambdas do not reserve shared account or Bedrock model
quotas: start conservatively, monitor normal analysis latency/throttling, and disable
the duplicate mappings if they affect it. Region/model capacity and classifier
quality must be verified before production; no field-readiness claim is made.


### Faster initial pass

The default folder evaluation checks every unordered image pair, disabling the
production matcher's early stop after all source conditions have strong targets.
Individual failed comparisons remain unknown while the evaluation continues.
Production retains its early stop; this exhaustive mode is for measuring recall.

For a selected corpus, add `--source-folder /path/to/Source` and
`--candidate-folder "/path/to/Match candidates"`. Both folders must contain
byte-identical copies of named images in `--folder`, preserving the corpus IDs and
assessment cache. The runner checks every selected source against every selected
candidate, excluding itself, regardless of filename order. The report records both
sets. Successful cached comparisons are reused only for the same request.

`--initial-candidates 4` restricts the private-folder experiment to the four
highest-ranked prior image candidates per source. This is an evaluation-only
shortlist; the production matcher still examines its full same-site, five-day
candidate set unless all identified conditions have strong targets. Skipped
candidates are listed explicitly. Negative condition outcomes become insufficient
evidence while candidates remain unassessed; strong positive suggestions remain
available for human review. This pass cannot establish overall recall or certify
that an image is unique. File order remains a reproducible pair orientation, not
an inferred capture chronology. Successful comparison caches can be reused when
resuming a full sweep.

Local browser login can authorize live comparisons without deploying the analyzer:
`aws login --profile good-neighbor-local --region us-east-1`. The selected identity
must already have Bedrock invoke access. Run the analyzer's loopback adapter with
AWS_PROFILE set to that profile, then point the app runner at its loopback URL and
fresh private key via process environment overrides. Keep deployed API credentials
in the private env file; do not replace them with the temporary loopback key.
