# New SF311_OUTBOX jobs use isolated capacity. Legacy submissions/DLQ entries
# remain in place and can still be processed by the general worker.
resource "aws_sqs_queue" "sf311" {
  name                       = "${local.name_prefix}-311"
  kms_master_key_id          = aws_kms_key.app.arn
  message_retention_seconds  = 345600
  visibility_timeout_seconds = 1800
  tags                       = var.tags
}

resource "aws_sqs_queue" "sf311_dlq" {
  name                      = "${local.name_prefix}-311-dlq"
  kms_master_key_id         = aws_kms_key.app.arn
  message_retention_seconds = 1209600
  tags                      = var.tags
}

resource "aws_sqs_queue_redrive_policy" "sf311" {
  queue_url = aws_sqs_queue.sf311.id
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.sf311_dlq.arn
    # Keep aligned with MAX_FILING_ATTEMPTS in workers/sf311-job.js.
    maxReceiveCount = 5
  })
}

resource "aws_cloudwatch_log_group" "sf311" {
  name              = "/aws/lambda/${local.name_prefix}-311-worker"
  retention_in_days = 365
  kms_key_id        = aws_kms_key.app.arn
  tags              = var.tags
}

data "archive_file" "sf311" {
  type        = "zip"
  source_dir  = "${path.module}/../../../backend/dist/sf311-worker"
  output_path = "${path.module}/dist/sf311-worker.zip"
}

resource "aws_iam_role" "sf311" {
  name               = "${local.name_prefix}-311-worker"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
  tags               = var.tags
}

data "aws_iam_policy_document" "sf311" {
  statement {
    sid       = "JobTaskAndMediaRecords"
    actions   = ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:ConditionCheckItem"]
    resources = local.dynamo_resources
  }
  statement {
    sid       = "ReadEvidence"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.uploads.arn}/*"]
  }
  statement {
    sid       = "Snapshot311Attachments"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.uploads.arn}/sf311-media/*"]
  }
  statement {
    sid       = "Consume311Queue"
    actions   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ChangeMessageVisibility"]
    resources = [aws_sqs_queue.sf311.arn]
  }
  statement {
    sid       = "AsyncFailureDestination"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.sf311_dlq.arn]
  }
  statement {
    # Filing still uses the existing analyzer classifier when required.
    sid       = "IntegrationSecrets"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.sf311_basic_auth.arn, aws_secretsmanager_secret.analyzer_api_key.arn]
  }
  statement {
    sid       = "UseAppKey"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = [aws_kms_key.app.arn]
  }
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.sf311.arn}:*"]
  }
  statement {
    sid       = "XRay"
    actions   = ["xray:PutTraceSegments", "xray:PutTelemetryRecords"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "sf311" {
  #checkov:skip=CKV_AWS_355:X-Ray write APIs do not support resource-level scope.
  #checkov:skip=CKV_AWS_290:Write permissions are limited to this environment's table, media prefix, queue and key.
  name   = "${local.name_prefix}-311-worker"
  role   = aws_iam_role.sf311.id
  policy = data.aws_iam_policy_document.sf311.json
}

resource "aws_lambda_function" "sf311" {
  #checkov:skip=CKV_AWS_117:Oracle HUB, analyzer and AWS APIs require public egress; no VPC-only data.
  #checkov:skip=CKV_AWS_272:Code signing not configured for this app; tracked follow-up.
  function_name                  = "${local.name_prefix}-311-worker"
  role                           = aws_iam_role.sf311.arn
  runtime                        = "nodejs24.x"
  handler                        = "index.handler"
  filename                       = data.archive_file.sf311.output_path
  source_code_hash               = data.archive_file.sf311.output_base64sha256
  memory_size                    = 1024
  timeout                        = 300
  reserved_concurrent_executions = 5
  kms_key_arn                    = aws_kms_key.app.arn
  tracing_config { mode = "Active" }
  dead_letter_config { target_arn = aws_sqs_queue.sf311_dlq.arn }
  environment {
    variables = merge({
      DYNAMO_TABLE                = aws_dynamodb_table.app.name
      SQS_QUEUE_URL               = aws_sqs_queue.sf311.url
      S3_UPLOAD_BUCKET            = aws_s3_bucket.uploads.bucket
      ANALYZER_BASE_URL           = var.analyzer_base_url
      ANALYZER_API_KEY_SECRET_ARN = aws_secretsmanager_secret.analyzer_api_key.arn
      METRICS_NAMESPACE           = local.metrics_namespace
    }, local.sf311_lambda_environment)
  }
  depends_on = [aws_cloudwatch_log_group.sf311, aws_iam_role_policy.sf311]
  tags       = var.tags
}

resource "aws_lambda_event_source_mapping" "sf311" {
  event_source_arn                   = aws_sqs_queue.sf311.arn
  function_name                      = aws_lambda_function.sf311.arn
  batch_size                         = 1
  maximum_batching_window_in_seconds = 0
  function_response_types            = ["ReportBatchItemFailures"]
  scaling_config { maximum_concurrency = 5 }
  depends_on = [aws_iam_role_policy.sf311]
  tags       = var.tags
}
