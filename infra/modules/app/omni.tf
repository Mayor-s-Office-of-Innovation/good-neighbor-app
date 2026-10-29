# CloudWatch Omni, scoped to this application. Context: docs/runbooks/observability.md.
#
# Omni is a front end on the CloudWatch data this module already produces; it
# adds nothing to ingestion. Everything here is off unless
# enable_cloudwatch_omni is set, so prod stays untouched until dev proves it.
#
# The AWS account hosts other applications. Omni is account+Region scoped
# (one space and one Dataset integration per account per Region), so the
# isolation lives in two IAM roles, both written here rather than taken
# from the console wizard:
#
# - The Dataset integration execution role decides which log groups forward
#   into Omni. Its logs:IntegrateWithDataset statement names this module's
#   log groups one by one; nothing else in the account forwards.
# - The space data-access role carries only CloudWatchOmniSpaceAccessPolicy.
#   The optional CloudWatchOmniAWSIntegrationPolicy (Context Graph) is left
#   off on purpose: it inventories every resource in the account through an
#   AWS Config recorder.
#
# What this cannot narrow: Omni reads CloudWatch Metrics directly, and metric
# reads have no per-namespace IAM scoping, so a member can browse other
# applications' metrics in the space. Grant membership accordingly.
#
# Not forwarded, by design: the us-east-1 WAF log group (Omni is per Region),
# the SES Mail Manager log group (vended delivery logs, not app telemetry).

locals {
  omni_domain_name = var.cloudwatch_omni_domain_name != "" ? var.cloudwatch_omni_domain_name : local.name_prefix

  # Every Standard-class log group this module owns in the home Region.
  omni_forwarded_log_group_arns = concat(
    [
      aws_cloudwatch_log_group.api.arn,
      aws_cloudwatch_log_group.worker.arn,
      aws_cloudwatch_log_group.intake.arn,
      aws_cloudwatch_log_group.authorizer.arn,
      aws_cloudwatch_log_group.analysis.arn,
      aws_cloudwatch_log_group.support.arn,
      aws_cloudwatch_log_group.api_gw.arn,
      aws_cloudwatch_log_group.analytics_export.arn,
      aws_cloudwatch_log_group.analytics_convert.arn,
      aws_cloudwatch_log_group.analytics_report.arn,
      aws_cloudwatch_log_group.analytics_query.arn,
    ],
    values(aws_cloudwatch_log_group.duplicates)[*].arn,
    aws_cloudwatch_log_group.cognito_email_sender[*].arn,
  )
}

# ---------------------------------------------------------------------------
# Domain: the sign-in URL. IAM sign-in (console deep link) by default; pass an
# IAM Identity Center instance ARN to add IdP sign-in for non-IAM staff.
# ---------------------------------------------------------------------------

# CCSF tag exception: the domain has no tags argument (provider 6.71) and
# CloudWatch Omni exposes no tagging API for it. The IAM roles, Dataset
# integration, and grants below all carry var.tags.
resource "aws_cloudwatchomni_domain" "app" {
  count = var.enable_cloudwatch_omni ? 1 : 0

  name               = local.omni_domain_name
  identity_providers = var.cloudwatch_omni_identity_center_instance_arn != "" ? ["IAM", "IDC"] : ["IAM"]

  dynamic "identity_provider_configuration" {
    for_each = var.cloudwatch_omni_identity_center_instance_arn != "" ? [1] : []
    content {
      identity_center_configuration {
        identity_center_instance_arn = var.cloudwatch_omni_identity_center_instance_arn
      }
    }
  }
}

# ---------------------------------------------------------------------------
# Space data-access role: what the space itself may do in this account.
# Trust policy per the Omni confused-deputy guidance.
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "omni_space_assume" {
  count = var.enable_cloudwatch_omni ? 1 : 0

  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole", "sts:TagSession", "sts:SetSourceIdentity", "sts:SetContext"]

    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_iam_role" "omni_space_access" {
  count = var.enable_cloudwatch_omni ? 1 : 0

  name               = "${local.name_prefix}-omni-space-access"
  assume_role_policy = data.aws_iam_policy_document.omni_space_assume[0].json
  # The console wizard sets the same policy as the boundary on the role it
  # creates; mirror that so nothing attached later can widen the space.
  permissions_boundary = "arn:aws:iam::aws:policy/CloudWatchOmniSpaceAccessPolicy"
  tags                 = var.tags
}

resource "aws_iam_role_policy_attachment" "omni_space_access" {
  count = var.enable_cloudwatch_omni ? 1 : 0

  role       = aws_iam_role.omni_space_access[0].name
  policy_arn = "arn:aws:iam::aws:policy/CloudWatchOmniSpaceAccessPolicy"
}

# ---------------------------------------------------------------------------
# Space: one per account per Region. AWS-owned encryption at rest; customer
# managed keys for the Dataset are enabled per account by AWS and not
# assumed here.
# ---------------------------------------------------------------------------

# CCSF tag exception: same as the domain; the space resource has no tags
# argument and the service does not return or accept tags on spaces.
resource "aws_cloudwatchomni_space" "app" {
  count = var.enable_cloudwatch_omni ? 1 : 0

  name                 = local.name_prefix
  domain_id            = aws_cloudwatchomni_domain.app[0].domain_id
  data_access_role_arn = aws_iam_role.omni_space_access[0].arn

  depends_on = [aws_iam_role_policy_attachment.omni_space_access]
}

# ---------------------------------------------------------------------------
# Dataset integration: forwards logs into the space. The execution role's
# resource list is the allowlist of what Omni can see from CloudWatch Logs.
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "omni_forwarding_assume" {
  count = var.enable_cloudwatch_omni ? 1 : 0

  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["logs.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:aws:observabilityadmin:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:dataset-integration/default"]
    }
  }
}

data "aws_iam_policy_document" "omni_forwarding" {
  count = var.enable_cloudwatch_omni ? 1 : 0

  statement {
    sid       = "ForwardOnlyThisApplicationsLogGroups"
    effect    = "Allow"
    actions   = ["logs:IntegrateWithDataset"]
    resources = local.omni_forwarded_log_group_arns
  }

  statement {
    # cloudwatch:PutRecords has no resource type; "*" is the documented form.
    sid       = "WriteIntoTheDataset"
    effect    = "Allow"
    actions   = ["cloudwatch:PutRecords"]
    resources = ["*"]
  }
}

resource "aws_iam_role" "omni_forwarding" {
  count = var.enable_cloudwatch_omni ? 1 : 0

  name               = "${local.name_prefix}-omni-dataset-forwarding"
  assume_role_policy = data.aws_iam_policy_document.omni_forwarding_assume[0].json
  tags               = var.tags
}

resource "aws_iam_role_policy" "omni_forwarding" {
  count = var.enable_cloudwatch_omni ? 1 : 0

  name   = "forward-app-log-groups"
  role   = aws_iam_role.omni_forwarding[0].id
  policy = data.aws_iam_policy_document.omni_forwarding[0].json
}

resource "aws_observabilityadmin_dataset_integration" "app" {
  count = var.enable_cloudwatch_omni ? 1 : 0

  role_arn = aws_iam_role.omni_forwarding[0].arn
  tags     = var.tags

  depends_on = [
    aws_cloudwatchomni_space.app,
    aws_iam_role_policy.omni_forwarding,
  ]
}

# ---------------------------------------------------------------------------
# Members. The identity that applies this (the CI deploy role) becomes the
# first Space Admin automatically; everyone else is granted here so access
# is reviewable in Git rather than in the Omni UI.
#
# Staff sign in through IAM Identity Center, which lands them in a shared
# IAM role per permission set (AWSReservedSSO_<PermissionSet>_<hash>, under
# the /aws-reserved/sso.amazonaws.com/ path). A grant on that role covers
# everyone who holds the permission set in this account, which is the
# intended audience. The hash differs per account, so look the role up by
# name rather than hardcoding an ARN.
# ---------------------------------------------------------------------------

# One listing of every reserved Identity Center role, matched with a fixed
# pattern. The configured permission-set names are never placed in a regex:
# Identity Center allows "." and "+" in them, which a regex would read as
# wildcards and could match another team's role.
data "aws_iam_roles" "omni_sso" {
  count = var.enable_cloudwatch_omni && length(var.cloudwatch_omni_sso_permission_sets) > 0 ? 1 : 0

  name_regex  = "^AWSReservedSSO_"
  path_prefix = "/aws-reserved/sso.amazonaws.com/"
}

locals {
  # Role name is the last ARN segment: AWSReservedSSO_<PermissionSet>_<hex>.
  # Exact string match on the prefix, and the remainder must be the hex
  # suffix alone, so "Power" cannot match "Power_Admin_<hex>".
  omni_sso_role_arns = {
    for set_name in keys(var.enable_cloudwatch_omni ? var.cloudwatch_omni_sso_permission_sets : {}) :
    set_name => [
      for arn in try(data.aws_iam_roles.omni_sso[0].arns, []) : arn
      if startswith(element(split("/", arn), length(split("/", arn)) - 1), "AWSReservedSSO_${set_name}_")
      && can(regex("^[0-9a-f]+$", trimprefix(element(split("/", arn), length(split("/", arn)) - 1), "AWSReservedSSO_${set_name}_")))
    ]
  }
}

resource "aws_cloudwatchomni_access_grant" "sso" {
  for_each = var.enable_cloudwatch_omni ? var.cloudwatch_omni_sso_permission_sets : {}

  name       = "sso-${lower(each.key)}"
  domain_id  = aws_cloudwatchomni_domain.app[0].domain_id
  space_id   = aws_cloudwatchomni_space.app[0].space_id
  permission = each.value

  principal {
    principal_type = "IAM_ROLE"
    principal_id   = one(local.omni_sso_role_arns[each.key])
  }

  tags = var.tags

  lifecycle {
    precondition {
      condition     = length(local.omni_sso_role_arns[each.key]) == 1
      error_message = "Expected exactly one Identity Center role for permission set ${each.key} in this account; found ${length(local.omni_sso_role_arns[each.key])}. Check the permission set name or that Identity Center is provisioned here."
    }
  }
}

resource "aws_cloudwatchomni_access_grant" "members" {
  for_each = var.enable_cloudwatch_omni ? var.cloudwatch_omni_members : {}

  name       = each.key
  domain_id  = aws_cloudwatchomni_domain.app[0].domain_id
  space_id   = aws_cloudwatchomni_space.app[0].space_id
  permission = each.value.permission

  principal {
    principal_type = each.value.principal_type
    principal_id   = each.value.principal_id
  }

  tags = var.tags
}
