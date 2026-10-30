# CloudWatch Omni deployment permissions

`infra/modules/app/omni.tf` discovers IAM Identity Center roles with `ListRoles`,
creates its tagged domain/space through an application CloudFormation stack,
and manages the account/region's default Dataset integration. The deployment
role needs these permissions before the first Omni-enabled plan/apply.

An `AccessDenied` on `module.app.data.aws_iam_roles.omni_sso` means the plan
cannot discover roles. Apply has not started. Fixing only this read can expose
later missing stack, Dataset integration, or service-role passing permissions.

## Provision the externally owned deployment role

The role administrator must provision the supplemental policy in
`infra/policies/deploy-cloudwatch-omni.json.tftpl` through the authoritative
deployment-role infrastructure. Render `account_id`, `aws_region`, and
`name_prefix` for the target environment. Preserve existing policies, the trust
policy, and the bootstrap/self-mutation denies. Do not make application Terraform
manage its own deployment role or attach a broad administrator policy.

If the role was manually bootstrapped and no owning infrastructure definition
can be found, inspect CloudTrail `CreateRole` and policy mutation events before
assuming another Terraform project exists. A direct administrator repair requires
an explicit exception to the repository's Terraform/CI rule. For an authorized
repair, render this template and add it as a new supplemental inline policy on
the verified environment's deployment role. Read it back, compare the existing
trust, boundary, attached policies and inline policies before/after, and rerun
permission simulations. Do not replace the existing deployment policy or remove
its self-modification deny. Keep the reviewed template in Git for future adoption
by the owning infrastructure.

The template supplements the existing app-role management and `cloudwatch:*`
permissions. It grants:

- `iam:ListRoles`, which requires `Resource: "*"`. The Terraform lookup uses the
  reserved SSO path and exact permission-set matching; the API path filter is not
  an IAM authorization boundary. This grant permits role metadata discovery
  throughout the account, not role assumption or IAM writes.
- CloudFormation lifecycle and read operations on only the application's
  `<prefix>-cloudwatch-omni` stack.
- Dataset creation and tagging on this account/region's `dataset-integration/*`:
  the service authorizes both creation and its dependent tag permission against
  this wildcard before the integration exists. Read/update/delete/untag operations
  remain scoped to `dataset-integration/default`.
  This singleton resource is shared at account/region scope;
  its execution role limits forwarding to the application's log groups.
- `iam:PassRole` for the exact space-access role to `cloudwatch.amazonaws.com`
  and the exact Dataset-forwarding role to `logs.amazonaws.com`.

Repair only the intended environment; prod uses its own account and role.
Use IAM policy validation and simulation to check required positive cases and
that unrelated stacks, roles, services, and Dataset integrations remain denied.
Simulation is supporting evidence, not proof that a deployment will succeed.

After provisioning, rerun the latest normal deployment through CI. Check that
SSO role discovery succeeds, the Omni stack and Dataset integration complete,
and the intended staff grant is installed. Terraform plan/apply runs only in CI.
Committing this template alone does not repair the live role.

## References

- [IAM ListRoles](https://docs.aws.amazon.com/IAM/latest/APIReference/API_ListRoles.html)
- [Omni IAM permissions](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/omni-iam-policies-to-use-cloudwatch-omni.html)
- [Observability Admin authorization](https://docs.aws.amazon.com/service-authorization/latest/reference/list_observabilityadmin.html)
