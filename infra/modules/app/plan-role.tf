# Read-only role for the plan-only workflow (.github/workflows/plan-dev.yml), so
# a person can read a Terraform plan before anything changes. Only the GitHub
# Environment named in var.plan_role_github_subject can assume it.

locals {
  plan_role_enabled = var.plan_role_github_subject != ""
}

data "aws_iam_policy_document" "plan_assume" {
  count = local.plan_role_enabled ? 1 : 0

  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:oidc-provider/token.actions.githubusercontent.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = [var.plan_role_github_subject]
    }
  }
}

resource "aws_iam_role" "plan" {
  count = local.plan_role_enabled ? 1 : 0

  name               = "${local.name_prefix}-terraform-plan"
  assume_role_policy = data.aws_iam_policy_document.plan_assume[0].json
  tags               = var.tags
}

# Terraform's refresh reads nearly every service, so a hand-kept list would break
# on each new resource type. The deny below keeps it from reading people's data.
resource "aws_iam_role_policy_attachment" "plan_read_only" {
  count = local.plan_role_enabled ? 1 : 0

  role       = aws_iam_role.plan[0].name
  policy_arn = "arn:aws:iam::aws:policy/ReadOnlyAccess"
}

data "aws_iam_policy_document" "plan" {
  count = local.plan_role_enabled ? 1 : 0

  statement {
    # Terraform refreshes this one secret version, which it manages itself.
    sid       = "RefreshSupportOriginSecret"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.support_origin.arn]
  }

  statement {
    sid       = "DecryptSupportOriginSecret"
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.support_origin.arn]
  }

  statement {
    # Lambda returns a function's environment only to a caller who can decrypt it;
    # without this every Lambda would show as an in-place update.
    sid       = "ReadLambdaEnvironments"
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.app.arn]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["lambda.${data.aws_region.current.name}.amazonaws.com"]
    }
  }

  statement {
    # Refresh reads the Omni dataset integration (omni.tf), which ReadOnlyAccess
    # doesn't cover. AWS allows only this one ID per Region.
    sid       = "RefreshOmniDatasetIntegration"
    effect    = "Allow"
    actions   = ["observabilityadmin:GetDatasetIntegration", "observabilityadmin:ListTagsForResource"]
    resources = ["arn:aws:observabilityadmin:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:dataset-integration/default"]
  }

  statement {
    # The data source in support.tf calls it on every plan; it returns a new
    # random string, nothing stored, and has no resource-level scope.
    sid       = "PlanRandomPassword"
    effect    = "Allow"
    actions   = ["secretsmanager:GetRandomPassword"]
    resources = ["*"]
  }

  statement {
    # ReadOnlyAccess also grants these, and they return residents' and staff
    # data. A plan never needs them.
    sid    = "DenyDataReads"
    effect = "Deny"
    actions = [
      "cognito-idp:AdminGetUser",
      "cognito-idp:AdminListUserAuthEvents",
      "cognito-idp:ListUsers",
      "cognito-idp:ListUsersInGroup",
      "dynamodb:BatchGetItem",
      "dynamodb:GetItem",
      "dynamodb:GetRecords",
      "dynamodb:PartiQLSelect",
      "dynamodb:Query",
      "dynamodb:ReadDataForReplication",
      "dynamodb:Scan",
      "logs:FilterLogEvents",
      "logs:GetLogEvents",
      "logs:GetLogRecord",
      "logs:GetQueryResults",
      "logs:StartLiveTail",
      "logs:StartQuery",
      "ses:ListSuppressedDestinations",
      "sqs:ReceiveMessage",
      "xray:BatchGetTraces",
    ]
    resources = ["*"]
  }

  statement {
    # Leaves the state file, which the plan needs.
    sid           = "DenyObjectReads"
    effect        = "Deny"
    actions       = ["s3:GetObject*"]
    not_resources = ["arn:aws:s3:::${var.plan_role_state_object}"]
  }
}

resource "aws_iam_role_policy" "plan" {
  count = local.plan_role_enabled ? 1 : 0

  #checkov:skip=CKV_AWS_355:GetRandomPassword has no resource-level scope; "*" is required.
  name   = "${local.name_prefix}-terraform-plan"
  role   = aws_iam_role.plan[0].id
  policy = data.aws_iam_policy_document.plan[0].json
}
