# Policy authoring

Settings → Categories and rules (`/policies`) is restricted to Compliance
supervisors. Every API handler enforces the role; navigation is not the authority
boundary. The authoring APIs do not call the analyzer or alter the running policy.

## Draft workflow

The opening view is a category table. Each row has Edit and Rules actions; Add
category appears below the table. Rules opens that category's rule table, with
Edit on each rule and Create rule below. Editors open as stacked views. Save
persists the shared draft and returns to the owning table only after success;
failed or conflicting saves retain the editor and its values. Cancel and the
editor's Back control restore the complete pre-edit snapshot, including shared
questions and translations, and confirm before discarding changes. New records
remain provisional until Save. Leaving the page or using browser Back also
guards unsaved work.

Every editable field has an independent, keyboard-operable information button
using the existing `circle-info` icon. It toggles a plain-language explanation
below the label and above the control. Explanations describe the field's purpose,
its effect on staff advice, and relevant pitfalls; opening help never changes the
draft. The same pattern covers translations, scenario testing, and imports.

The first read creates an in-memory preview from the current `activeCatalog()`
and the bundled category source. It does not write a database item. Save persists
the shared draft with an expected revision. An incomplete draft may contain empty
policy text, but must have the supported document shape. Invalid numeric input
or a malformed document cannot be saved. JSON export is available before saving.

The editor supports all eight category fields and all eighteen current rule
columns. IDs are generated; weighting is inherited; questions have independent
IDs and explicit Yes/No branches. Existing agency/contact and 311 presets reduce
retyping; reviewed overrides remain editable. Integration code validation checks
format and the two supported classifier commands, not the City's live service
directory. Contacts and policy wording still require supervisor review.

The current authoring grammar supports one boolean question per rule, matching
the supplied policy. Arbitrary executable expressions and unsupported action or
classifier types are not authorable. A shared question's wording changes every
rule referencing that question. A new question is used when meaning differs.

Category renames add the old name to aliases when saving. Changed source text
clears unchanged stale translations, while newly supplied translations are
retained. Categories, questions, task instructions, button wording, supporting
guidance, and agency names use stable translation keys. Recognition-only prompt
fields remain English. The admin console remains English by design.

Validation reports actionable paths and example scenarios, with links to the
affected category/rule. It checks all severities 1–5, boolean combinations, all
weekdays, and the boundaries of every time window. Outcomes cannot change inside
a partition, so these checks cover the entire minute-based weekly decision space.
An explicit exception needs a lower numeric priority and must list the rule it
overrides. Every rule must still win a scenario. The UI also provides an unanswered
question preview, before/after scenario outcomes, working examples, semantic rule
and category changes, and a bounded coverage table.

Schedules use `America/Los_Angeles`. End times include the entire end minute.
An overnight weekday filter applies to the observation's local weekday, preserving
the existing evaluator semantics. DST-repeat instants use the same local rule;
the publication checks cover the local minute even when it is absent on one
particular spring-transition date.

## Prepared releases and operational limits

Save, enable translation validation, and validate before preparing a release.
The server revalidates the stored revision, requires a nonempty change reason,
and rejects an outdated `baseVersion`. It atomically writes the immutable package
and increments the draft revision. It does not activate anything. There is no
override for failed validation. Unresolved source-policy conflicts may be saved
as drafts but cannot be prepared as releases.

Packages contain the structured document, document digest, compiled guidance
catalog, category CSV, rule CSV, and activation prerequisites. Compiled artifacts
and analyzer-base metadata are frozen at preparation; later downloads never
rebuild old releases with newer compiler code. JSON is the full
backup and import format. CSV loses stable category identity, aliases,
translations, and exception relationships; it is a compatibility export, not a
replacement for the structured document. Leading spreadsheet formula characters
are escaped in CSV exports only. Import accepts the exact current headers and
returns a preview; it never persists automatically.

The compiled catalog in a prepared package is not available to production
evaluation until coordinated publication integrates it. The analyzer only loads
repository-owned, deployed rubric assets; its current rubric API is read-only.
Before activation, publication must verify the analyzer category contract and
recognition content, integrate the versioned translations into field-app reads,
bind both runtime versions, and preserve historical versions and rollback.
Preparing a package must never be presented as live publication.

Bounds: 50 categories, 100 questions, 250 rules, 8 distinct questions per category,
and 50,000 decision scenarios per document. Requests/items are capped at 280,000
UTF-8 JSON bytes, below DynamoDB's 400 KB item limit. Text fields have an 8,000
character limit. Excess complexity blocks validation. The coverage response is
limited to 1,000 displayed scenarios; checks and rule witnesses cover all supported
scenarios. Release history returns at most 100 records and indicates truncation.

On a revision conflict, export unsaved work, reload the shared draft, and reapply
changes. On a running-policy version change, import the latest reviewed source
CSVs and reapply changes; reloading an old saved draft alone does not rebase it.
Never relabel a stale draft's base version to bypass review.

## Storage and routes

The existing single table stores `POLICY_EDITOR / DRAFT` and
`POLICY_EDITOR / RELEASE#<UUID>`. The draft has a numeric revision, author, update
time, and document; releases have immutable document content, author, creation
time, reason, digest, and `prepared` status. There is no GSI, TTL, or active-policy
pointer. Existing API-role table permissions cover these operations; no new cloud
resource or external secret is needed.

| Method | Path | Purpose |
| --- | --- | --- |
| GET / PUT | `/admin/v1/policy/draft` | Read / conditionally save shared draft |
| POST | `/admin/v1/policy/validate` | Validate and review submitted content |
| POST | `/admin/v1/policy/preview` | Evaluate a scenario without side effects |
| POST | `/admin/v1/policy/import` | Preview two CSV sources |
| GET / POST | `/admin/v1/policy/releases` | List / prepare immutable releases |
| GET | `/admin/v1/policy/releases/{releaseId}` | Read package and CSV exports |

## Maintaining the initial recognition source

When updating the reviewed `backend/src/analysis/guidance/sources/GNP-categories-v2.csv`,
run `npm run policy:categories -w backend` to regenerate the bundled source.
The consistency test detects drift. If the recognition source filename changes,
update the generator and its consistency test together. Action rules always seed
from `activeCatalog()` rather than a separate uploaded snapshot. Current source
conflicts are not corrected by the authoring feature.

Verification: `npm run typecheck`, `npm run lint -w backend`,
`npm run test -w backend`, `npm run test:admin`, `npm run i18n:check -w frontend`,
`npm run build:admin`, and
`npx playwright test -c e2e/system-status.config.js policy-editor.spec.js`.
Browser tests mock the API and exercise draft editing, save/preview/validation,
role exclusion, keyboard focus, and automated accessibility checks. Backend tests
cover the conditional writes and release transactions without live AWS calls.
