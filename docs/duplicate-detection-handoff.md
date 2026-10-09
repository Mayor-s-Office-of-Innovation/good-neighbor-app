# Duplicate detection: continuation handoff

Recorded October 9, 2026, for continuation on another machine with another agent.
This repository handoff was explicitly requested by the user as an exception to
the usual rule that implementation plans live in GitHub issues. Keep the operating
reference in [duplicate-evaluation.md](duplicate-evaluation.md); update or retire
this handoff when the experiment advances.

## Start here

**Only a local evaluation harness exists. Duplicate detection is not integrated
into the app.** The next step is selecting real or deliberately captured reports,
preparing human-reviewed labels, and comparing the baseline against an AI model.
Do not interpret passing tests or synthetic fixture results as evidence that the
feature works in the field.

The harness is already tracked in Git. At handoff preparation, the working tree
was clean and HEAD was `be22e6b` (`Local test harness`). No private dataset, model
responses, cloud access setup, or live-model evaluation has been prepared by this
work. Do not assume anything in a temporary directory exists on the next machine.

## Product decisions already made

- A duplicate is another observation of the same ongoing real-world issue at
  the same site, across perimeter checks or single-issue reports. Match individual
  conditions, not entire photos/checks or tasks; one photo can contain several issues.
- An issue marked physically resolved that appears again is a **new issue**.
  Task completion or 311 filing alone does not establish physical resolution.
- Current scope is the backend duplicate flag and a reference/number for the
  issue it may duplicate. UI changes, merging, guidance suppression, and preventing
  duplicate 311 actions are out of scope for now.
- **Coverage takes priority over precision.** This supersedes the initial proposal
  to prioritize precision. No numerical acceptance threshold has been agreed.
  Still measure false suggestions and wrong targets so the tradeoff is visible.
- Search the preceding **seven days**. Expected upper volume is about ten issues
  per site per day: approximately seventy candidate observations, subject to how
  issues and repeated observations are counted. Avoid premature retrieval cutoffs.
- Begin with analyzer text and metadata; introduce images only if measured failures
  justify them. Photos may help reviewers establish ground truth from the outset.
- Passive metadata improvements are permitted if they require no additional user
  input. GPS accuracy and location measurement time are useful; neither has been
  added by the harness work.
- Assume **thirty-day image retention** for the design. This does not mean the
  deployed lifecycle has changed: the existing runbook described seven days, and
  [issue #450](https://github.com/Mayor-s-Office-of-Innovation/good-neighbor-app/issues/450)
  requests thirty-day deletion including backups. Verify actual configuration before
  planning an image evaluation. Matching still uses a seven-day window.
- Ground truth is evaluated during testing, not assumed. If it remains unreliable
  after algorithm/prompt refinement, keep suggestions explicitly advisory or discard
  the feature. Never force ambiguous observations into definite labels.

## What has been built and checked

| File | Purpose |
| --- | --- |
| `backend/src/analysis/duplicates/experiment.js` | Dataset validation, chronological candidate retrieval, lexical baseline, model prompt construction, response validation, and metrics |
| `backend/src/analysis/duplicates/fixtures/synthetic.json` | Fourteen authored cases: ten development and four held-out smoke cases |
| `backend/src/analysis/duplicates/experiment.test.js` | Eligibility, resolution, uncertainty, target validation, metrics, and leakage checks |
| `backend/src/analysis/duplicates/cli.test.js` | CLI runs, prompt export, prediction imports, and held-out threshold checks |
| `backend/scripts/evaluate-duplicates.mjs` | Local command-line runner; no remote model calls |
| `docs/duplicate-evaluation.md` | Input/output contracts, commands, and interpretation guidance |

The experiment returns `possibleDuplicate`, `duplicateOf`, `matchStrength`, `score`,
`reasons`, `status`, and `matcherVersion`. `duplicateOf` is currently an **observation
ID in the evaluation dataset**, not a resolved application issue number. Production
integration still needs a durable condition reference and a mapping to the number
the UI will eventually display. Scores are not calibrated probabilities.

Retrieval includes same-site observations within seven days that were available at
the replay time. It excludes self/revisions of the same source, superseded records,
and issues resolved before the new observation. It does not filter on exact category
or proximity. The model prompt receives all eligible candidates and no truth labels.

Checks passed during implementation: **29 focused tests**, backend TypeScript/JSDoc
typecheck, targeted ESLint with zero warnings, Prettier checks on changed code/JSON,
and `git diff --check`. The full repository suite was not run.

The synthetic development run at threshold 0.35 found two correct targets among
five labeled repeats. Only three repeat targets were retrievable: one was older than
seven days, one became available later. It also suggested one duplicate among three
distinct incidents. These deliberately difficult authored examples expose lexical
paraphrase misses and confusion between nearby locations; the small counts are
**not field-performance estimates**. No model comparison has run yet.

## What the user needs to do next

1. Tell the next agent whether to use **dev reports, production reports, or newly
   captured test reports**, and identify a few sites and a useful date range. This
   selection is still unanswered; access to any particular environment is not assumed.
2. Identify someone who knows the sites, or review the examples yourself, to judge
   "same ongoing issue," "different issue," or "cannot tell." Confirmed cleanup or
   resolution followed by recurrence must be labeled different.
3. Review the results and decide whether the recovered duplicates are useful enough
   relative to misleading suggestions to continue. The feature may remain advisory.

**The user should not have to hand-author JSON or operate the harness.** The next
agent should extract/prepare the observations, build a readable labeling worksheet,
convert judgments into the dataset format, and run comparisons. If historical data
does not establish identity, arrange repeated test captures of known ongoing issues,
distinct nearby issues, and resolved-then-recurring incidents.

## Next agent: execution sequence

1. Read `AGENTS.md`, this handoff, and the evaluation guide. Confirm the harness files
   are present on the new checkout. Use the repository's Node 22+ setup and install
   dependencies if needed. Run the synthetic smoke command and focused tests below.
2. Resolve the user's data-source choice. Inspect actual schema and access paths
   before writing an exporter. Preserve observation time separately from analysis
   availability, and establish which events explicitly record physical resolution.
   Do not interpret the unresolved-condition index as ongoing real-world issues:
   it means conditions not yet converted into tasks.
3. Prepare representative chronological sequences, including ordinary new reports,
   repeated incidents, ambiguous descriptions, differing categories/severities,
   text-only submissions, missing GPS, and nearby same-category negatives. Use human
   review independent of matcher predictions. Record disagreement rather than hiding it.
4. Keep each incident's related observations together in development or held-out
   testing; hold out sites or later periods when possible. The harness catches some
   direct split leakage, but cannot certify independence or ground truth.
5. Run the baseline. Export prompts and add/use an approved model runner with fixed
   model ID/settings. There is **no automatic Bedrock or analyzer invocation** in the
   harness today. Validate every response, preserve explicit failures, and compare
   against the same labels. Tune prompts/thresholds on development data only.
6. Report correct-target recall, candidate recall, wrong targets, false suggestions,
   uncertainty, and reviewer disagreement, with counts and representative errors.
   Distinguish matcher failures from unavailable/out-of-window candidates. Measure
   latency and cost before choosing a production approach.
7. If results justify proceeding, implement backend shadow evaluation after analyzer
   output, independently of the client's guidance request. Preserve source analysis
   revisions, stable target IDs, and matcher versions. Add durable retries without
   rerunning analysis, concurrent-report reconciliation, amendment invalidation, and
   current resolution revalidation. Keep pending, failed, insufficient-evidence, and
   evaluated-negative states distinct. Preserve existing guidance behavior.
8. Only after the text experiment identifies a need, compare image-assisted matching
   on the same held-out cases. Check retention, media access, and derived-feature
   treatment. Similar photos alone do not prove the same ongoing incident.

Production integration, automatic reconciliation, persistent flags, passive GPS
improvements, model execution, and UI behavior are **not implemented**. Avoid growing
this into automatic merging or launching a new datastore before evidence warrants it.

## Commands for resuming

From the repository root:

```sh
npm run duplicates:evaluate -w backend
npm run test -w backend -- src/analysis/duplicates
npm run typecheck -w backend
```

Use the evaluation guide for custom datasets, threshold sweeps, prompt export, and
response imports. Dataset paths in its examples are placeholders, not saved artifacts.
Real reports, media, labels containing sensitive details, and model prompts/responses
belong in an approved private storage location accessible on the next machine, not
Git or ordinary logs. Record only sanitized summaries and reproducible configuration
in committed artifacts. No such private storage location has been selected yet.

Suggested opening message to the next agent:

> Read `docs/duplicate-detection-handoff.md` and continue the duplicate-detection
> experiment. The local harness is built; the next step is preparing a real or
> deliberately captured evaluation dataset and comparing text/metadata approaches.
> Help me choose the source data and review example pairs. Do the extraction,
> formatting, and evaluation work for me. Coverage is the priority; production
> integration and UI work are not yet validated.
