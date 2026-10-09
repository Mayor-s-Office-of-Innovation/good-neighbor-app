# Duplicate detection evaluation harness

The local, text-and-metadata experiment compares individual condition observations
at the same site within seven days. It favors coverage and produces advisory
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
list. Keep targets outside the seven-day window or unavailable at replay time in
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
with an acceptable misleading-suggestion burden. If text fails, compare image-assisted
matching on the same held-out cases. Assume a 30-day image-retention window and retain
the seven-day candidate window for that experiment; this harness does not modify
the deployed storage lifecycle. If ground truth remains unreliable, retain explicitly
advisory behavior or abandon detection. Production flags require durable retryable
evaluation, revision invalidation, resolution revalidation, and concurrent-report
reconciliation, none of which are established by synthetic success.
