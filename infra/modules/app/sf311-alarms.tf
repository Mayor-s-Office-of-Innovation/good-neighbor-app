# EMF aggregates all 311 callers (API, dedicated worker and legacy drain).
# Event alarms indicate observed failures, not the current number of stuck jobs.
# Their return to OK means a quiet evaluation window, not verified recovery.
resource "aws_cloudwatch_metric_alarm" "sf311_action_failed" {
  alarm_name          = "${local.name_prefix}-311-action-failed"
  alarm_description   = "A 311 action needs attention: an inline failure, terminal queued failure or exhausted retry. Query marker=Sf311ActionFailure for Operation, reason, jobId and attempt. Counts are outcome events, not unique tickets. See docs/runbooks/sf311.md."
  namespace           = local.metrics_namespace
  metric_name         = "Sf311ActionFailed"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  tags                = var.tags
}

resource "aws_cloudwatch_metric_alarm" "sf311_connection_failed" {
  alarm_name          = "${local.name_prefix}-311-connection-failed"
  alarm_description   = "At least three Oracle HUB API attempts failed in five minutes with a network/timeout, HTTP authentication, throttling or server error. Query marker=Sf311Request by Operation, category and httpStatus. This does not establish an outage of all SF311 services. See docs/runbooks/sf311.md."
  namespace           = local.metrics_namespace
  metric_name         = "Sf311ConnectionFailed"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 3
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  tags                = var.tags
}

resource "aws_cloudwatch_metric_alarm" "sf311_reconciliation_blocked" {
  alarm_name          = "${local.name_prefix}-311-reconciliation-blocked"
  alarm_description   = "311 reconciliation needs attention: closure state is unknown or a prior creation/attachment/note cannot be confirmed. Query marker=Sf311ActionFailure, category=reconciliation for Operation, reason and jobId. Missing feed data does not prove a deleted ticket; do not blindly replay non-idempotent calls. See docs/runbooks/sf311.md."
  namespace           = local.metrics_namespace
  metric_name         = "Sf311ReconciliationBlocked"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  tags                = var.tags
}

resource "aws_cloudwatch_metric_alarm" "sf311_dlq_not_empty" {
  alarm_name          = "${local.name_prefix}-311-dlq-not-empty"
  alarm_description   = "At least one 311 job exhausted retries. Inspect persisted SF311_JOB records and safe worker logs before approved recovery. This queue contains 311 work only; historical jobs can remain in submissions-dlq. See docs/runbooks/sf311.md."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = aws_sqs_queue.sf311_dlq.name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
  tags                = var.tags
}

resource "aws_cloudwatch_metric_alarm" "sf311_queue_backlog" {
  alarm_name          = "${local.name_prefix}-311-queue-backlog"
  alarm_description   = "The oldest 311 job is over ten minutes old across two five-minute periods. Check 311 worker errors/throttles, connection failures and reconciliation failures. Queue age can include retries; it is not just processing duration. See docs/runbooks/sf311.md."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateAgeOfOldestMessage"
  dimensions          = { QueueName = aws_sqs_queue.sf311.name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  threshold           = 600
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
  tags                = var.tags
}
