# Keep the existing route until the new topic's subscriptions and delivery have
# been verified. Set this per environment through CI only after that check.
variable "duplicate_alarm_route_confirmed" {
  description = "Use only the separate duplicate alarm topic after confirming its subscriptions and verifying receipt. False keeps the original topic as a fallback."
  type        = bool
  default     = false
}

locals {
  duplicate_alarm_actions = var.duplicate_alarm_route_confirmed ? [aws_sns_topic.duplicate_alarms.arn] : [aws_sns_topic.alarms.arn, aws_sns_topic.duplicate_alarms.arn]
}

# Core API symptoms share one incident; child metrics and thresholds remain.
# The shared ServerError alarm spans API, intake and background processing and
# retains direct actions so a background failure is never masked by an API incident.
resource "aws_cloudwatch_composite_alarm" "api_incident" {
  alarm_name        = "${local.name_prefix}-api-incident"
  alarm_description = "API incident: gateway 5xx or API/authorizer Lambda errors/throttles. Inspect child alarms and their log groups. One notification until all contributing alarms clear; OK does not recover failed operations."
  alarm_rule = join(" OR ", [for name in [
    aws_cloudwatch_metric_alarm.api_5xx.alarm_name,
    aws_cloudwatch_metric_alarm.lambda_errors["api"].alarm_name,
    aws_cloudwatch_metric_alarm.lambda_errors["authorizer"].alarm_name,
    aws_cloudwatch_metric_alarm.lambda_throttles["api"].alarm_name,
    aws_cloudwatch_metric_alarm.lambda_throttles["authorizer"].alarm_name,
  ] : "ALARM(\"${name}\")"])
  alarm_actions = [aws_sns_topic.alarms.arn]
  ok_actions    = [aws_sns_topic.alarms.arn]
  tags          = var.tags
}

resource "aws_sns_topic" "duplicate_alarms" {
  name              = "${local.name_prefix}-duplicate-alarms"
  kms_master_key_id = aws_kms_key.app.arn
  tags              = var.tags
}

resource "aws_sns_topic_subscription" "duplicate_alarm_emails" {
  for_each  = toset(var.alarm_emails)
  topic_arn = aws_sns_topic.duplicate_alarms.arn
  protocol  = "email"
  endpoint  = each.value
}

data "archive_file" "warning_digest" {
  type        = "zip"
  source_dir  = "${path.module}/../../../backend/dist/warning-digest"
  output_path = "${path.module}/dist/warning-digest.zip"
}

resource "aws_cloudwatch_log_group" "warning_digest" {
  name              = "/aws/lambda/${local.name_prefix}-warning-digest"
  retention_in_days = 30
  kms_key_id        = aws_kms_key.app.arn
  tags              = var.tags
}

resource "aws_iam_role" "warning_digest" {
  name = "${local.name_prefix}-warning-digest"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole"
  }] })
  tags = var.tags
}

resource "aws_iam_role_policy" "warning_digest" {
  role = aws_iam_role.warning_digest.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    # GetMetricData does not support resource-level permissions. No logs, SQS,
    # application table, media, or secrets access is granted to this function.
    { Effect = "Allow", Action = ["cloudwatch:GetMetricData"], Resource = "*" },
    { Effect = "Allow", Action = ["cloudwatch:DescribeAlarms"], Resource = [
      aws_cloudwatch_metric_alarm.duplicate_dead_letters.arn,
      aws_cloudwatch_metric_alarm.duplicate_queue_backlog.arn
    ] },
    { Effect = "Allow", Action = ["sns:Publish"], Resource = aws_sns_topic.alarms.arn },
    { Effect = "Allow", Action = ["kms:Decrypt", "kms:GenerateDataKey"], Resource = aws_kms_key.app.arn },
    { Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.warning_digest.arn}:*" }
  ] })
}

resource "aws_lambda_function" "warning_digest" {
  function_name    = "${local.name_prefix}-warning-digest"
  role             = aws_iam_role.warning_digest.arn
  runtime          = "nodejs24.x"
  handler          = "index.handler"
  filename         = data.archive_file.warning_digest.output_path
  source_code_hash = data.archive_file.warning_digest.output_base64sha256
  timeout          = 60
  memory_size      = 128
  environment {
    variables = {
      ALARM_PREFIX     = local.name_prefix
      DIGEST_TOPIC_ARN = aws_sns_topic.alarms.arn
    }
  }
  depends_on = [aws_cloudwatch_log_group.warning_digest, aws_iam_role_policy.warning_digest]
  tags       = var.tags
}

resource "aws_cloudwatch_event_rule" "warning_digest" {
  name                = "${local.name_prefix}-warning-digest"
  description         = "Daily aggregate warning digest; previous UTC day plus current duplicate queue alarms"
  schedule_expression = "cron(0 16 * * ? *)"
  tags                = var.tags
}

resource "aws_cloudwatch_event_target" "warning_digest" {
  rule = aws_cloudwatch_event_rule.warning_digest.name
  arn  = aws_lambda_function.warning_digest.arn
}

resource "aws_lambda_permission" "warning_digest" {
  statement_id  = "AllowWarningDigestSchedule"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.warning_digest.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.warning_digest.arn
}

resource "aws_cloudwatch_metric_alarm" "warning_digest_errors" {
  alarm_name          = "${local.name_prefix}-warning-digest-errors"
  alarm_description   = "Daily warning digest failed. Check the warning-digest Lambda logs; do not assume a missing digest means no warnings."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.warning_digest.function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  tags                = var.tags
}

# A missing-data alarm would page immediately on first deployment because there
# is no invocation history yet. Watch actual scheduler delivery failures instead.
resource "aws_cloudwatch_metric_alarm" "warning_digest_delivery_failed" {
  alarm_name          = "${local.name_prefix}-warning-digest-delivery-failed"
  alarm_description   = "EventBridge exhausted delivery attempts for the warning digest. Check the rule target and Lambda invocation permission."
  namespace           = "AWS/Events"
  metric_name         = "FailedInvocations"
  dimensions          = { RuleName = aws_cloudwatch_event_rule.warning_digest.name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  tags                = var.tags
}

resource "aws_cloudwatch_metric_alarm" "warning_digest_throttles" {
  alarm_name          = "${local.name_prefix}-warning-digest-throttles"
  alarm_description   = "The daily warning digest Lambda was throttled. Check account concurrency and async invocation delivery before assuming a quiet day."
  namespace           = "AWS/Lambda"
  metric_name         = "Throttles"
  dimensions          = { FunctionName = aws_lambda_function.warning_digest.function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  tags                = var.tags
}
