# Foreground perimeter evidence gets its own capacity so translations and other
# background jobs cannot occupy its slots. Existing submissions keep draining on
# the legacy worker during rollout. Account quotas must support this reservation
# in addition to all other functions/environments and the analyzer itself.
resource "aws_sqs_queue" "analysis" {
  name                       = "${local.name_prefix}-analysis"
  kms_master_key_id          = aws_kms_key.app.arn
  message_retention_seconds  = 345600
  visibility_timeout_seconds = 1800 # Six times the worker timeout.
  tags                       = var.tags
}

resource "aws_sqs_queue" "analysis_dlq" {
  name                      = "${local.name_prefix}-analysis-dlq"
  kms_master_key_id         = aws_kms_key.app.arn
  message_retention_seconds = 1209600
  tags                      = var.tags
}

resource "aws_sqs_queue_redrive_policy" "analysis" {
  queue_url = aws_sqs_queue.analysis.id
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.analysis_dlq.arn
    maxReceiveCount     = 5
  })
}

resource "aws_cloudwatch_log_group" "analysis" {
  name              = "/aws/lambda/${local.name_prefix}-analysis"
  retention_in_days = 365
  kms_key_id        = aws_kms_key.app.arn
  tags              = var.tags
}

resource "aws_lambda_function" "analysis" {
  #checkov:skip=CKV_AWS_117:Analyzer and AWS APIs require public egress; no VPC-only data.
  #checkov:skip=CKV_AWS_272:Code signing not set up for this app yet; tracked follow-up.
  function_name                  = "${local.name_prefix}-analysis"
  role                           = aws_iam_role.worker.arn
  runtime                        = "nodejs24.x"
  handler                        = "index.handler"
  filename                       = data.archive_file.worker.output_path
  source_code_hash               = data.archive_file.worker.output_base64sha256
  memory_size                    = 1024
  timeout                        = 300
  reserved_concurrent_executions = 500
  kms_key_arn                    = aws_kms_key.app.arn

  tracing_config {
    mode = "Active"
  }
  dead_letter_config {
    target_arn = aws_sqs_queue.analysis_dlq.arn
  }
  environment {
    # Keep SQS_QUEUE_URL pointing at submissions: analysis enqueues follow-up
    # translations there, outside this foreground reservation.
    variables = aws_lambda_function.worker.environment[0].variables
  }
  depends_on = [aws_cloudwatch_log_group.analysis, aws_iam_role_policy.worker]
  tags       = var.tags
}

resource "aws_lambda_event_source_mapping" "analysis" {
  event_source_arn                   = aws_sqs_queue.analysis.arn
  function_name                      = aws_lambda_function.analysis.arn
  batch_size                         = 1
  maximum_batching_window_in_seconds = 0
  function_response_types            = ["ReportBatchItemFailures"]
  # Exactly one analysis per invocation; reservation matches this sole trigger.
  # This is a ceiling, not provisioned/warm SQS polling capacity.
  scaling_config {
    maximum_concurrency = 500
  }
  depends_on = [aws_iam_role_policy.worker]
}
