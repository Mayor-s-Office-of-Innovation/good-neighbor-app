# Execution roles for the two Lambdas. Scoped to this env's table / bucket /
# queue / key / secret ARNs — no wildcard resources except X-Ray (which has no
# resource-level permissions), called out with an inline skip.

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

locals {
  dynamo_resources = [
    aws_dynamodb_table.app.arn,
    "${aws_dynamodb_table.app.arn}/index/*",
  ]

  dynamo_actions = [
    "dynamodb:GetItem",
    "dynamodb:BatchGetItem",
    "dynamodb:Query",
    "dynamodb:PutItem",
    "dynamodb:UpdateItem",
    "dynamodb:DeleteItem",
    "dynamodb:BatchWriteItem",
    "dynamodb:ConditionCheckItem",
    "dynamodb:TransactGetItems",
    "dynamodb:TransactWriteItems",
  ]
}

# ---- api Lambda role ----------------------------------------------------------

resource "aws_iam_role" "api" {
  name               = "${local.name_prefix}-api"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
  tags               = var.tags
}

data "aws_iam_policy_document" "api" {
  statement {
    sid       = "Dynamo"
    effect    = "Allow"
    actions   = local.dynamo_actions
    resources = local.dynamo_resources
  }

  statement {
    sid       = "UploadsObjects"
    effect    = "Allow"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${aws_s3_bucket.uploads.arn}/*"]
  }

  statement {
    sid       = "EnqueueSubmissions"
    effect    = "Allow"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.submissions.arn]
  }

  statement {
    sid       = "UseAppKey"
    effect    = "Allow"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = [aws_kms_key.app.arn]
  }

  statement {
    sid       = "ReadPosthogSecret"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.posthog_project_api_key.arn]
  }

  statement {
    sid       = "ReadDeviceTokenSecret"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.device_token_key.arn]
  }

  statement {
    sid       = "ReadAnalyzerSecret"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.analyzer_api_key.arn]
  }

  statement {
    sid       = "ReadSf311Secret"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.sf311_basic_auth.arn]
  }

  statement {
    sid    = "InvokeBedrockDescriptionValidator"
    effect = "Allow"
    actions = [
      "bedrock:InvokeModel",
      "bedrock:InvokeModelWithResponseStream",
    ]
    resources = [
      "arn:aws:bedrock:${data.aws_region.current.name}::foundation-model/${var.bedrock_model_id}",
    ]
  }

  statement {
    sid       = "Logs"
    effect    = "Allow"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.api.arn}:*"]
  }

  statement {
    sid       = "XRay"
    effect    = "Allow"
    actions   = ["xray:PutTraceSegments", "xray:PutTelemetryRecords"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "api" {
  #checkov:skip=CKV_AWS_355:X-Ray PutTraceSegments/PutTelemetryRecords have no resource-level scope; "*" is required.
  #checkov:skip=CKV_AWS_290:Write actions are scoped to this env's own table/bucket/queue ARNs.
  name   = "${local.name_prefix}-api"
  role   = aws_iam_role.api.id
  policy = data.aws_iam_policy_document.api.json
}

# ---- authorizer Lambda role ---------------------------------------------------
# Read-only by design: verify token + one DEVICE# GetItem + read the signing
# key. No write, no S3, no SQS.

resource "aws_iam_role" "authorizer" {
  name               = "${local.name_prefix}-authorizer"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
  tags               = var.tags
}

data "aws_iam_policy_document" "authorizer" {
  statement {
    sid       = "ReadDeviceItems"
    effect    = "Allow"
    actions   = ["dynamodb:GetItem"]
    resources = [aws_dynamodb_table.app.arn]
  }

  statement {
    sid       = "ReadDeviceTokenSecret"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.device_token_key.arn]
  }

  statement {
    sid       = "UseAppKey"
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.app.arn]
  }

  statement {
    sid       = "Logs"
    effect    = "Allow"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.authorizer.arn}:*"]
  }

  statement {
    sid       = "XRay"
    effect    = "Allow"
    actions   = ["xray:PutTraceSegments", "xray:PutTelemetryRecords"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "authorizer" {
  #checkov:skip=CKV_AWS_355:X-Ray PutTraceSegments/PutTelemetryRecords have no resource-level scope; "*" is required.
  name   = "${local.name_prefix}-authorizer"
  role   = aws_iam_role.authorizer.id
  policy = data.aws_iam_policy_document.authorizer.json
}

# ---- worker Lambda role -------------------------------------------------------

resource "aws_iam_role" "worker" {
  name               = "${local.name_prefix}-worker"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
  tags               = var.tags
}

data "aws_iam_policy_document" "worker" {
  statement {
    sid       = "Dynamo"
    effect    = "Allow"
    actions   = local.dynamo_actions
    resources = local.dynamo_resources
  }

  statement {
    sid       = "ReadUploads"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.uploads.arn}/*"]
  }

  statement {
    sid    = "ConsumeQueue"
    effect = "Allow"
    actions = [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
    ]
    resources = [aws_sqs_queue.submissions.arn]
  }

  statement {
    sid       = "SendToDlq"
    effect    = "Allow"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.submissions_dlq.arn]
  }

  statement {
    sid       = "ReadAnalyzerSecret"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.analyzer_api_key.arn]
  }

  statement {
    sid       = "UseAppKey"
    effect    = "Allow"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = [aws_kms_key.app.arn]
  }

  statement {
    sid       = "Logs"
    effect    = "Allow"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.worker.arn}:*"]
  }

  statement {
    sid       = "XRay"
    effect    = "Allow"
    actions   = ["xray:PutTraceSegments", "xray:PutTelemetryRecords"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "worker" {
  #checkov:skip=CKV_AWS_355:X-Ray PutTraceSegments/PutTelemetryRecords have no resource-level scope; "*" is required.
  #checkov:skip=CKV_AWS_290:Write actions are scoped to this env's own table/queue/DLQ ARNs.
  name   = "${local.name_prefix}-worker"
  role   = aws_iam_role.worker.id
  policy = data.aws_iam_policy_document.worker.json
}
