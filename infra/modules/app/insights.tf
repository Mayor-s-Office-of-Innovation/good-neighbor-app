# Apart from analytics.tf, so Insights can change without touching the lake export.

# ---- Job files ----------------------------------------------------------------

resource "aws_s3_bucket" "insights_jobs" {
  # checkov:skip=CKV_AWS_18:Server-access logs would record the IP of every presigned download for a year with no field selection; nothing reads them.
  # checkov:skip=CKV_AWS_21:Job files last a day and a rerun rebuilds them, so old versions recover nothing.
  bucket_prefix = "${local.bucket_name_prefix}-insights-jobs-"
  force_destroy = false
  tags          = var.tags
}

resource "aws_s3_bucket_public_access_block" "insights_jobs" {
  bucket                  = aws_s3_bucket.insights_jobs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

data "aws_iam_policy_document" "insights_jobs_tls_only" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.insights_jobs.arn,
      "${aws_s3_bucket.insights_jobs.arn}/*",
    ]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "insights_jobs_tls_only" {
  bucket     = aws_s3_bucket.insights_jobs.id
  policy     = data.aws_iam_policy_document.insights_jobs_tls_only.json
  depends_on = [aws_s3_bucket_public_access_block.insights_jobs]
}

resource "aws_s3_bucket_server_side_encryption_configuration" "insights_jobs" {
  bucket = aws_s3_bucket.insights_jobs.id

  rule {
    apply_server_side_encryption_by_default {
      kms_master_key_id = aws_kms_key.app.arn
      sse_algorithm     = "aws:kms"
    }
  }
}

resource "aws_s3_bucket_versioning" "insights_jobs" {
  bucket = aws_s3_bucket.insights_jobs.id

  versioning_configuration {
    status = "Disabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "insights_jobs" {
  bucket = aws_s3_bucket.insights_jobs.id

  rule {
    # The shortest S3 allows. It rounds to UTC midnight, so files last 24-48 h,
    # past JOB_LIMITS.ttlMs in jobs.js, which has already stopped serving them.
    id     = "expire-job-files"
    status = "Enabled"

    filter {
      prefix = ""
    }

    expiration {
      days = 1
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

# ---- Job queue ----------------------------------------------------------------

resource "aws_sqs_queue" "insights_jobs_dlq" {
  name                      = "${local.name_prefix}-insights-jobs-dlq"
  kms_master_key_id         = aws_kms_key.app.arn
  message_retention_seconds = 1209600 # 14 days
  tags                      = var.tags
}

resource "aws_sqs_queue" "insights_jobs" {
  name              = "${local.name_prefix}-insights-jobs"
  kms_master_key_id = aws_kms_key.app.arn
  # A job expires after a day, so an older message has nothing left to run.
  message_retention_seconds = 86400
  # Six times the jobs Lambda's timeout, as AWS advises, so SQS can't hand a job
  # to a second run before jobs.js gives up on the first (stallMs, 360 s).
  visibility_timeout_seconds = 1800
  # Five, like the other queues, so a few throttled deliveries can't dead-letter
  # a job that never ran.
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.insights_jobs_dlq.arn
    maxReceiveCount     = 5
  })
  tags = var.tags
}

resource "aws_lambda_event_source_mapping" "insights_jobs" {
  event_source_arn = aws_sqs_queue.insights_jobs.arn
  function_name    = aws_lambda_function.insights_jobs.arn
  # One job per invocation, so a large export gets the jobs Lambda's whole 5 minutes.
  batch_size              = 1
  function_response_types = ["ReportBatchItemFailures"]

  # Matches the function's reservation, so a burst of exports waits in the queue
  # instead of being throttled towards the DLQ.
  scaling_config {
    maximum_concurrency = 2
  }
}

resource "aws_cloudwatch_log_group" "insights_jobs" {
  name              = "/aws/lambda/${local.name_prefix}-insights-jobs"
  retention_in_days = 365
  kms_key_id        = aws_kms_key.app.arn
  tags              = var.tags
}

# The analytics_query bundle in its own function, because that one's 29 s timeout
# exists for API Gateway, and SQS has no such limit.
resource "aws_lambda_function" "insights_jobs" {
  #checkov:skip=CKV_AWS_116:SQS-invoked; failed jobs redeliver and dead-letter through the queue's redrive policy, so a Lambda DLQ is N/A.
  #checkov:skip=CKV_AWS_117:No VPC — needs S3 API egress; revisit with VPC + endpoints.
  #checkov:skip=CKV_AWS_272:Code signing not set up for this app yet; tracked follow-up.
  function_name    = "${local.name_prefix}-insights-jobs"
  role             = aws_iam_role.insights_jobs.arn
  runtime          = "nodejs24.x"
  handler          = "index.handler"
  filename         = data.archive_file.analytics_query.output_path
  source_code_hash = data.archive_file.analytics_query.output_base64sha256
  memory_size      = 2048
  # jobs.test.js holds this under JOB_LIMITS.stallMs and the visibility timeout.
  timeout                        = 300
  kms_key_arn                    = aws_kms_key.app.arn
  reserved_concurrent_executions = 2

  tracing_config {
    mode = "Active"
  }

  environment {
    variables = {
      LAKE_BUCKET          = aws_s3_bucket.analytics_lake.bucket
      INSIGHTS_JOBS_BUCKET = aws_s3_bucket.insights_jobs.bucket
      # Unused for sending here, but on Lambda jobs stay off without it.
      INSIGHTS_JOBS_QUEUE_URL = aws_sqs_queue.insights_jobs.url
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.insights_jobs,
    aws_iam_role_policy.insights_jobs,
  ]
  tags = var.tags
}

resource "aws_iam_role" "insights_jobs" {
  name               = "${local.name_prefix}-insights-jobs"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
  tags               = var.tags
}

data "aws_iam_policy_document" "insights_jobs" {
  statement {
    # ListBucket makes S3 answer a missing file with NoSuchKey, not 403. It lists
    # key names across the whole bucket; GetObject stays on projections/.
    sid       = "ReadProjections"
    effect    = "Allow"
    actions   = ["s3:GetObject", "s3:ListBucket"]
    resources = [aws_s3_bucket.analytics_lake.arn, "${aws_s3_bucket.analytics_lake.arn}/projections/*"]
  }

  statement {
    sid       = "UseJobFiles"
    effect    = "Allow"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.insights_jobs.arn}/*"]
  }

  statement {
    # Without it S3 answers a missing job with 403, and the run fails.
    sid       = "ListJobFiles"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.insights_jobs.arn]
  }

  statement {
    sid       = "RunJobs"
    effect    = "Allow"
    actions   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
    resources = [aws_sqs_queue.insights_jobs.arn]
  }

  statement {
    # GenerateDataKey covers job files, which the app key encrypts.
    sid       = "UseAppKey"
    effect    = "Allow"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = [aws_kms_key.app.arn]
  }

  statement {
    sid       = "Logs"
    effect    = "Allow"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.insights_jobs.arn}:*"]
  }

  statement {
    sid       = "XRay"
    effect    = "Allow"
    actions   = ["xray:PutTraceSegments", "xray:PutTelemetryRecords"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "insights_jobs" {
  #checkov:skip=CKV_AWS_355:X-Ray PutTraceSegments/PutTelemetryRecords have no resource-level scope; "*" is required.
  name   = "${local.name_prefix}-insights-jobs"
  role   = aws_iam_role.insights_jobs.id
  policy = data.aws_iam_policy_document.insights_jobs.json
}

# Failed jobs feed the shared ServerError alarm (alarms.tf).
resource "aws_cloudwatch_log_metric_filter" "insights_jobs_errors" {
  name           = "${local.name_prefix}-insights-jobs-server-errors"
  log_group_name = aws_cloudwatch_log_group.insights_jobs.name
  pattern        = "{ $.level = \"ERROR\" }"

  metric_transformation {
    name          = "ServerError"
    namespace     = local.error_namespace
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "insights_jobs_dlq_not_empty" {
  alarm_name          = "${local.name_prefix}-insights-jobs-dlq-not-empty"
  alarm_description   = "An Insights export or report job failed all its deliveries in ${aws_sqs_queue.insights_jobs_dlq.name}. Its requester saw a timeout about 2.5 hours earlier, since each of its 5 deliveries waits out the 30-minute visibility timeout. Check the insights-jobs logs, then redrive or purge the DLQ."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  threshold           = 1
  period              = 300
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  statistic           = "Maximum"
  treat_missing_data  = "notBreaching"

  dimensions = {
    QueueName = aws_sqs_queue.insights_jobs_dlq.name
  }

  alarm_actions = [aws_sns_topic.alarms.arn]
  ok_actions    = [aws_sns_topic.alarms.arn]

  tags = var.tags
}

# One 5-minute period, so it fires at 10-15 minutes, before jobs.js gives up at 15.
resource "aws_cloudwatch_metric_alarm" "insights_jobs_queue_backlog" {
  alarm_name          = "${local.name_prefix}-insights-jobs-queue-backlog"
  alarm_description   = "A message on ${aws_sqs_queue.insights_jobs.name} is more than 10 minutes old. Either jobs are waiting, and jobs.js gives up on a queued job at 15 minutes, or a job died and SQS redelivered it after the 30-minute visibility timeout. Check ${aws_lambda_function.insights_jobs.function_name} error alarms and logs in ${aws_cloudwatch_log_group.insights_jobs.name}."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  threshold           = 600
  period              = 300
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateAgeOfOldestMessage"
  statistic           = "Maximum"
  treat_missing_data  = "notBreaching"

  dimensions = {
    QueueName = aws_sqs_queue.insights_jobs.name
  }

  alarm_actions = [aws_sns_topic.alarms.arn]
  ok_actions    = [aws_sns_topic.alarms.arn]

  tags = var.tags
}

# ---- Projection Lambda (lake Parquet → Insights snapshot) ----------------------

resource "aws_cloudwatch_log_group" "analytics_projection" {
  name              = "/aws/lambda/${local.name_prefix}-analytics-projection"
  retention_in_days = 365
  kms_key_id        = aws_kms_key.app.arn
  tags              = var.tags
}

resource "aws_lambda_function" "analytics_projection" {
  #checkov:skip=CKV_AWS_116:Async destination of the convert Lambda; the next convert rebuilds the whole snapshot, and the lambda_errors and no-publish alarms page on failure, so a Lambda DLQ is N/A.
  #checkov:skip=CKV_AWS_117:No VPC — needs S3 API egress; revisit with VPC + endpoints.
  #checkov:skip=CKV_AWS_272:Code signing not set up for this app yet; tracked follow-up.
  function_name    = "${local.name_prefix}-analytics-projection"
  role             = aws_iam_role.analytics_projection.arn
  runtime          = "nodejs24.x"
  handler          = "index.handler"
  filename         = data.archive_file.analytics_projection.output_path
  source_code_hash = data.archive_file.analytics_projection.output_base64sha256
  # Same footprint as the convert and report Lambdas: DuckDB over the whole lake.
  memory_size = 2048
  timeout     = 600
  # Room for DuckDB to spill past memory, with its limits in publish-projection.js
  # kept under this. The size is a first guess: no real lake has been built here.
  ephemeral_storage {
    size = 2048
  }
  kms_key_arn = aws_kms_key.app.arn
  # One slot, so two converts finishing together can't race on latest.json;
  # Lambda retries the throttled invocation.
  reserved_concurrent_executions = 1

  tracing_config {
    mode = "Active"
  }

  environment {
    variables = {
      LAKE_BUCKET = aws_s3_bucket.analytics_lake.bucket
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.analytics_projection,
    aws_iam_role_policy.analytics_projection,
  ]
  tags = var.tags
}

# Builds queued behind the one slot would otherwise retry for 6 hours; a later
# convert queues a fresh build anyway, and the stalled alarm catches a gap.
resource "aws_lambda_function_event_invoke_config" "analytics_projection" {
  function_name                = aws_lambda_function.analytics_projection.function_name
  maximum_event_age_in_seconds = 3600
  maximum_retry_attempts       = 1
}

# Runs the build after every successful convert, so a snapshot is never much
# older than the last export. The convert Lambda's code doesn't need to know about it.
resource "aws_lambda_function_event_invoke_config" "analytics_convert" {
  function_name = aws_lambda_function.analytics_convert.function_name

  destination_config {
    on_success {
      destination = aws_lambda_function.analytics_projection.arn
    }
  }
}

resource "aws_iam_role" "analytics_projection" {
  name               = "${local.name_prefix}-analytics-projection"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
  tags               = var.tags
}

data "aws_iam_policy_document" "analytics_projection" {
  statement {
    # ListBucket lists key names across the whole bucket; GetObject stays on readings/.
    sid       = "ReadParquetLake"
    effect    = "Allow"
    actions   = ["s3:GetObject", "s3:ListBucket"]
    resources = [aws_s3_bucket.analytics_lake.arn, "${aws_s3_bucket.analytics_lake.arn}/readings/*"]
  }

  statement {
    sid       = "WriteProjections"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.analytics_lake.arn}/projections/*"]
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
    resources = ["${aws_cloudwatch_log_group.analytics_projection.arn}:*"]
  }

  statement {
    sid       = "XRay"
    effect    = "Allow"
    actions   = ["xray:PutTraceSegments", "xray:PutTelemetryRecords"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "analytics_projection" {
  #checkov:skip=CKV_AWS_355:X-Ray PutTraceSegments/PutTelemetryRecords have no resource-level scope; "*" is required.
  name   = "${local.name_prefix}-analytics-projection"
  role   = aws_iam_role.analytics_projection.id
  policy = data.aws_iam_policy_document.analytics_projection.json
}

# Uncaught build errors feed the shared ServerError alarm (alarms.tf), same
# convention as the other analytics Lambdas.
resource "aws_cloudwatch_log_metric_filter" "analytics_projection_errors" {
  name           = "${local.name_prefix}-analytics-projection-server-errors"
  log_group_name = aws_cloudwatch_log_group.analytics_projection.name
  pattern        = "{ $.level = \"ERROR\" }"

  metric_transformation {
    name          = "ServerError"
    namespace     = local.error_namespace
    value         = "1"
    default_value = "0"
  }
}

# No published snapshot for 24-36 h: catches what no error reports, such as convert
# not running at all. Each build logs an InsightsProjectionPublished line.
resource "aws_cloudwatch_log_metric_filter" "insights_projection_published" {
  name           = "${local.name_prefix}-insights-projection-published"
  log_group_name = aws_cloudwatch_log_group.analytics_projection.name
  pattern        = "{ $.marker = \"InsightsProjectionPublished\" }"

  metric_transformation {
    name          = "InsightsProjectionPublished"
    namespace     = local.error_namespace
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "insights_projection_stalled" {
  alarm_name          = "${local.name_prefix}-insights-projection-stalled"
  alarm_description   = "No Insights snapshot published by ${aws_lambda_function.analytics_projection.function_name} for 24 to 36 hours (expected every 6). Insights is showing old data. Check its logs, the analytics-convert logs and the export watchdog; infra/README.md has the manual build step. It also fires right after a first deploy, until that step runs."
  comparison_operator = "LessThanThreshold"
  threshold           = 1
  period              = 43200 # 2 empty 12h periods: 24-36h after the last publish, by where it fell
  evaluation_periods  = 2
  statistic           = "Sum"
  namespace           = local.error_namespace
  metric_name         = "InsightsProjectionPublished"
  treat_missing_data  = "breaching"

  alarm_actions = [aws_sns_topic.alarms.arn]
  ok_actions    = [aws_sns_topic.alarms.arn]

  tags = var.tags
}
