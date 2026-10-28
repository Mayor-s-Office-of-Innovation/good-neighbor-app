# Guidance Policy Changelog

*Policy operations log for the action/escalation rulebase.*

## actions-escalations-v9 - 2026-10-28

- Imports the final `GNP - rubrics-3.csv` supplied on 2026-10-28 (39 rules),
  preserved in `backend/src/analysis/guidance/sources/GNP-rules-v9.csv`.
  Imports the approved wording without editorial changes.
- THREAT-1/2 use `likely_to_leave`: Yes selects the sidewalk action, No selects
  the SFPD non-emergency call. Question keys follow that corrected predicate;
  older catalogs retain `refusal_leave` and their original answer behavior.
- Updates BLOCK-1 and DISTRESS-2/3 guidance and DISTRESS-3's action text.
  MED-3 applies to severity 4–5; severity 1–3 follows the medical-help answer.
- Preserves supplied routing, phone numbers, and expected response times,
  which apply to the responsible party (site or outside agency) for each rule.
- New assessments use v9. Earlier catalogs, saved task snapshots, and their
  translations remain available. The frontend uses v9's saved button labels.

## actions-escalations-v8 - 2026-10-15

- Imports `GNP - rubrics-3.csv` (39 rules). Removes full phone numbers from nine
  button labels; Call 911 and Call 311 remain unchanged.
- Explicit phone-number fields, routing, filing behavior, and all other rule
  fields are unchanged. Prior catalogs and saved task snapshots remain available.

## actions-escalations-v7 - 2026-10-15

- Imports `GNP - rubrics-2.csv` (39 rules) with Sidewalk action, Phone call,
  and 311 ticket action types. Filing is derived from type: the first two
  file silently at creation; 311 tickets require user confirmation.
- Phone numbers are explicit task snapshots. At viewport widths of 520px or
  less, the phone CTA opens `tel:` and records the action as In progress;
  wider viewports retain the checkbox without dialing.
- Corrects BLOCK-3's primary agency to SFPD and THREAT-1's number to
  415-553-0123. ANIMAL-4 and THREAT-3 have Moderate weighting.
- Removes the deprecated task-decline mutation and controls. Earlier policy
  catalogs remain registered.

## actions-escalations-v6 - 2026-10-08

- Source: `GNP - rubrics-updated-2.csv` (39 rules), checked in as
  `backend/src/analysis/guidance/sources/GNP-rules-v6.csv`. Category source:
  `GNP - categories.csv` (14 categories), checked in alongside it.
- Activates the supplied rule fields, including SFAF needle pickup during
  09:00–17:00 and SFFD low-severity fire-hazard calls during weekday 08:00–17:00.
  Weekend daytime and overnight fire hazards route to 311; severity 3–5 routes
  to 911 at all times. The source assigns FIRE-3 to overnight reporting and
  FIRE-4 to emergencies.
- Time validity accepts `HH:MM-HH:MM, Mo+Tu+We+Th+Fr`, using `Mo`, `Tu`, `We`,
  `Th`, `Fr`, `Sa`, and `Su`. Without a qualifier, a range applies every day.
  `24 hours` remains unrestricted. Endpoints include the entire named minute.
- Both clock time and weekday come from the original report timestamp in
  `America/Los_Angeles`, including daylight-saving transitions. For overnight
  ranges, the weekday qualifier applies to the report's actual local calendar
  day, not the day when the window began. Validation checks all seven days for
  missing coverage when a category has weekday-qualified rules.
- Canonical names now match the supplied category rubric, including “Someone
  in distress” and “Threats, intimidation, or violence”. Older analyzer names
  remain compatibility aliases in both guidance evaluation and capture labels.
- The analyzer companion repository imports the category CSV as rubric
  `good-neighbor-app` v2.0.0; the app now requests that version. Deploy the
  analyzer version before deploying the app's updated request version.
- Prior guidance catalogs and analyzer rubric v1 remain available. Saved
  assessments keep their original policy version, and v6 task labels use their
  persisted button text so reused rule IDs do not substitute older actions.

## actions-escalations-v5 - 2026-10-06

- Source asset: `GNP rubrics.csv` (36 rules).
- Updated 27 user-facing button labels to action instructions for the checklist.
- Routing, agencies, eligibility for In progress, and all other rule fields are unchanged.
- Existing open cards display the current label by rule ID; their original policy
  snapshots and execution behavior remain unchanged. Prior catalogs remain registered.

## actions-escalations-v4 - 2026-10-01

- Source asset: `GNP rubrics-2.csv`.
- Added a Pacific-local daily validity window to every rule. Clarifying
  questions are resolved first, then the matching answer branch is checked at
  the condition's original `reportedAt` time.
- Added `canBeInProgress` as explicit rule metadata and snapshot it onto every
  new task. The first successful card action now moves eligible tasks to In
  progress; other tasks move directly to History.
- Added `primaryInProgressAgency` as explicit rule metadata and snapshot it
  onto new tasks so in-progress details show the rubric-defined agency.
- Removed status inference from user-facing button labels.
- Catalog validation now rejects any fully answered category, severity, and
  time combination that cannot resolve to a rule.
- Preserved earlier catalogs for historical assessments.

## actions-escalations-v3 - 2026-09-23

- Source asset: `GNP-3.csv`.
- Added `Max acceptable response time (hours)` to every rule; values are
  snapshotted onto new tasks so later policy releases cannot change an existing
  ticket's expected-response deadline.
- Added the final SF311 service codes supplied by GNP-3 and normalized the
  animal category to `Animals`.
- A zero-hour response value explicitly disables response-overdue assessment.
- Preserved `actions-escalations-v2` for historical assessments and tasks.

## 311 ticket closure reason correction - 2026-10-13

- Silent informational ticket closures now use `UpdateType 11` with `ClosedReason` 1
  (`NumericSubType: "1"`). The previously used reason 8 caused API closure errors.

## 311 ticket closure - 2026-09-04

- App-behavior addition (no rulebase change): when a task with a submitted informational
  311 ticket (recorded `responsibleAgency` 76 — currently always filed silently at task
  creation) is completed via the done path, the backend closes the ticket in the HUB with
  `UpdateSR` `UpdateType 11` (`ClosedReason` 8, "Field Work Completed"). Eligibility is
  tested by responsible agency, not filing trigger, so tickets filed for city-handled work
  (which resolve to a city agency) are never closed by the app. Closure failures are
  recorded on the task and never block completion.

## actions-escalations-v2 - 2026-08-18

- Source asset: `actions-escalations-rules-v2.csv`.
- Added canonical category labels from the v2 source asset.
- Normalized stable boolean question keys, including `onsite`.
- Preserved per-rule `policyVersion` on created tasks and conditions.
- Historical in-progress assessment evaluations continue on their original `policyVersion`.
- 311 payloads use the existing rulebase `311 category` field until a later rulebase defines the
  final ticket payload contract.
- Rulebase approval workflow is intentionally deferred.

## Update Process

1. Generate or edit the draft normalized catalog from the updated source asset.
2. Run `npm run policy:validate --workspace backend`.
3. Run `npm run policy:diff --workspace backend -- --before <old-catalog.js> --after <new-catalog.js>`.
4. Review semantic changes, especially routing, 911/phone, 311, email/form, and fixture impact
   changes.
5. Add a changelog entry for the new `policyVersion`.
6. Ship the new policy as a new catalog version; do not mutate in-progress evaluations onto it.
