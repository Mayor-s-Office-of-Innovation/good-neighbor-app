# Duplicate detection evaluation harness

Current product integration supersedes the historical shadow-only scope below;
see [ADR 0017](adr/0017-duplicate-issue-links.md) and the
[operations runbook](runbooks/duplicate-detection.md). It remains undeployed.

As of October 14, 2026, the agreed next experiment is image-first: assess images
alone, then use additional metadata only for low-confidence assessments. The
same-site, strict under-72-hour eligibility and exact canonical category equality apply before image assessment. The image matcher and runner are now implemented; their live comparison endpoint
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

Current image-matcher policy: compare only issues with exactly equal nonempty
analyzer `category` values. Generated display labels do not define category
identity. Production candidate age uses issue generation time (`generatedAt`, falling back
to `analyzedAt`), exposed as `observedAt` on the observation projection, and must satisfy
`0 <= source.observedAt - candidate.observedAt < 72 hours`; exactly 72 hours is
excluded. Unknown categories remain insufficient evidence. Candidate projections
carry categories, and current analyses refresh older projection categories before
filtering. Category eligibility precedes image downloads, and returned issue
links are revalidated for category equality. The earlier text baseline below/above
retains its historical five-day configuration for comparison.


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
no continuity concern. Partial visibility or concrete evidence of cleanup/recurrence caps confidence
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
negative. A folder run compares unordered pairs; it does not test 72-hour/site
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
   It paginates that site's CHECK partition, seeds analyzed image and text reports
   generated in the preceding 72 hours, and publishes a coverage marker only after
   successful writes. It makes no model calls. Older source windows outside the marker remain
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
shortlist; the production matcher still examines its full same-site, 72-hour
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

## Low-latency isolated result delivery

The duplicate stream consumer and SQS worker remain separate from normal analysis
and guidance. Analysis creation never awaits this work. The dispatcher records
pending condition outcomes. A dedicated read route,
`GET /v1/checks/{checkId}/artifacts/{artifactId}/duplicates`, derives the site from
the authenticated principal and reads only that site's current analysis revision.
It reports `disabled`, `awaiting_analysis`, `pending`, `partial`, `retrying`, or
`complete`; unknown flags are `null`, never `false`. The route is disabled with the
same deployment feature flag as duplicate processing. No product UI is wired yet.

After each validated comparison batch, high-confidence explicit issue positives
can be published individually as `DUP_ISSUE#<observation>#<revision>#<condition>`.
A DynamoDB transaction checks the current source and target analysis revisions and
both physical-resolution projections and source/target artifact presence before
each publication. Other conditions
stay pending. Qualified positives survive unrelated comparison failures; unproven
conditions remain unknown and the job retries. Reads recheck source/target
revisions and resolution before returning a positive. Negatives require complete
eligible candidate coverage. Whole-source results remain `DUP_RESULT` records.

Immutable uploaded media is normalized once into the separate
`duplicate-prepared/` prefix of the upload bucket, keyed by source-object identity,
content type and preparation version. Only the duplicate worker has write access
to that prefix. Cached fingerprint and normalized bytes are verified before reuse.
The local runner uses the same preparation helper with private on-disk storage.
This relies on the existing immutable media-key contract: if overwrites are ever
introduced, source object version must become part of cache identity. Prepared
objects expire under a dedicated three-day prefix rule; original upload retention
rules are unchanged.

Evidence-free `duplicate_latency` log events record queue age, analysis-to-worker
lag, retrieval/preparation/comparison completion offsets, first-positive publication
and total worker time. Matcher results include comparison time, total time and
first qualifying positive time. These are measurements, not latency guarantees.
The local report shows per-source timings and pending/progress events; it does not
measure deployed queue delay, database publication or UI refresh latency.

The analyzer comparison prompt requests concise reasons/regions and short feature
lists while retaining explicit issue mapping and confidence evidence. Its output
ceiling is bounded; malformed/truncated output remains a failure. Normal analyzer
prompts and token budgets are unchanged.

For selected-folder evaluations, `--source-concurrency 2` runs at most two source
jobs concurrently, matching the dedicated production worker cap. Successful
comparison/preparation caches are reused; result and progress file writes are
serialized. `--resume` preserves already completed sources, including their failures,
rather than silently reclassifying failed pairs. Assessment metadata and normalized
images stay outside Git.

### Recent-first matching and original issue references

Production matching checks candidates in descending issue-generation time order
(still the same category, same site, and strictly less than 72 hours older).
Each production request assesses one candidate photo, so a high-confidence explicit
issue mapping can immediately stop that issue's search. Other issues in the source
photo continue; already matched issue IDs are omitted from subsequent contextual
requests. Candidate images are prepared only when reached. The evaluation harness's
explicit exhaustive mode retains full coverage and batched comparisons.

A completed search with no qualifying high-confidence mapping returns
`possibleDuplicate: false`, including failed, malformed, uncertain, and medium-confidence
attempts. This means **no qualifying match found**, not proven physical difference.
Failed candidate IDs and review suggestions remain available as diagnostics. Pending
work continues to return null. Infrastructure/publication failures still retry; a
comparison failure alone does not retry the completed search.

The independent duplicate-results endpoint preserves `duplicateOf` as the direct
image-confirmed match. It also returns per-issue `originalIssue` and
`originalLookupState`. It follows existing strong duplicate references using database
reads only, beyond the image comparison window. Every hop must have a current analysis
revision, extant artifact, unresolved projection, the same canonical category and site,
and an observation time no newer than the preceding hop. Cycles, broken references,
and chains exceeding 64 issues return `invalid_chain` with a null original. A pending
ancestor returns `pending`; a completed ancestor without a qualifying match is the
original. This lookup does not delay normal analysis or trigger image comparisons.
The direct positive remains available while original lookup is pending or invalid;
clients must only collapse to `originalIssue` when its lookup state is `complete`.

Use `--production-search` with the image evaluation runner to exercise sequential
candidate requests and per-issue early stopping. The default remains an exhaustive
comparison audit. Reports distinguish time to the first review suggestion from time
to the first qualifying high-confidence flag and total source search duration.
Use a fresh output directory containing only copied assessment/preparation caches
when measuring uncached comparison latency. Unknown capture times remain unknown;
these samples cannot demonstrate chronological ordering or continuity-dependent
high-confidence early stopping.

### Metadata triage and combined verification

The default matcher now uses one contextual image verification call instead of an
image-only call followed by a contextual call. Images remain authoritative; every
positive still requires grounded source/candidate condition IDs, distinctive visual
identity, continuity evidence, and no unresolved material contradiction. The old
workflow remains available to the local runner with `--legacy-search` for comparisons.

The app selects up to three fast-path candidates using cached fingerprints/dHash
and narrow object-description hints. A clear mismatch between known object families
moves a candidate out of the initial shortlist; vague, negated, mixed, and unknown
text abstains. Text never creates a duplicate flag or a final negative. The app
checks the selected shortlist youngest first, then expands to all remaining eligible
candidates youngest first, including metadata-deferred candidates. Combined calls
contain at most three candidates, with confirmed source issue IDs removed from later
calls. Any missed shortlist match remains pending until background expansion finishes.

`--fast-only` benchmarks only the first request and deliberately returns pending for
unmatched issues with remaining eligible candidates. It must not be interpreted as
an exhaustive search or a final no-match. `fastCandidateIds`,
`metadataDeferredCandidateIds`, and `latency.fastPhaseMs` record retrieval decisions
and fast-phase latency. The dedicated worker publishes high-confidence issue results
incrementally while continuing background expansion within its isolated invocation.

Artifact-registration stream events now queue preparation-only jobs on the duplicate
queue. They warm the immutable image cache independently while normal analysis runs.
Source projections retain fingerprint/dHash features for later candidate selection;
older projections without those features fall back to metadata/age ordering.

Comparison-only compact output omits display regions but retains structured evidence
for every issue mapping and candidate. Bedrock prompt caching and latency-optimized
inference are opt-in analyzer settings, subject to model/region support. They do not
change the normal analyzer's model or invocation settings. The default duplicate model
remains Sonnet pending a wider, labelled speed/accuracy evaluation. Visual embeddings
are a subsequent retrieval enhancement after this simpler fast-path benchmark; they
are not implemented or required for correctness of background expansion.

Faster comparison models now use schema-directed result output: Nova uses a forced
Converse result tool, and Haiku 4.5 also uses strict tool schemas. This fixes omitted
candidate/mapping evidence without synthesizing missing continuity or contradictions.
The analyzer still rejects malformed evidence, invented/repeated IDs, mappings on
negative verdicts, incomplete candidate coverage and truncation. Schema validation
is separate from app match confidence. Cache version `issue-structured-v10` prevents
reusing responses from the earlier prompt/transport during model evaluation.

Full-search evaluation reports also record per-issue first review suggestions,
per-source admission/completion offsets, and whole-run search wall time. Per-source
matcher times exclude time waiting for one of the configured source-concurrency
slots; the report exposes those local scheduling delays separately. These local
batch timings are not measurements of deployed SQS delay or frontend publication.

## Product integration

The current deployed-code design (not yet deployed) is documented in
[ADR 0017](adr/0017-duplicate-issue-links.md) and the
[operations runbook](runbooks/duplicate-detection.md). It uses issue-generation
time for eligibility, supports reports without images, preserves reversible
condition-level links and shares group actions. Local image-only replay artifacts
remain experiments and are not evidence of live field accuracy.


Current continuity amendment (October 15): unknown cleanup history alone does
not cap an otherwise distinctive, explicitly mapped same-issue assessment.
Concrete cleanup/recurrence evidence, unresolved contradictions and ambiguous
mapping still prevent automatic linking. See ADR 0017 for the product policy.
