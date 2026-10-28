# ADR 0019: Structured policy authoring and prepared releases

- Status: Accepted
- Date: 2026-10-28

## Decision

Compliance supervisors author recognition categories and response rules together
in the admin console. The editor uses stable category, question, and rule IDs.
Question wording is independent of boolean answer semantics; category weighting
is authoritative and inherited by rules. Category renames retain their previous
names as aliases. Severity zero continues to mean no actionable concern.

Drafts are shared and revisioned using conditional DynamoDB writes. Incomplete
policy content can be saved. A release is an immutable snapshot with its author,
reason, source revision, and SHA-256 document digest. Preparing a release advances
the draft revision in the same transaction that writes the release.

Release validation uses the production evaluator across severity levels,
boolean answers, weekdays, and every schedule boundary. Schedules retain the
existing inclusive-minute, Pacific-local-day semantics, including overnight
windows. Every rule must win at least one scenario. Unexplained overlaps, gaps,
unreachable rules, invalid references, unsupported configurations, and missing
field-app translations prevent preparation. Explicit higher-priority exceptions
may overlap lower-priority rules only if every rule remains reachable.

## Activation boundary

Prepared releases are **inactive**. This authoring implementation has no activation
endpoint, active-policy pointer, analyzer mutation, or change to the compiled
catalog registry. Existing assessments and tasks continue to use their original
catalogs. The running analyzer rubric pin is unchanged.

The companion analyzer currently packages rubric JSON in its Lambda artifacts;
its rubric API only reads those assets. Dynamic activation therefore requires a
separate coordinated publication mechanism. Activation must verify the published
analyzer rubric's category contract and recognition content, integrate release
translations with the field app, bind immutable analyzer and guidance versions,
and retain prior versions for existing work and rollback. A supervisor-entered
version string alone is not proof of compatibility.

## Consequences

Policy creation and validation are usable without changing live behavior. JSON
packages preserve editor metadata; CSV exports support migration through the
existing deployment process but are not a complete policy backup. An activation
control must not be added until its compatibility and translation gates can be
enforced server-side. See [the operations reference](../runbooks/policy-editor.md).
