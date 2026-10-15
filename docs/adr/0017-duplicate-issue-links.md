# ADR 0017: Asynchronous duplicate issue links

## Status

Accepted (2026-10-15). Implemented locally; deployment remains feature-gated.

## Context

Reports can describe the same ongoing issue. Duplicate assessment must not delay
normal issue analysis, and a mistaken link must be reversible without deleting
observations or undoing an action already taken.

## Decision

- Start assessment from the analysis stream, independently of card rendering and
  normal analysis/guidance execution. Bedrock calls remain exclusively in the
  analyzer's separately provisioned comparison function.
- Consider only the authenticated Site's same-category issues generated strictly
  less than 72 hours before the source issue. Issue generation uses the stored
  analysis timestamp, not image capture, upload, or file modification time.
- Use every available image. Text-only reports require explicit issue mappings,
  clear textual identity, at least two distinctive identifying correspondences,
  and no unresolved contradiction or continuity concern. Category, site and
  timing alone cannot establish identity. Confidence bands are not probabilities.
- Keep the tested fast shortlist, recent-first ordering within each phase, up to
  three candidates per comparison, incremental per-issue positives, and background
  expansion. Stop per issue on a high-confidence match. Failed candidate attempts
  do not stop the search; no qualifying match is distinct from pending work.
- Preserve each condition, task and artifact. Confirmed links identify a shared
  original issue by walking valid references, including beyond the retrieval
  window. An unassessed historical endpoint with no outgoing link is the earliest
  known original; explicitly pending ancestors remain pending. Future confirmed
  links can extend that chain. Never follow cycles or stale/cross-site/category links.
- If the original remains open, retain actionable cards with a duplicate note.
  Route either card's action to the original's existing completion lease. Once
  acted on, present one original in progress/history. A new repeat of an issue
  already in progress gets a compact duplicate card in to-do for the existing
  three-hour new-card window. Record detections in the original's timeline.
- Adopt an action that finishes before its duplicate result without executing it
  again. A persistent human override breaks the link. Normally the newer task is
  still open because actions ran on the original. If it had already been acted on
  before linking, preserve its audit record and create a fresh actionable task
  identity under the same condition/short ID so external-action idempotency state
  cannot silently reuse the old action. Leave the original's action intact.
- Exclude physically resolved issues from new matches; action completion or a
  311 filing alone is not physical resolution. Already confirmed observations
  preceding physical resolution remain part of that issue's history.
- A detection kill switch stops new comparison work. Persisted links continue to
  govern shared actions and remain separable; disabling detection must not cause
  duplicate external actions on an already linked group.
- Log only allowlisted IDs, model/matcher versions, categorical outcomes/confidence,
  and numeric timings/counts. Duplicate event logs expire after 30 days. Aggregate
  metrics may remain longer; they contain no images or narrative evidence. Counts
  are attempts/events, not unique issues, calibrated confidence or measured accuracy.
- Source and analyzer image evidence expire after 30 days. Prepared derivatives
  have a three-day lifecycle and are not written during the original's last three
  retention days. Validate the authoritative S3 age before reading a cached image.

## Consequences

Matching can finish after cards appear and users act. Independent frontend polling
must survive reloads, reject stale responses, preserve focus and keep ordinary
cards usable on errors. Medium/uncertain results do not collapse cards. New
comparison failures do not fail normal analysis or guidance. Human corrections
are retained as audit events; they are not enough to estimate overall accuracy.

Operational reports still retain the underlying observations; grouping the worklist
does not erase reports or retrospectively change check completion counts.

## Amendment — continuity and visible check status (October 15)

Unknown cleanup history alone no longer caps a distinctly identified, explicitly
mapped issue match at medium confidence. Concrete evidence of cleanup,
replacement or recurrence still prevents automatic linking. Missing issue
generation times, ambiguous mapping, unresolved contradictions and insufficient
identifying evidence retain their safeguards. Same-site, identical category and
strictly under-72-hour candidate eligibility are unchanged.

Editable ordinary cards expose pending duplicate checks beneath Edit details
with a small indeterminate ring and “Checking for duplicates.” Completed searches
without a qualifying automatic match show “No duplicate issues found” without a
ring. As previously agreed, failed candidate attempts do not block remaining
candidates; if none qualifies, the final presentation is no match. Diagnostic
results retain failures and uncertain suggestions separately.
