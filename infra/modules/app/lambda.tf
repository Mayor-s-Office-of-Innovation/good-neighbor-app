# The two Lambdas and their SQS wiring. Deployable bundles are produced by
# `npm run build:lambdas` (esbuild → backend/dist/{api,worker}/index.mjs) before
# `terraform plan`; the archive's source_code_hash drives redeploys.

data "archive_file" "api" {
  type        = "zip"
  source_dir  = "${path.module}/../../../backend/dist/api"
  output_path = "${path.module}/dist/api.zip"
}

data "archive_file" "worker" {
  type        = "zip"
  source_dir  = "${path.module}/../../../backend/dist/worker"
  output_path = "${path.module}/dist/worker.zip"
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/aws/lambda/${local.name_prefix}-api"
  retention_in_days = 365
  kms_key_id        = aws_kms_key.app.arn
  tags              = var.tags
}

resource "aws_cloudwatch_log_group" "worker" {
  name              = "/aws/lambda/${local.name_prefix}-worker"
  retention_in_days = 365
  kms_key_id        = aws_kms_key.app.arn
  tags              = var.tags
}

resource "aws_lambda_function" "api" {
  #checkov:skip=CKV_AWS_116:Sync API-Gateway-invoked function; failures return to the caller, so a Lambda DLQ is N/A (the worker keeps a real DLQ).
  #checkov:skip=CKV_AWS_117:No VPC — the function needs public AWS-API egress and holds no VPC-only data; revisit with VPC + endpoints.
  #checkov:skip=CKV_AWS_272:Code signing not set up for this app yet; tracked follow-up.
  function_name                  = "${local.name_prefix}-api"
  role                           = aws_iam_role.api.arn
  runtime                        = "nodejs22.x"
  handler                        = "index.handler"
  filename                       = data.archive_file.api.output_path
  source_code_hash               = data.archive_file.api.output_base64sha256
  memory_size                    = 512
  timeout                        = 29
  kms_key_arn                    = aws_kms_key.app.arn
  reserved_concurrent_executions = 10

  tracing_config {
    mode = "Active"
  }

  environment {
    variables = {
      DYNAMO_TABLE     = aws_dynamodb_table.app.name
      SQS_QUEUE_URL    = aws_sqs_queue.submissions.url
      S3_UPLOAD_BUCKET = aws_s3_bucket.uploads.bucket
      DEMO_SITE_ID     = "demo-site"
    }
  }

  depends_on = [aws_cloudwatch_log_group.api]
  tags       = var.tags
}

resource "aws_lambda_function" "worker" {
  #checkov:skip=CKV_AWS_117:No VPC — the function needs public egress to the analyzer + AWS APIs; revisit with VPC + endpoints.
  #checkov:skip=CKV_AWS_272:Code signing not set up for this app yet; tracked follow-up.
  function_name                  = "${local.name_prefix}-worker"
  role                           = aws_iam_role.worker.arn
  runtime                        = "nodejs22.x"
  handler                        = "index.handler"
  filename                       = data.archive_file.worker.output_path
  source_code_hash               = data.archive_file.worker.output_base64sha256
  memory_size                    = 1024
  timeout                        = 120
  kms_key_arn                    = aws_kms_key.app.arn
  reserved_concurrent_executions = 5

  tracing_config {
    mode = "Active"
  }

  # Async-invoke safety net. SQS-triggered failures redrive via the queue's own
  # redrive policy below; this covers any non-SQS async path.
  dead_letter_config {
    target_arn = aws_sqs_queue.submissions_dlq.arn
  }

  environment {
    variables = {
      DYNAMO_TABLE                = aws_dynamodb_table.app.name
      SQS_QUEUE_URL               = aws_sqs_queue.submissions.url
      S3_UPLOAD_BUCKET            = aws_s3_bucket.uploads.bucket
      ANALYZER_BASE_URL           = var.analyzer_base_url
      ANALYZER_API_KEY_SECRET_ARN = aws_secretsmanager_secret.analyzer_api_key.arn
    }
  }

  depends_on = [aws_cloudwatch_log_group.worker]
  tags       = var.tags
}

# Dead-letter queue for submission/analyze messages that exhaust their retries.
resource "aws_sqs_queue" "submissions_dlq" {
  name                      = "${local.name_prefix}-submissions-dlq"
  kms_master_key_id         = aws_kms_key.app.arn
  message_retention_seconds = 1209600 # 14 days
  tags                      = var.tags
}

resource "aws_sqs_queue_redrive_policy" "submissions" {
  queue_url = aws_sqs_queue.submissions.id

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.submissions_dlq.arn
    maxReceiveCount     = 5
  })
}

resource "aws_lambda_event_source_mapping" "worker" {
  event_source_arn                   = aws_sqs_queue.submissions.arn
  function_name                      = aws_lambda_function.worker.arn
  batch_size                         = 10
  maximum_batching_window_in_seconds = 5
  function_response_types            = ["ReportBatchItemFailures"]
}

resource "aws_lambda_permission" "api_gateway" {
  statement_id  = "AllowApiGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http.execution_arn}/*/*"
}
