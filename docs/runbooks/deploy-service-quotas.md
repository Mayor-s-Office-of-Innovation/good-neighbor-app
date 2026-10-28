# Deployment-role Service Quotas reads

Terraform reads the regional API Gateway `Throttle rate` and `Throttle burst
rate` quotas in `infra/modules/app/api.tf`. The AWS provider resolves each
`quota_name` using `ListAWSDefaultServiceQuotas`, then reads the applied value
using `GetServiceQuota`. Both calls need deployment-role permission even when
the plan would make no infrastructure changes.

An `AccessDeniedException` for either call stops the plan before apply. This
caused [dev deploy 40605310817](https://github.com/Mayor-s-Office-of-Innovation/good-neighbor-app/actions/runs/40605310817).

## Repair the externally owned role

The deployment role's administrator must provision
`infra/policies/deploy-service-quotas-read.json.tftpl` through the authoritative
role infrastructure. Application Terraform cannot bootstrap the permission:
the deployment role explicitly denies modifying its own IAM policies.

Render `account_id` from the target GitHub Environment's `AWS_ACCOUNT_ID` secret
and `aws_region` from its `AWS_REGION` variable. For the failed dev deployment,
the role is `good-neighbor-app-deploy-dev`. Provision prod separately using its
own account and region; repairing dev does not repair prod.

The policy grants only:

- `servicequotas:ListAWSDefaultServiceQuotas` in the deployment region. This
  API does not support resource-level permissions, so `Resource` must be `*`.
- `servicequotas:GetServiceQuota` on the two API Gateway throttle quota ARNs:
  `L-8A5B8E43` (rate) and `L-CDF5615A` (burst).

It grants no quota-increase or IAM-write permissions. Preserve the role's trust
policy, existing permissions, and bootstrap/self-mutation denies. Do not replace
the role's existing deployment policy with this supplemental policy.

After the administrator provisions it, rerun the failed deploy job (or the
latest normal dev deployment if newer changes have superseded it). Verify that
both quota data sources read successfully and the plan proceeds to apply.
Run Terraform plan/apply only in CI. Merging these policy/runbook files alone
does not install the live role permission.

## References

- [AWS provider quota data-source implementation](https://github.com/hashicorp/terraform-provider-aws/blob/v6.68.0/internal/service/servicequotas/service_quota_data_source.go)
- [AWS Service Quotas IAM action and resource support](https://docs.aws.amazon.com/service-authorization/latest/reference/list_service-quotas.html)
