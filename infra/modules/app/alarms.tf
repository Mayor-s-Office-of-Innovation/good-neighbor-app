# Error-tracking observability (docs/todo/client-error-tracking-plan.md Phase 4).
# Metric filters key on the structured-log markers emitted by the client-errors
# intake (handlers/client-errors.js + handlers/forwarder.js) and the
# logServerError convention (lib/log-server-error.js): single-line JSON with
# "level":"ERROR" for uncaught server errors. Alarms notify an SNS topic that
# carries an optional email subscription list (var.alarm_emails; empty = topic
# exists, no subscriptions — add recipients per environment later without
# touching the filters).

variable "alarm_emails" {
  description = "Email addresses subscribed to the error-alarm SNS topic (optional; alarm recipients are an open question in the error-tracking plan)."
  type        = list(string)
  default     = []
}

locals {
  error_namespace = "${local.name_prefix}-errors"
}

resource "aws_sns_topic" "alarms" {
  name              = "${local.name_prefix}-alarms"
  kms_master_key_id = aws_kms_key.app.arn
  tags              = var.tags
}

resource "aws_sns_topic_subscription" "alarm_emails" {
  for_each  = toset(var.alarm_emails)
  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = each.value
}

# --- api Lambda filters -------------------------------------------------------

# PostHog forwarder failures (ingest down, egress broken, secret errors).
resource "aws_cloudwatch_log_metric_filter" "client_error_forward_failed" {
  name           = "${local.name_prefix}-client-error-forward-failed"
  log_group_name = aws_cloudwatch_log_group.api.name
  pattern        = "{ $.marker = \"ClientErrorForwardFailed\" }"

  metric_transformation {
    name          = "ClientErrorForwardFailed"
    namespace     = local.error_namespace
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "client_error_forward_failed" {
  alarm_name          = "${local.name_prefix}-client-error-forward-failed"
  alarm_description   = "Client-error forwarder to PostHog is failing (ingest down, egress broken, or secret misread). Errors still reach CloudWatch; fix forwarding so contributors regain visibility."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  metric_name         = "ClientErrorForwardFailed"
  namespace           = local.error_namespace
  period              = 300
  statistic           = "Sum"
  threshold           = 1
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.alarms.arn]
  ok_actions    = [aws_sns_topic.alarms.arn]

  tags = var.tags
}

# Validation drops are quiet-but-counted (abuse signal, not app failure —
# alarm only at a clearly abusive level).
resource "aws_cloudwatch_log_metric_filter" "client_error_dropped" {
  name           = "${local.name_prefix}-client-error-dropped"
  log_group_name = aws_cloudwatch_log_group.api.name
  pattern        = "{ $.marker = \"ClientErrorDropped\" }"

  metric_transformation {
    name          = "ClientErrorDropped"
    namespace     = local.error_namespace
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "client_error_dropped" {
  alarm_name          = "${local.name_prefix}-client-error-dropped"
  alarm_description   = "Unusually many invalid client-error payloads — possible abuse of the public intake (high threshold; single drops are normal noise)."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  threshold           = 100
  period              = 300
  namespace           = local.error_namespace
  metric_name         = "ClientErrorDropped"
  statistic           = "Sum"
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.alarms.arn]

  tags = var.tags
}

# Uncaught server errors (api), via the logServerError convention: single-line
# JSON with "level":"ERROR".
resource "aws_cloudwatch_log_metric_filter" "api_server_errors" {
  name           = "${local.name_prefix}-api-server-errors"
  log_group_name = aws_cloudwatch_log_group.api.name
  pattern        = "{ $.level = \"ERROR\" }"

  metric_transformation {
    name          = "ServerError"
    namespace     = local.error_namespace
    value         = "1"
    default_value = "0"
  }
}

# --- user feedback filters (docs/todo/feedback-plan.md Phase 3) ---------------

# Every valid feedback submission logs one FeedbackReceived line. The alarm is
# the notification: ≥1 per 5-min bucket emails the SNS topic (recipients are
# console-managed per environment — see the plan's Decisions).
resource "aws_cloudwatch_log_metric_filter" "feedback_received" {
  name           = "${local.name_prefix}-feedback-received"
  log_group_name = aws_cloudwatch_log_group.api.name
  pattern        = "{ $.marker = \"FeedbackReceived\" }"

  metric_transformation {
    name          = "FeedbackReceived"
    namespace     = local.error_namespace
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "feedback_received" {
  alarm_name          = "${local.name_prefix}-feedback-received"
  alarm_description   = "A user submitted app feedback. Read it in CloudWatch Logs Insights (saved query 'GNP feedback') on the ${local.name_prefix}-api log group."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  metric_name         = "FeedbackReceived"
  namespace           = local.error_namespace
  period              = 300
  statistic           = "Sum"
  threshold           = 1
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.alarms.arn]
  ok_actions    = [aws_sns_topic.alarms.arn]

  tags = var.tags
}

# Validation drops are quiet-but-counted (abuse signal, not app failure —
# alarm only at a clearly abusive level), mirroring client_error_dropped.
resource "aws_cloudwatch_log_metric_filter" "feedback_dropped" {
  name           = "${local.name_prefix}-feedback-dropped"
  log_group_name = aws_cloudwatch_log_group.api.name
  pattern        = "{ $.marker = \"FeedbackDropped\" }"

  metric_transformation {
    name          = "FeedbackDropped"
    namespace     = local.error_namespace
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "feedback_dropped" {
  alarm_name          = "${local.name_prefix}-feedback-dropped"
  alarm_description   = "Unusually many invalid feedback payloads — possible abuse of the public intake (high threshold; single drops are normal noise)."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  threshold           = 100
  period              = 300
  namespace           = local.error_namespace
  metric_name         = "FeedbackDropped"
  statistic           = "Sum"
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.alarms.arn]

  tags = var.tags
}

# Feedback forwarder failures (PostHog ingest down, egress broken, secret
# errors) — the feedback twin of client_error_forward_failed. A failure here
# means feedback arrived but never reached the store (CloudWatch keeps only
# metadata), so it pages.
resource "aws_cloudwatch_log_metric_filter" "feedback_forward_failed" {
  name           = "${local.name_prefix}-feedback-forward-failed"
  log_group_name = aws_cloudwatch_log_group.api.name
  pattern        = "{ $.marker = \"FeedbackForwardFailed\" }"

  metric_transformation {
    name          = "FeedbackForwardFailed"
    namespace     = local.error_namespace
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "feedback_forward_failed" {
  alarm_name          = "${local.name_prefix}-feedback-forward-failed"
  alarm_description   = "Feedback forwarder to PostHog is failing (ingest down, egress broken, or secret misread) — feedback arrived but never reached the store. Check the FeedbackForwardFailed WARN lines."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  metric_name         = "FeedbackForwardFailed"
  namespace           = local.error_namespace
  period              = 300
  statistic           = "Sum"
  threshold           = 1
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.alarms.arn]
  ok_actions    = [aws_sns_topic.alarms.arn]

  tags = var.tags
}

# --- worker filter ------------------------------------------------------------

resource "aws_cloudwatch_log_metric_filter" "worker_errors" {
  name           = "${local.name_prefix}-worker-server-errors"
  log_group_name = aws_cloudwatch_log_group.worker.name
  pattern        = "{ $.level = \"ERROR\" }"

  metric_transformation {
    name          = "ServerError"
    namespace     = local.error_namespace
    value         = "1"
    default_value = "0"
  }
}

# Combined "the api or worker is failing now" page.
resource "aws_cloudwatch_metric_alarm" "server_error_rate" {
  alarm_name          = "${local.name_prefix}-server-errors"
  alarm_description   = "Uncaught server errors logged by the logServerError convention (api or worker) — see docs/todo/client-error-tracking-plan.md Phase 4."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  threshold           = 5
  period              = 300
  namespace           = local.error_namespace
  metric_name         = "ServerError"
  statistic           = "Sum"
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.alarms.arn]
  ok_actions    = [aws_sns_topic.alarms.arn]

  tags = var.tags
}