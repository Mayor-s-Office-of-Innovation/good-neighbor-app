# Read-only role for plan-dev.yml, so a person can read a plan before anything changes.
# Any job in the plan Environment can assume it from any branch, so that Environment's
# required reviewers decide who can read the dev state.

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
    # These return residents' and staff data, and a plan never calls them. Not
    # lambda:GetFunction: refreshing every aws_lambda_function needs it.
    sid    = "DenyDataReads"
    effect = "Deny"
    actions = [
      "cloudtrail:LookupEvents",
      "cognito-idp:AdminGetDevice",
      "cognito-idp:AdminGetUser",
      "cognito-idp:AdminListDevices",
      "cognito-idp:AdminListGroupsForUser",
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
      "ses:GetSuppressedDestination",
      "ses:ListSuppressedDestinations",
      "sqs:ReceiveMessage",
      "xray:BatchGetTraces",
    ]
    resources = ["*"]
  }

  statement {
    # Parameter values and other apps' Lambda environments can hold secrets, and
    # this module reads neither. Refreshing its own Lambdas calls GetFunction and
    # ListVersionsByFunction, so those stay readable.
    sid           = "DenyOtherSecretReads"
    effect        = "Deny"
    actions       = ["lambda:GetFunction*", "lambda:ListVersionsByFunction", "ssm:GetParameter*"]
    not_resources = ["arn:aws:lambda:*:*:function:${local.name_prefix}-*"]
  }

  statement {
    # Returns every app's Lambda environment and can't be scoped; refresh never calls it.
    sid       = "DenyListAllFunctions"
    effect    = "Deny"
    actions   = ["lambda:ListFunctions"]
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
