# Duplicate-only telemetry: EMF is emitted by the isolated worker/stream consumer.
# IDs are searchable log properties, never high-cardinality metric dimensions.
# The pinned AWS provider does not expose dashboard tags (verified via provider
# schema). Do not add unsupported tags here; alarms retain all required CCSF tags.
resource "aws_cloudwatch_dashboard" "duplicates" {
  dashboard_name = "${local.name_prefix}-duplicates"
  dashboard_body = jsonencode({ widgets = [
    { type = "text", x = 0, y = 0, width = 24, height = 3, properties = { markdown = "# Duplicate detection\nSource: isolated duplicate-worker and duplicate-dispatch EMF events, plus SQS metrics. Counts are recorded evaluation/event attempts, may repeat on retries, and are not unique issues or accuracy estimates. Confidence is a policy band, not a probability. No-match means no qualifying match was found. Detailed events expire after 30 days; aggregate CloudWatch metrics retain their standard retention. Images and narrative evidence are never logged." } },
    { type = "metric", x = 0, y = 3, width = 12, height = 6, properties = { title = "Recorded issue outcomes (attempt counts)", region = local.dashboard_region, period = 300, stat = "Sum", metrics = [for name in ["DuplicateMatchedIssues", "DuplicateNoMatchIssues", "DuplicateIncompleteNoMatchIssues", "DuplicatePendingIssues"] : ["${local.name_prefix}-duplicates", name]] } },
    { type = "metric", x = 12, y = 3, width = 12, height = 6, properties = { title = "Search and first qualifying-match latency (milliseconds; excludes queue)", region = local.dashboard_region, period = 300, stat = "p95", metrics = [["${local.name_prefix}-duplicates", "DuplicateSearchMs", { stat = "p50", label = "Search p50" }], ["${local.name_prefix}-duplicates", "DuplicateSearchMs", { stat = "p95", label = "Search p95" }], ["${local.name_prefix}-duplicates", "DuplicateFirstMatchMs", { stat = "p50", label = "First match p50 (matched searches only)" }], ["${local.name_prefix}-duplicates", "DuplicateFirstMatchMs", { stat = "p95", label = "First match p95 (matched searches only)" }]] } },
    { type = "metric", x = 0, y = 9, width = 12, height = 6, properties = { title = "Valid and failed candidate assessments (attempt counts)", region = local.dashboard_region, period = 300, stat = "Sum", metrics = [for name in ["DuplicateComparisons", "DuplicateFailedCandidates", "DuplicateWorkerFailures"] : ["${local.name_prefix}-duplicates", name]] } },
    { type = "metric", x = 12, y = 9, width = 12, height = 6, properties = { title = "Cache hits, link events, and user separations (not an accuracy rate)", region = local.dashboard_region, period = 300, stat = "Sum", metrics = [for name in ["DuplicatePreparationCacheHits", "DuplicateComparisonCacheHits", "DuplicateLinksCreated", "DuplicateSeparated"] : ["${local.name_prefix}-duplicates", name]] } },
    { type = "metric", x = 0, y = 15, width = 12, height = 6, properties = { title = "Queue age and depth (seconds and message counts)", region = local.dashboard_region, period = 300, stat = "Maximum", metrics = [["AWS/SQS", "ApproximateAgeOfOldestMessage", "QueueName", aws_sqs_queue.duplicates.name], ["AWS/SQS", "ApproximateNumberOfMessagesVisible", "QueueName", aws_sqs_queue.duplicates.name, { yAxis = "right" }], ["AWS/SQS", "ApproximateNumberOfMessagesVisible", "QueueName", aws_sqs_queue.duplicates_dlq.name, { yAxis = "right", label = "Dead letters" }]] } },
    { type = "log", x = 12, y = 15, width = 12, height = 6, properties = { title = "Candidate outcomes by evidence kind and confidence", region = local.dashboard_region, query = "SOURCE '/aws/lambda/${local.name_prefix}-duplicate-worker' | fields @timestamp, event, outcome, confidence, evidenceKind | filter event = 'duplicate_comparison' | stats count(*) as candidateAttempts by outcome, confidence, evidenceKind", view = "table" } },
  ] })
}
resource "aws_cloudwatch_metric_alarm" "duplicate_worker_failures" {
  alarm_name          = "${local.name_prefix}-duplicate-worker-failures"
  alarm_description   = "Five or more failed duplicate worker attempts in five minutes; isolated from normal analysis."
  namespace           = "${local.name_prefix}-duplicates"
  metric_name         = "DuplicateWorkerFailures"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 5
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  tags                = var.tags
}
resource "aws_cloudwatch_metric_alarm" "duplicate_candidate_failures" {
  alarm_name          = "${local.name_prefix}-duplicate-candidate-failures"
  alarm_description   = "Five or more candidate comparison failures in five minutes; searches continue with remaining candidates."
  namespace           = "${local.name_prefix}-duplicates"
  metric_name         = "DuplicateFailedCandidates"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 5
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  tags                = var.tags
}
resource "aws_cloudwatch_metric_alarm" "duplicate_queue_backlog" {
  alarm_name          = "${local.name_prefix}-duplicate-queue-backlog"
  alarm_description   = "Duplicate queue age exceeds fifteen minutes across two five-minute periods."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateAgeOfOldestMessage"
  dimensions          = { QueueName = aws_sqs_queue.duplicates.name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 2
  threshold           = 900
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  tags                = var.tags
}
