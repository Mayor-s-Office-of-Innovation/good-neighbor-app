# People migration rollout

The people migration links historical contacts and site assignments to canonical
person records. It follows explicit source references; matching names or email
addresses never merge people. Device credentials, membership generations, history,
and historical snapshots are preserved. See [ADR 0017](../adr/0017-independent-people-and-site-affiliations.md).

## Deployment gate

The shared dev/prod deploy workflow runs these steps after Terraform has deployed
the additive backend APIs and captured the environment's table name, before either
frontend is published:

1. Dry run; any conflict stops deployment before migration writes.
2. Apply; conditional conflicts or unexpected errors stop deployment.
3. Fresh dry run; require zero remaining people and zero conflicts.

The gate runs on every deployment and skips fully linked groups. If it fails, the
backend is already deployed, but frontend publication is blocked. Successful groups
from an interrupted apply remain linked; resolve reported conflicts and rerun the
deployment. Do not delete person records or revert links to retry.

Concurrent dashboard edits can cause conditional conflicts. Arrange a quiet edit
window for the initial migration; the gate does not disable already-published UI.
The deploy role needs DynamoDB scan and transaction permissions on the app table.

## Manual operation

Verify the intended AWS account with `aws sts get-caller-identity`, the region, and
the table ARN/tags with `aws dynamodb describe-table` and
`aws dynamodb list-tags-of-resource`. Use the table name from that environment's
Terraform outputs. Deploy backend APIs through CI first. Never load `.env.local`:
it targets local services. Ensure no AWS endpoint override is active.

From the repository root, with verified `AWS_PROFILE`, `AWS_REGION`, and
`DYNAMO_TABLE` set:

```sh
node backend/scripts/migrate-people.mjs
node backend/scripts/migrate-people.mjs --apply
node backend/scripts/migrate-people.mjs
```

Review the first report before applying. A report with conflicts exits nonzero;
resolve missing sources, source cycles, identity mismatches, or transaction-size
limits rather than merging contacts by inference. The final report must contain
`people: 0` and an empty `conflicts` array. Reports contain source identifiers;
keep operational evidence in an appropriate private location.

After frontend publication, use a supervisor test account to verify affiliation
changes, site lead provider/program reassignment, and provider manager transfers.
Confirm direct site access is retained and old provider-derived access does not
revive after transfers. Use dedicated test records for these mutating checks.
