# Citywide analytics read plane (ADR 0013): scheduled DynamoDB PITR exports →
# entity-split Parquet in the lake bucket → DuckDB report Lambda. Purely
# additive: nothing here writes to the app table; the export is a PITR read
# (`dynamodb:ExportTableToPointInTime`), so app paths and capacity are untouched.
#
# Deployable bundles come from `npm run build:lambdas` (see backend/scripts/
# build-lambdas.mjs) — export/convert/report entries land in
# backend/dist/{analytics-export,analytics-convert,analytics-report}/.
#
# The watermark (previous ExportToTime) lives in the same single table as
# `ANALYTICS#EXPORT` / `#WATERMARK` — one tiny item, no extra store.

# ---- Lake bucket --------------------------------------------------------------

resource "aws_s3_bucket" "analytics_lake" {
  # checkov:skip=CKV_AWS_21:ADR 0013 — the lake is regenerable by design. Parquet
  # is re-derivable from re-running the converter over retained raw exports, and
  # raw/ itself is an ephemeral 30-day buffer for a write-once export feed (the
  # export service overwrites by export ID; stale versions would double-count in
  # reads since globs match every object). Versioning adds cost/ops with no
  # recovery benefit here; the app-data buckets (frontend/uploads) keep it on.
  bucket_prefix = "${local.bucket_name_prefix}-analytics-lake-"
  force_destroy = false
}

resource "aws_s3_bucket_public_access_block" "analytics_lake" {
  bucket                  = aws_s3_bucket.analytics_lake.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "analytics_lake" {
  bucket = aws_s3_bucket.analytics_lake.id

  rule {
    apply_server_side_encryption_by_default {
      kms_master_key_id = aws_kms_key.app.arn
      sse_algorithm     = "aws:kms"
    }
  }
}

resource "aws_s3_bucket_versioning" "analytics_lake" {
  bucket = aws_s3_bucket.analytics_lake.id

  versioning_configuration {
    status = "Disabled"
  }
}

resource "aws_s3_bucket_logging" "analytics_lake" {
  bucket = aws_s3_bucket.analytics_lake.id

  target_bucket = aws_s3_bucket.access_logs.id
  target_prefix = "analytics-lake/"
}

resource "aws_s3_bucket_lifecycle_configuration" "analytics_lake" {
  bucket = aws_s3_bucket.analytics_lake.id

  rule {
    id     = "expire-raw-exports"
    status = "Enabled"

    filter {
      prefix = "raw/"
    }

    # ADR 0013: converted Parquet is the system of record; raw exports are kept
    # 30 days so the converter can be re-run after a schema change. (Older
    # history keeps the per-row raw JSON column and can't be re-derived.)
    expiration {
      days = 30
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  rule {
    id     = "expire-reports"
    status = "Enabled"

    filter {
      prefix = "reports/"
    }

    expiration {
      days = 90
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  # Bucket-wide catch-all abort rule. CKV_AWS_300 only passes when a rule with
  # an empty filter (whole-bucket scope) carries abort_incomplete_multipart_upload
  # — prefix-scoped rules don't satisfy it, even with the same abort setting. The
  # two prefix rules above keep their own aborts; this one adds no deletions, so
  # anything outside raw/ and reports/ is unaffected.
  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"

    filter {
      prefix = ""
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

# ---- Export Lambda (scheduled incremental export, watermark in the table) ------

resource "aws_cloudwatch_log_group" "analytics_export" {
  name              = "/aws/lambda/${local.name_prefix}-analytics-export"
  retention_in_days = 365
  kms_key_id        = aws_kms_key.app.arn
  tags              = var.tags
}

resource "aws_lambda_function" "analytics_export" {
  #checkov:skip=CKV_AWS_116:Sync EventBridge-scheduled function; failures page via the alarm below, so a Lambda DLQ is N/A.
  #checkov:skip=CKV_AWS_117:No VPC — needs DynamoDB/S3/SSM API egress; revisit with VPC + endpoints.
  #checkov:skip=CKV_AWS_272:Code signing not set up for this app yet; tracked follow-up.
  function_name    = "${local.name_prefix}-analytics-export"
  role             = aws_iam_role.analytics_export.arn
  runtime          = "nodejs22.x"
  handler          = "index.handler"
  filename         = data.archive_file.analytics_export.output_path
  source_code_hash = data.archive_file.analytics_export.output_base64sha256
  memory_size      = 256
  timeout          = 120 # export start is one API call; 15-min lag is normal (IncrementalExportSpecification)
  kms_key_arn      = aws_kms_key.app.arn
  # One scheduled invocation per 6 hours; a 1-slot reservation is the concurrency
  # cap with zero starvation risk (no other invoker exists).
  reserved_concurrent_executions = 1

  tracing_config {
    mode = "Active"
  }

  environment {
    variables = {
      DYNAMO_TABLE     = aws_dynamodb_table.app.name
      DYNAMO_TABLE_ARN = aws_dynamodb_table.app.arn
      LAKE_BUCKET      = aws_s3_bucket.analytics_lake.bucket
      EXPORT_PREFIX    = "raw"
    }
  }

  depends_on = [aws_cloudwatch_log_group.analytics_export]
  tags       = var.tags
}

resource "aws_iam_role" "analytics_export" {
  name               = "${local.name_prefix}-analytics-export"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
  tags               = var.tags
}

data "aws_iam_policy_document" "analytics_export" {
  statement {
    sid       = "StartTableExport"
    effect    = "Allow"
    actions   = ["dynamodb:ExportTableToPointInTime"]
    resources = [aws_dynamodb_table.app.arn]
  }

  statement {
    # Polled every run while an export is pending; the watermark advances only
    # on COMPLETED. Export ARNs live under table/<name>/export/<id>, which the
    # bare table ARN above does not cover.
    sid       = "DescribeTableExport"
    effect    = "Allow"
    actions   = ["dynamodb:DescribeExport"]
    resources = ["${aws_dynamodb_table.app.arn}/export/*"]
  }

  statement {
    # Read/write the watermark item (pk = ANALYTICS#EXPORT, sk = #WATERMARK).
    sid       = "WatermarkItem"
    effect    = "Allow"
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"]
    resources = ["${aws_dynamodb_table.app.arn}"]
  }

  statement {
    # DynamoDB evaluates these permissions on the principal that requests the
    # same-account export; there is no DynamoDB export service principal to put
    # in the destination bucket policy.
    sid       = "WriteRawExports"
    effect    = "Allow"
    actions   = ["s3:AbortMultipartUpload", "s3:PutObject", "s3:PutObjectAcl"]
    resources = ["${aws_s3_bucket.analytics_lake.arn}/raw/*"]
  }

  statement {
    sid       = "UseAppKey"
    effect    = "Allow"
    actions   = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey"]
    resources = [aws_kms_key.app.arn]
  }

  statement {
    sid       = "Logs"
    effect    = "Allow"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.analytics_export.arn}:*"]
  }

  statement {
    sid       = "XRay"
    effect    = "Allow"
    actions   = ["xray:PutTraceSegments", "xray:PutTelemetryRecords"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "analytics_export" {
  #checkov:skip=CKV_AWS_355:X-Ray PutTraceSegments/PutTelemetryRecords have no resource-level scope; "*" is required.
  name   = "${local.name_prefix}-analytics-export"
  role   = aws_iam_role.analytics_export.id
  policy = data.aws_iam_policy_document.analytics_export.json
}

resource "aws_cloudwatch_event_rule" "analytics_export" {
  name                = "${local.name_prefix}-analytics-export-schedule"
  description         = "Incremental DynamoDB PITR export every 6 hours (ADR 0013)"
  schedule_expression = "rate(6 hours)"
  tags                = var.tags
}

resource "aws_cloudwatch_event_target" "analytics_export" {
  rule      = aws_cloudwatch_event_rule.analytics_export.name
  target_id = "${local.name_prefix}-analytics-export"
  arn       = aws_lambda_function.analytics_export.arn
}

resource "aws_lambda_permission" "analytics_export_schedule" {
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.analytics_export.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.analytics_export.arn
}

# ---- Convert Lambda (DynamoDB JSON → entity-split Parquet) ---------------------

resource "aws_cloudwatch_log_group" "analytics_convert" {
  name              = "/aws/lambda/${local.name_prefix}-analytics-convert"
  retention_in_days = 365
  kms_key_id        = aws_kms_key.app.arn
  tags              = var.tags
}

resource "aws_lambda_function" "analytics_convert" {
  #checkov:skip=CKV_AWS_116:Sync S3-event function; failures page via the alarm below.
  #checkov:skip=CKV_AWS_117:No VPC — needs S3 API egress; revisit with VPC + endpoints.
  #checkov:skip=CKV_AWS_272:Code signing not set up for this app yet; tracked follow-up.
  function_name    = "${local.name_prefix}-analytics-convert"
  role             = aws_iam_role.analytics_convert.arn
  runtime          = "nodejs22.x"
  handler          = "index.handler"
  filename         = data.archive_file.analytics_convert.output_path
  source_code_hash = data.archive_file.analytics_convert.output_base64sha256
  # DuckDB in-process needs real memory; incremental windows are small but the
  # one-time full-export backfill chunks through it.
  memory_size = 2048
  timeout     = 600
  # libduckdb.dylib (~100 MB unzipped, ~55 MB compressed) makes zip packaging
  # the right call; revisit only if the 250 MB unzipped budget is ever hit.
  kms_key_arn = aws_kms_key.app.arn
  # S3-invoked (one manifest-summary.json per completed export → typically 1
  # concurrent conversion per 6h). 5 slots = small manual-backfill headroom over
  # the steady-state cadence; a pathological S3 event burst throttles instead of
  # stampeding DuckDB conversions.
  reserved_concurrent_executions = 5
  # Async S3-invoked safety net (the twin of the worker's): failed conversions
  # land here instead of vanishing after the retry budget.
  dead_letter_config {
    target_arn = aws_sqs_queue.submissions_dlq.arn
  }

  tracing_config {
    mode = "Active"
  }

  environment {
    variables = {
      LAKE_BUCKET = aws_s3_bucket.analytics_lake.bucket
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.analytics_convert,
    aws_iam_role_policy.analytics_convert,
  ]
  tags = var.tags
}

resource "aws_iam_role" "analytics_convert" {
  name               = "${local.name_prefix}-analytics-convert"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
  tags               = var.tags
}

data "aws_iam_policy_document" "analytics_convert" {
  statement {
    sid       = "ReadRawExports"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.analytics_lake.arn}/raw/*"]
  }

  statement {
    sid       = "WriteParquet"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.analytics_lake.arn}/readings/*"]
  }

  statement {
    sid       = "SendToDlq"
    effect    = "Allow"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.submissions_dlq.arn]
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
    resources = ["${aws_cloudwatch_log_group.analytics_convert.arn}:*"]
  }

  statement {
    sid       = "XRay"
    effect    = "Allow"
    actions   = ["xray:PutTraceSegments", "xray:PutTelemetryRecords"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "analytics_convert" {
  #checkov:skip=CKV_AWS_355:X-Ray PutTraceSegments/PutTelemetryRecords have no resource-level scope; "*" is required.
  name   = "${local.name_prefix}-analytics-convert"
  role   = aws_iam_role.analytics_convert.id
  policy = data.aws_iam_policy_document.analytics_convert.json
}

# S3 event: completion of an export = manifest-summary.json landing under raw/.
resource "aws_s3_bucket_notification" "analytics_lake" {
  bucket = aws_s3_bucket.analytics_lake.id

  lambda_function {
    id                  = "export-manifest"
    lambda_function_arn = aws_lambda_function.analytics_convert.arn
    events              = ["s3:ObjectCreated:*"]
    filter_prefix       = "raw/"
    filter_suffix       = "manifest-summary.json"
  }

  depends_on = [aws_lambda_permission.analytics_lake_s3]
}

resource "aws_lambda_permission" "analytics_lake_s3" {
  statement_id  = "AllowS3InvokeConvert"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.analytics_convert.function_name
  principal     = "s3.amazonaws.com"
  source_arn    = aws_s3_bucket.analytics_lake.arn
}

# ---- Report Lambda (DuckDB over the Parquet lake, scheduled) --------------------

resource "aws_cloudwatch_log_group" "analytics_report" {
  name              = "/aws/lambda/${local.name_prefix}-analytics-report"
  retention_in_days = 365
  kms_key_id        = aws_kms_key.app.arn
  tags              = var.tags
}

resource "aws_lambda_function" "analytics_report" {
  #checkov:skip=CKV_AWS_116:Sync scheduled function; failures page via the alarm below, so a Lambda DLQ is N/A.
  #checkov:skip=CKV_AWS_117:No VPC — needs S3 API egress; revisit with VPC + endpoints.
  #checkov:skip=CKV_AWS_272:Code signing not set up for this app yet; tracked follow-up.
  function_name    = "${local.name_prefix}-analytics-report"
  role             = aws_iam_role.analytics_report.arn
  runtime          = "nodejs22.x"
  handler          = "index.handler"
  filename         = data.archive_file.analytics_report.output_path
  source_code_hash = data.archive_file.analytics_report.output_base64sha256
  memory_size      = 2048
  timeout          = 300
  kms_key_arn      = aws_kms_key.app.arn
  # One scheduled run every 24h; reserving a single slot caps cost/abuse and
  # can't starve anything (there is no other invoker).
  reserved_concurrent_executions = 1

  tracing_config {
    mode = "Active"
  }

  environment {
    variables = {
      LAKE_BUCKET = aws_s3_bucket.analytics_lake.bucket
    }
  }

  depends_on = [aws_cloudwatch_log_group.analytics_report]
  tags       = var.tags
}

resource "aws_iam_role" "analytics_report" {
  name               = "${local.name_prefix}-analytics-report"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
  tags               = var.tags
}

data "aws_iam_policy_document" "analytics_report" {
  statement {
    sid       = "ReadParquetLake"
    effect    = "Allow"
    actions   = ["s3:GetObject", "s3:ListBucket"]
    resources = [aws_s3_bucket.analytics_lake.arn, "${aws_s3_bucket.analytics_lake.arn}/readings/*"]
  }

  statement {
    sid       = "WriteReports"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.analytics_lake.arn}/reports/*"]
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
    resources = ["${aws_cloudwatch_log_group.analytics_report.arn}:*"]
  }

  statement {
    sid       = "XRay"
    effect    = "Allow"
    actions   = ["xray:PutTraceSegments", "xray:PutTelemetryRecords"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "analytics_report" {
  #checkov:skip=CKV_AWS_355:X-Ray PutTraceSegments/PutTelemetryRecords have no resource-level scope; "*" is required.
  name   = "${local.name_prefix}-analytics-report"
  role   = aws_iam_role.analytics_report.id
  policy = data.aws_iam_policy_document.analytics_report.json
}

# Daily report run, offset from the 6-hour export schedule so the convert step
# has had time to land the latest partition.
resource "aws_cloudwatch_event_rule" "analytics_report" {
  name                = "${local.name_prefix}-analytics-report-schedule"
  description         = "Daily citywide report materialization from the Parquet lake (ADR 0013)"
  schedule_expression = "cron(0 14 * * ? *)" # 06:00 America/Los_Angeles ≈ 14:00 UTC
  tags                = var.tags
}

resource "aws_cloudwatch_event_target" "analytics_report" {
  rule      = aws_cloudwatch_event_rule.analytics_report.name
  target_id = "${local.name_prefix}-analytics-report"
  arn       = aws_lambda_function.analytics_report.arn
}

resource "aws_lambda_permission" "analytics_report_schedule" {
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.analytics_report.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.analytics_report.arn
}

# ---- Alarms (ADR 0013: convert errors, report errors, no-export watchdog) ------

resource "aws_cloudwatch_log_metric_filter" "analytics_convert_errors" {
  name           = "${local.name_prefix}-analytics-convert-errors"
  log_group_name = aws_cloudwatch_log_group.analytics_convert.name
  pattern        = "{ $.level = \"ERROR\" }"

  metric_transformation {
    name          = "ServerError"
    namespace     = local.error_namespace
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_log_metric_filter" "analytics_report_errors" {
  name           = "${local.name_prefix}-analytics-report-server-errors"
  log_group_name = aws_cloudwatch_log_group.analytics_report.name
  pattern        = "{ $.level = \"ERROR\" }"

  metric_transformation {
    name          = "ServerError"
    namespace     = local.error_namespace
    value         = "1"
    default_value = "0"
  }
}

# No new export in 36h: the tripwire for a missed schedule or a stalled
# watermark. The export Lambda logs an AnalyticsExportStarted marker per run;
# absence of those lines over 36h is the alarm.
resource "aws_cloudwatch_log_metric_filter" "analytics_export_started" {
  name           = "${local.name_prefix}-analytics-export-started"
  log_group_name = aws_cloudwatch_log_group.analytics_export.name
  pattern        = "{ $.marker = \"AnalyticsExportStarted\" }"

  metric_transformation {
    name          = "AnalyticsExportStarted"
    namespace     = local.error_namespace
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "analytics_export_stalled" {
  alarm_name          = "${local.name_prefix}-analytics-export-stalled"
  alarm_description   = "No analytics export started in 36 hours (expected every 6) — schedule stuck, export API failing, or the function is not logging the marker. The watermark is unrecoverable if the PITR 35-day window passes; recovery is a fresh full export (ADR 0013)."
  comparison_operator = "LessThanThreshold"
  threshold           = 1
  period              = 43200 # 12h × 3 evaluation periods = 36h of silence alarms
  evaluation_periods  = 3
  statistic           = "Sum"
  namespace           = local.error_namespace
  metric_name         = "AnalyticsExportStarted"
  treat_missing_data  = "breaching"

  alarm_actions = [aws_sns_topic.alarms.arn]
  ok_actions    = [aws_sns_topic.alarms.arn]

  tags = var.tags
}
