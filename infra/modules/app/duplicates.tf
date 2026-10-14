# Shadow-only duplicate evaluation. No existing analysis handler or queue changes.
variable "enable_duplicate_detection" {
  type        = bool
  default     = false
  description = "Enable isolated shadow evaluation only after analyzer comparison deployment and key provisioning."
}
variable "duplicate_analyzer_base_url" {
  type        = string
  default     = ""
  description = "Separate comparison service base URL; empty uses the existing analyzer base URL."
}
resource "aws_secretsmanager_secret" "duplicate_analyzer_key" {
  name        = "${local.name_prefix}-duplicate-analyzer-key"
  description = "Dedicated analyzer comparison key; value provisioned out-of-band, never Terraform state."
  kms_key_id  = aws_kms_key.app.arn
  tags        = var.tags
}
resource "aws_sqs_queue" "duplicates_dlq" {
  name                      = "${local.name_prefix}-duplicates-dlq"
  kms_master_key_id         = aws_kms_key.app.arn
  message_retention_seconds = 1209600
  tags                      = var.tags
}
resource "aws_sqs_queue" "duplicates" {
  name                       = "${local.name_prefix}-duplicates"
  kms_master_key_id          = aws_kms_key.app.arn
  visibility_timeout_seconds = 5400
  message_retention_seconds  = 1209600
  redrive_policy             = jsonencode({ deadLetterTargetArn = aws_sqs_queue.duplicates_dlq.arn, maxReceiveCount = 5 })
  tags                       = var.tags
}
data "archive_file" "duplicate_dispatch" {
  type        = "zip"
  source_dir  = "${path.module}/../../../backend/dist/duplicate-dispatch"
  output_path = "${path.module}/dist/duplicate-dispatch.zip"
}
data "archive_file" "duplicate_worker" {
  type        = "zip"
  source_dir  = "${path.module}/../../../backend/dist/duplicate-worker"
  output_path = "${path.module}/dist/duplicate-worker.zip"
}
resource "aws_cloudwatch_log_group" "duplicates" {
  for_each          = toset(["duplicate-dispatch", "duplicate-worker"])
  name              = "/aws/lambda/${local.name_prefix}-${each.key}"
  retention_in_days = 365
  kms_key_id        = aws_kms_key.app.arn
  tags              = var.tags
}
resource "aws_iam_role" "duplicate_dispatch" {
  name               = "${local.name_prefix}-duplicate-dispatch"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
  tags               = var.tags
}
resource "aws_iam_role" "duplicate_worker" {
  name               = "${local.name_prefix}-duplicate-worker"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
  tags               = var.tags
}
resource "aws_iam_role_policy" "duplicate_dispatch" {
  role = aws_iam_role.duplicate_dispatch.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["dynamodb:DescribeStream", "dynamodb:GetRecords", "dynamodb:GetShardIterator", "dynamodb:ListStreams"], Resource = aws_dynamodb_table.app.stream_arn },
    { Effect = "Allow", Action = ["dynamodb:PutItem"], Resource = aws_dynamodb_table.app.arn },
    { Effect = "Allow", Action = ["sqs:SendMessage"], Resource = [aws_sqs_queue.duplicates.arn, aws_sqs_queue.duplicates_dlq.arn] },
    { Effect = "Allow", Action = ["kms:Decrypt", "kms:GenerateDataKey"], Resource = aws_kms_key.app.arn },
    { Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.duplicates["duplicate-dispatch"].arn}:*" }
  ] })
}
resource "aws_iam_role_policy" "duplicate_worker" {
  role = aws_iam_role.duplicate_worker.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query", "dynamodb:ConditionCheckItem"], Resource = aws_dynamodb_table.app.arn },
    { Effect = "Allow", Action = ["s3:GetObject"], Resource = "${aws_s3_bucket.uploads.arn}/*" },
    { Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = aws_secretsmanager_secret.duplicate_analyzer_key.arn },
    { Effect = "Allow", Action = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:SendMessage"], Resource = aws_sqs_queue.duplicates.arn },
    { Effect = "Allow", Action = ["kms:Decrypt", "kms:GenerateDataKey"], Resource = aws_kms_key.app.arn },
    { Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.duplicates["duplicate-worker"].arn}:*" }
  ] })
}
resource "aws_lambda_function" "duplicate_dispatch" {
  function_name    = "${local.name_prefix}-duplicate-dispatch"
  role             = aws_iam_role.duplicate_dispatch.arn
  runtime          = "nodejs22.x"
  handler          = "index.handler"
  filename         = data.archive_file.duplicate_dispatch.output_path
  source_code_hash = data.archive_file.duplicate_dispatch.output_base64sha256
  memory_size      = 256
  timeout          = 30
  environment { variables = { DUPLICATE_QUEUE_URL = aws_sqs_queue.duplicates.url, DYNAMO_TABLE = aws_dynamodb_table.app.name } }
  depends_on = [aws_iam_role_policy.duplicate_dispatch, aws_cloudwatch_log_group.duplicates]
  tags       = var.tags
}
resource "aws_lambda_function" "duplicate_worker" {
  function_name    = "${local.name_prefix}-duplicate-worker"
  role             = aws_iam_role.duplicate_worker.arn
  runtime          = "nodejs22.x"
  handler          = "index.handler"
  filename         = data.archive_file.duplicate_worker.output_path
  source_code_hash = data.archive_file.duplicate_worker.output_base64sha256
  memory_size      = 1024
  timeout          = 900
  environment { variables = {
    DYNAMO_TABLE                          = aws_dynamodb_table.app.name
    S3_UPLOAD_BUCKET                      = aws_s3_bucket.uploads.bucket
    DUPLICATE_QUEUE_URL                   = aws_sqs_queue.duplicates.url
    DUPLICATE_ANALYZER_BASE_URL           = var.duplicate_analyzer_base_url != "" ? var.duplicate_analyzer_base_url : var.analyzer_base_url
    DUPLICATE_ANALYZER_API_KEY_SECRET_ARN = aws_secretsmanager_secret.duplicate_analyzer_key.arn
    DUPLICATE_COMPARISON_CACHE_VERSION    = "image-comparison-v1"
  } }
  depends_on = [aws_iam_role_policy.duplicate_worker, aws_cloudwatch_log_group.duplicates]
  tags       = var.tags
}
resource "aws_lambda_event_source_mapping" "duplicate_analysis_stream" {
  event_source_arn               = aws_dynamodb_table.app.stream_arn
  function_name                  = aws_lambda_function.duplicate_dispatch.arn
  enabled                        = var.enable_duplicate_detection
  starting_position              = "TRIM_HORIZON"
  batch_size                     = 10
  bisect_batch_on_function_error = true
  maximum_retry_attempts         = 10
  maximum_record_age_in_seconds  = 86400
  function_response_types        = ["ReportBatchItemFailures"]
  destination_config {
    on_failure {
      destination_arn = aws_sqs_queue.duplicates_dlq.arn
    }
  }
  filter_criteria {
    filter {
      pattern = jsonencode({
        eventName = ["INSERT", "MODIFY"]
        dynamodb  = { NewImage = { sk = { S = [{ prefix = "CHECK#" }, { prefix = "DUP_OBSERVATION#" }] } } }
      })
    }
  }
}
resource "aws_lambda_event_source_mapping" "duplicate_queue" {
  event_source_arn        = aws_sqs_queue.duplicates.arn
  function_name           = aws_lambda_function.duplicate_worker.arn
  enabled                 = var.enable_duplicate_detection
  batch_size              = 1
  function_response_types = ["ReportBatchItemFailures"]
  scaling_config { maximum_concurrency = 2 }
}
resource "aws_cloudwatch_metric_alarm" "duplicate_dead_letters" {
  alarm_name          = "${local.name_prefix}-duplicate-dead-letters"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  dimensions          = { QueueName = aws_sqs_queue.duplicates_dlq.name }
  tags                = var.tags
}
