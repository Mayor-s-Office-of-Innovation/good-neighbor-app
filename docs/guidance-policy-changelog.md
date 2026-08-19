# Guidance Policy Changelog

*Policy operations log for the action/escalation rulebase.*

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
