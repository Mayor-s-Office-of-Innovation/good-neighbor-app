# Ops dashboard. Context and conventions: docs/runbooks/observability.md.
#
# One CloudWatch dashboard per environment, built from the same metric names
# the code emits (backend/src/lib/metrics.js → METRICS_NAMESPACE) and the
# alarms in alarms.tf / platform-alarms.tf, so a widget and its alarm never
# drift apart. Rows, top to bottom: alarm status · activity · analyzer ·
# pipeline · API · uptime + security. Read with docs/runbooks/observability.md.
#
# Conventions in the widget JSON:
# - Metric arrays are [namespace, metric, dimName, dimValue, …, {options}].
#   EMF materializes one metric per dimension SET, so CheckCompleted exists
#   both as [FlowType] and as [FlowType, EvidenceKind]; the dimension list
#   must match one of those exactly.
# - Business metrics are summed per hour (activity is sparse); platform
#   metrics per 5 minutes. The dashboard opens on the last 24 h.
# - Metrics that only exist in us-east-1 (Route53 health, CloudFront WAF)
#   carry an explicit "region"; everything else uses the home region.

locals {
  dashboard_region = data.aws_region.current.name
  ns               = local.metrics_namespace

  # Alarm widget: every alarm in the home region except the feedback
  # notification (it goes to ALARM on every submission — a signal, not a
  # fault) and the us-east-1 pair, which the uptime/WAF widgets show as
  # metrics instead (alarm widgets are same-region only).
  dashboard_alarm_arns = concat(
    [
      aws_cloudwatch_metric_alarm.submissions_dlq_not_empty.arn,
      aws_cloudwatch_metric_alarm.submissions_queue_backlog.arn,
      aws_cloudwatch_metric_alarm.worker_duration_high.arn,
      aws_cloudwatch_metric_alarm.api_5xx.arn,
      aws_cloudwatch_metric_alarm.dynamodb_throttles.arn,
      aws_cloudwatch_metric_alarm.server_error_rate.arn,
      aws_cloudwatch_metric_alarm.sf311_action_failed.arn,
      aws_cloudwatch_metric_alarm.media_rejected.arn,
      aws_cloudwatch_metric_alarm.media_quota_exceeded.arn,
      aws_cloudwatch_metric_alarm.client_error_forward_failed.arn,
      aws_cloudwatch_metric_alarm.client_error_dropped.arn,
      aws_cloudwatch_metric_alarm.client_event_forward_failed.arn,
      aws_cloudwatch_metric_alarm.client_event_dropped.arn,
      aws_cloudwatch_metric_alarm.feedback_dropped.arn,
      aws_cloudwatch_metric_alarm.feedback_forward_failed.arn,
      aws_cloudwatch_metric_alarm.manager_access_throttled.arn,
      aws_cloudwatch_metric_alarm.manager_access_delivery_failed.arn,
      aws_cloudwatch_metric_alarm.manager_security_notification_failed.arn,
      aws_cloudwatch_metric_alarm.revocation_operation_partial.arn,
      aws_cloudwatch_metric_alarm.analytics_export_stalled.arn,
    ],
    [for a in aws_cloudwatch_metric_alarm.lambda_errors : a.arn],
    [for a in aws_cloudwatch_metric_alarm.lambda_throttles : a.arn],
    aws_cloudwatch_metric_alarm.mail_manager_relay_failure[*].arn,
  )

  # Shared widget property fragments.
  hourly   = { region = local.dashboard_region, view = "timeSeries", period = 3600, stat = "Sum" }
  five_min = { region = local.dashboard_region, view = "timeSeries", period = 300, stat = "Sum" }

  dashboard_widgets = [
    # ---- Row 0: header -----------------------------------------------------
    {
      type = "text", x = 0, y = 0, width = 24, height = 2
      properties = {
        markdown = "## ${local.name_prefix} · ops\nAlarms page the `${local.name_prefix}-alarms` topics. Runbook: `docs/runbooks/observability.md`. Business metrics come from `backend/src/lib/metrics.js` (namespace `${local.ns}`); the analytics lake (admin console → Analytics) trails this view by ~6 h and is the place for per-site and historical questions."
      }
    },

    # ---- Row 1: alarm status ----------------------------------------------
    {
      type = "alarm", x = 0, y = 2, width = 24, height = 4
      properties = {
        title  = "Alarm status (home region)"
        alarms = local.dashboard_alarm_arns
      }
    },

    # ---- Row 2: activity ---------------------------------------------------
    {
      type = "metric", x = 0, y = 6, width = 8, height = 6
      properties = merge(local.hourly, {
        title   = "Checks started vs completed / hour"
        stacked = false
        metrics = [
          [local.ns, "CheckStarted", "FlowType", "perimeter", { label = "started · perimeter" }],
          [local.ns, "CheckCompleted", "FlowType", "perimeter", { label = "completed · perimeter" }],
          [local.ns, "CheckStarted", "FlowType", "single-problem", { label = "started · single-problem" }],
          [local.ns, "CheckCompleted", "FlowType", "single-problem", { label = "completed · single-problem" }],
        ]
        yAxis = { left = { min = 0, showUnits = false } }
      })
    },
    {
      type = "metric", x = 8, y = 6, width = 8, height = 6
      properties = merge(local.hourly, {
        title   = "Completed perimeter checks by evidence / hour"
        stacked = true
        metrics = [
          [local.ns, "CheckCompleted", "FlowType", "perimeter", "EvidenceKind", "photos", { label = "photos" }],
          [local.ns, "CheckCompleted", "FlowType", "perimeter", "EvidenceKind", "description", { label = "description" }],
          [local.ns, "CheckCompleted", "FlowType", "perimeter", "EvidenceKind", "mixed", { label = "mixed" }],
          [local.ns, "CheckCompleted", "FlowType", "perimeter", "EvidenceKind", "none", { label = "none" }],
        ]
        yAxis = { left = { min = 0, showUnits = false } }
      })
    },
    {
      type = "metric", x = 16, y = 6, width = 8, height = 6
      properties = merge(local.hourly, {
        title   = "Analyses completed by kind / hour"
        stacked = true
        metrics = [
          [local.ns, "AnalysisCompleted", "Kind", "photo", { label = "photo" }],
          [local.ns, "AnalysisCompleted", "Kind", "text", { label = "text" }],
        ]
        yAxis = { left = { min = 0, showUnits = false } }
      })
    },

    # ---- Row 3: analyzer ---------------------------------------------------
    {
      type = "metric", x = 0, y = 12, width = 8, height = 6
      properties = merge(local.five_min, {
        title   = "Analyzer latency (ms)"
        stacked = false
        metrics = [
          [local.ns, "AnalyzerLatencyMs", "Kind", "photo", { stat = "p50", label = "photo p50" }],
          [local.ns, "AnalyzerLatencyMs", "Kind", "photo", { stat = "p95", label = "photo p95" }],
          [local.ns, "AnalyzerLatencyMs", "Kind", "text", { stat = "p50", label = "text p50" }],
          [local.ns, "AnalyzerLatencyMs", "Kind", "text", { stat = "p95", label = "text p95" }],
        ]
        yAxis = { left = { min = 0, showUnits = false } }
        annotations = {
          horizontal = [
            { label = "worker-duration-high alarm", value = 240000, color = "#d62728" },
          ]
        }
      })
    },
    {
      type = "metric", x = 8, y = 12, width = 8, height = 6
      properties = merge(local.hourly, {
        title   = "Analyses failed / retried / duplicate per hour"
        stacked = false
        metrics = [
          [local.ns, "AnalysisFailed", "Kind", "photo", { label = "failed · photo", color = "#d62728" }],
          [local.ns, "AnalysisFailed", "Kind", "text", { label = "failed · text", color = "#ff9896" }],
          [local.ns, "AnalysisRetried", "Kind", "photo", { label = "retried · photo", color = "#ff7f0e" }],
          [local.ns, "AnalysisRetried", "Kind", "text", { label = "retried · text", color = "#ffbb78" }],
          [local.ns, "AnalysisDuplicate", "Kind", "photo", { label = "duplicate · photo", color = "#7f7f7f" }],
          [local.ns, "AnalysisDuplicate", "Kind", "text", { label = "duplicate · text", color = "#c7c7c7" }],
        ]
        yAxis = { left = { min = 0, showUnits = false } }
      })
    },
    {
      type = "metric", x = 16, y = 12, width = 8, height = 6
      properties = merge(local.hourly, {
        title   = "Analysis failure rate (%)"
        stacked = false
        metrics = [
          [{ expression = "100 * (fp + ft) / MAX([(cp + ct + fp + ft), 1])", label = "failed / (completed + failed)", id = "rate", color = "#d62728" }],
          [local.ns, "AnalysisCompleted", "Kind", "photo", { id = "cp", visible = false }],
          [local.ns, "AnalysisCompleted", "Kind", "text", { id = "ct", visible = false }],
          [local.ns, "AnalysisFailed", "Kind", "photo", { id = "fp", visible = false }],
          [local.ns, "AnalysisFailed", "Kind", "text", { id = "ft", visible = false }],
        ]
        yAxis = { left = { min = 0, max = 100, showUnits = false } }
      })
    },

    # ---- Row 4: pipeline ---------------------------------------------------
    {
      type = "metric", x = 0, y = 18, width = 12, height = 6
      properties = merge(local.five_min, {
        title   = "Submissions queue"
        stacked = false
        metrics = [
          ["AWS/SQS", "ApproximateNumberOfMessagesVisible", "QueueName", aws_sqs_queue.submissions.name, { stat = "Maximum", label = "queued" }],
          ["AWS/SQS", "ApproximateNumberOfMessagesNotVisible", "QueueName", aws_sqs_queue.submissions.name, { stat = "Maximum", label = "in flight" }],
          ["AWS/SQS", "ApproximateNumberOfMessagesVisible", "QueueName", aws_sqs_queue.submissions_dlq.name, { stat = "Maximum", label = "dead-lettered", color = "#d62728" }],
          ["AWS/SQS", "ApproximateAgeOfOldestMessage", "QueueName", aws_sqs_queue.submissions.name, { stat = "Maximum", label = "oldest message age (s)", yAxis = "right" }],
        ]
        yAxis = {
          left  = { min = 0, showUnits = false }
          right = { min = 0, showUnits = false }
        }
        annotations = {
          horizontal = [
            { label = "queue-backlog alarm (s)", value = 600, color = "#ff7f0e", yAxis = "right" },
          ]
        }
      })
    },
    {
      type = "metric", x = 12, y = 18, width = 12, height = 6
      properties = merge(local.five_min, {
        title   = "Worker Lambda"
        stacked = false
        metrics = [
          ["AWS/Lambda", "Invocations", "FunctionName", aws_lambda_function.worker.function_name, { label = "invocations" }],
          ["AWS/Lambda", "Errors", "FunctionName", aws_lambda_function.worker.function_name, { label = "errors", color = "#d62728" }],
          ["AWS/Lambda", "Throttles", "FunctionName", aws_lambda_function.worker.function_name, { label = "throttles", color = "#ff7f0e" }],
          ["AWS/Lambda", "ConcurrentExecutions", "FunctionName", aws_lambda_function.worker.function_name, { stat = "Maximum", label = "concurrent (max)" }],
          ["AWS/Lambda", "Duration", "FunctionName", aws_lambda_function.worker.function_name, { stat = "p95", label = "duration p95 (ms)", yAxis = "right" }],
        ]
        yAxis = {
          left  = { min = 0, showUnits = false }
          right = { min = 0, showUnits = false }
        }
      })
    },

    # ---- Row 5: API --------------------------------------------------------
    {
      type = "metric", x = 0, y = 24, width = 12, height = 6
      properties = merge(local.five_min, {
        title   = "API Gateway"
        stacked = false
        metrics = [
          ["AWS/ApiGateway", "Count", "ApiId", aws_apigatewayv2_api.http.id, { label = "requests" }],
          ["AWS/ApiGateway", "4xx", "ApiId", aws_apigatewayv2_api.http.id, { label = "4xx", color = "#ff7f0e" }],
          ["AWS/ApiGateway", "5xx", "ApiId", aws_apigatewayv2_api.http.id, { label = "5xx", color = "#d62728" }],
          ["AWS/ApiGateway", "Latency", "ApiId", aws_apigatewayv2_api.http.id, { stat = "p95", label = "latency p95 (ms)", yAxis = "right" }],
        ]
        yAxis = {
          left  = { min = 0, showUnits = false }
          right = { min = 0, showUnits = false }
        }
      })
    },
    {
      type = "metric", x = 12, y = 24, width = 12, height = 6
      properties = merge(local.five_min, {
        title   = "Request-path Lambdas: errors + throttles"
        stacked = false
        metrics = [
          ["AWS/Lambda", "Errors", "FunctionName", aws_lambda_function.api.function_name, { label = "api errors", color = "#d62728" }],
          ["AWS/Lambda", "Throttles", "FunctionName", aws_lambda_function.api.function_name, { label = "api throttles", color = "#ff7f0e" }],
          ["AWS/Lambda", "Errors", "FunctionName", aws_lambda_function.authorizer.function_name, { label = "authorizer errors", color = "#9467bd" }],
          ["AWS/Lambda", "Throttles", "FunctionName", aws_lambda_function.authorizer.function_name, { label = "authorizer throttles", color = "#c5b0d5" }],
          ["AWS/Lambda", "Errors", "FunctionName", aws_lambda_function.intake.function_name, { label = "intake errors", color = "#8c564b" }],
          ["AWS/Lambda", "Throttles", "FunctionName", aws_lambda_function.intake.function_name, { label = "intake throttles", color = "#c49c94" }],
        ]
        yAxis = { left = { min = 0, showUnits = false } }
      })
    },

    # ---- Row 6: uptime + existing marker metrics + WAF ----------------------
    {
      type = "metric", x = 0, y = 30, width = 8, height = 6
      properties = {
        title   = "Uptime: /health from Route53 (%)"
        region  = "us-east-1"
        view    = "timeSeries"
        stacked = false
        period  = 300
        stat    = "Average"
        metrics = [
          ["AWS/Route53", "HealthCheckPercentageHealthy", "HealthCheckId", aws_route53_health_check.app.id, { label = "healthy checkers (%)" }],
        ]
        yAxis = { left = { min = 0, max = 100, showUnits = false } }
      }
    },
    {
      type = "metric", x = 8, y = 30, width = 8, height = 6
      properties = merge(local.five_min, {
        title   = "Code-reported faults (metric filters)"
        stacked = false
        metrics = [
          [local.error_namespace, "ServerError", { label = "server errors", color = "#d62728" }],
          [local.error_namespace, "Sf311ActionFailed", { label = "311 action failed" }],
          [local.security_namespace, "MediaRejected", { label = "media rejected" }],
          [local.security_namespace, "MediaQuotaExceeded", { label = "media quota exceeded" }],
          [local.error_namespace, "ClientErrorForwardFailed", { label = "client-error forward failed" }],
          [local.error_namespace, "ClientEventForwardFailed", { label = "client-event forward failed" }],
          [local.error_namespace, "FeedbackForwardFailed", { label = "feedback forward failed" }],
        ]
        yAxis = { left = { min = 0, showUnits = false } }
      })
    },
    {
      type = "metric", x = 16, y = 30, width = 8, height = 6
      properties = {
        title   = "WAF (CloudFront): allowed vs blocked"
        region  = "us-east-1"
        view    = "timeSeries"
        stacked = false
        period  = 300
        stat    = "Sum"
        metrics = [
          ["AWS/WAFV2", "AllowedRequests", "Region", "Global", "WebACL", aws_wafv2_web_acl.web.name, "Rule", "ALL", { label = "allowed" }],
          ["AWS/WAFV2", "BlockedRequests", "Region", "Global", "WebACL", aws_wafv2_web_acl.web.name, "Rule", "ALL", { label = "blocked", color = "#d62728" }],
        ]
        yAxis = { left = { min = 0, showUnits = false } }
      }
    },
  ]
}

resource "aws_cloudwatch_dashboard" "ops" {
  dashboard_name = "${local.name_prefix}-ops"
  dashboard_body = jsonencode({
    start          = "-PT24H"
    periodOverride = "inherit"
    widgets        = local.dashboard_widgets
  })
}
