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
  error_namespace    = "${local.name_prefix}-errors"
  security_namespace = "${local.name_prefix}-security"
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

# --- intake Lambda filters (client errors / client events / feedback) ---------
# The three best-effort intakes run in the intake Lambda (lambda.tf), so every
# marker-based filter below reads its log group; only the generic ServerError
# filters read the api/worker groups.

# PostHog forwarder failures (ingest down, egress broken, secret errors).
resource "aws_cloudwatch_log_metric_filter" "client_error_forward_failed" {
  name           = "${local.name_prefix}-client-error-forward-failed"
  log_group_name = aws_cloudwatch_log_group.intake.name
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
  log_group_name = aws_cloudwatch_log_group.intake.name
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

# Client analytics event forwarder failures — the events twin of
# client_error_forward_failed. Events are best-effort, so this is visibility
# rather than data loss: the WARN line still carries the event + device
# properties (event-forwarder.js), but nothing reaches PostHog while it fires.
resource "aws_cloudwatch_log_metric_filter" "client_event_forward_failed" {
  name           = "${local.name_prefix}-client-event-forward-failed"
  log_group_name = aws_cloudwatch_log_group.intake.name
  pattern        = "{ $.marker = \"ClientEventForwardFailed\" }"

  metric_transformation {
    name          = "ClientEventForwardFailed"
    namespace     = local.error_namespace
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "client_event_forward_failed" {
  alarm_name          = "${local.name_prefix}-client-event-forward-failed"
  alarm_description   = "Client analytics forwarder to PostHog is failing (ingest slow/down, egress broken, or secret misread). Events still land in CloudWatch with their device properties; fix forwarding so PostHog page views resume. Threshold is higher than the error twin because page views are frequent and the forwarder's 1 s budget trips first under PostHog latency."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  metric_name         = "ClientEventForwardFailed"
  namespace           = local.error_namespace
  period              = 300
  statistic           = "Sum"
  threshold           = 10
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.alarms.arn]
  ok_actions    = [aws_sns_topic.alarms.arn]

  tags = var.tags
}

# Validation drops on the events intake, mirroring client_error_dropped.
resource "aws_cloudwatch_log_metric_filter" "client_event_dropped" {
  name           = "${local.name_prefix}-client-event-dropped"
  log_group_name = aws_cloudwatch_log_group.intake.name
  pattern        = "{ $.marker = \"ClientEventDropped\" }"

  metric_transformation {
    name          = "ClientEventDropped"
    namespace     = local.error_namespace
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "client_event_dropped" {
  alarm_name          = "${local.name_prefix}-client-event-dropped"
  alarm_description   = "Unusually many invalid client-event payloads — possible abuse of the public intake (high threshold; single drops are normal noise)."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  threshold           = 100
  period              = 300
  namespace           = local.error_namespace
  metric_name         = "ClientEventDropped"
  statistic           = "Sum"
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.alarms.arn]

  tags = var.tags
}

# Uncaught server errors (intake), same logServerError convention.
resource "aws_cloudwatch_log_metric_filter" "intake_server_errors" {
  name           = "${local.name_prefix}-intake-server-errors"
  log_group_name = aws_cloudwatch_log_group.intake.name
  pattern        = "{ $.level = \"ERROR\" }"

  metric_transformation {
    name          = "ServerError"
    namespace     = local.error_namespace
    value         = "1"
    default_value = "0"
  }
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

# --- user feedback filters (docs/runbooks/feedback-ops.md) --------------------

# Every valid feedback submission logs one FeedbackReceived line. The alarm is
# the notification: ≥1 per 5-min bucket emails the SNS topic (recipients are
# console-managed per environment — see the plan's Decisions).
resource "aws_cloudwatch_log_metric_filter" "feedback_received" {
  name           = "${local.name_prefix}-feedback-received"
  log_group_name = aws_cloudwatch_log_group.intake.name
  pattern        = "{ $.marker = \"FeedbackReceived\" }"

  metric_transformation {
    name          = "FeedbackReceived"
    namespace     = local.error_namespace
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "feedback_received" {
  alarm_name = "${local.name_prefix}-feedback-received"
  # CloudWatch never stores feedback text (metadata-only line, see
  # handlers/feedback.js) — the submission content lives in PostHog Surveys
  # once forwarding is enabled. While the forwarder is log-only (check for
  # FeedbackLogOnly lines) the text was discarded at intake; the metrics here
  # (page/site/release/id/textLength) are the whole CloudWatch-side story.
  alarm_description   = "A user submitted app feedback. Read the note in PostHog → Surveys → 'GNP app feedback' → Results (see docs/runbooks/feedback-ops.md). If CloudWatch shows FeedbackLogOnly lines instead, forwarding is off and the note was discarded at intake — check the survey-ID env vars."
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
  log_group_name = aws_cloudwatch_log_group.intake.name
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
  log_group_name = aws_cloudwatch_log_group.intake.name
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

resource "aws_cloudwatch_log_metric_filter" "media_rejected" {
  name           = "${local.name_prefix}-media-rejected"
  log_group_name = aws_cloudwatch_log_group.worker.name
  pattern        = "{ $.marker = \"MediaRejected\" }"

  metric_transformation {
    name          = "MediaRejected"
    namespace     = local.security_namespace
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "media_rejected" {
  alarm_name          = "${local.name_prefix}-media-rejected"
  alarm_description   = "Uploaded media repeatedly failed byte, decode, type, dimension, or page-count validation. Follow docs/runbooks/media-safeguards.md."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  metric_name         = "MediaRejected"
  namespace           = local.security_namespace
  period              = 300
  statistic           = "Sum"
  threshold           = 5
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
  tags                = var.tags
}

resource "aws_cloudwatch_log_metric_filter" "media_quota_exceeded" {
  name           = "${local.name_prefix}-media-quota-exceeded"
  log_group_name = aws_cloudwatch_log_group.api.name
  pattern        = "{ $.marker = \"MediaQuotaExceeded\" }"

  metric_transformation {
    name          = "MediaQuotaExceeded"
    namespace     = local.security_namespace
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "media_quota_exceeded" {
  alarm_name          = "${local.name_prefix}-media-quota-exceeded"
  alarm_description   = "A device, check, Site, or global media quota is repeatedly exhausted. Follow docs/runbooks/media-safeguards.md."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  metric_name         = "MediaQuotaExceeded"
  namespace           = local.security_namespace
  period              = 300
  statistic           = "Sum"
  threshold           = 5
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
  tags                = var.tags
}

# 311 app actions return a stored failure result rather than throwing. Capture
# that explicit operational event from both execution paths: automatic filings
# run in the worker, while user-confirmed filings run in the API Lambda.
resource "aws_cloudwatch_log_metric_filter" "api_311_action_failures" {
  name           = "${local.name_prefix}-api-311-action-failures"
  log_group_name = aws_cloudwatch_log_group.api.name
  pattern        = "{ $.eventType = \"311_app_action_failed\" }"

  metric_transformation {
    name          = "Sf311ActionFailed"
    namespace     = local.error_namespace
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_log_metric_filter" "worker_311_action_failures" {
  name           = "${local.name_prefix}-worker-311-action-failures"
  log_group_name = aws_cloudwatch_log_group.worker.name
  pattern        = "{ $.eventType = \"311_app_action_failed\" }"

  metric_transformation {
    name          = "Sf311ActionFailed"
    namespace     = local.error_namespace
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "sf311_action_failed" {
  alarm_name          = "${local.name_prefix}-311-action-failed"
  alarm_description   = "A 311 filing action failed. Search API and worker logs for eventType=311_app_action_failed and inspect the safe failure reason."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  threshold           = 1
  period              = 300
  namespace           = local.error_namespace
  metric_name         = "Sf311ActionFailed"
  statistic           = "Sum"
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.alarms.arn]
  ok_actions    = [aws_sns_topic.alarms.arn]

  tags = var.tags
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

# --- Manager access recovery (docs/runbooks/manager-access.md) ---------------

resource "aws_cloudwatch_log_metric_filter" "manager_access_throttled" {
  name           = "${local.name_prefix}-manager-access-throttled"
  log_group_name = aws_cloudwatch_log_group.api.name
  pattern        = "{ $.marker = \"ManagerAccessThrottled\" }"

  metric_transformation {
    name          = "ManagerAccessThrottled"
    namespace     = local.security_namespace
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "manager_access_throttled" {
  alarm_name          = "${local.name_prefix}-manager-access-throttled"
  alarm_description   = "Manager recovery requests are repeatedly hitting application limits. Triage with docs/runbooks/manager-access.md; do not identify users from request logs."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  metric_name         = "ManagerAccessThrottled"
  namespace           = local.security_namespace
  period              = 300
  statistic           = "Sum"
  threshold           = 10
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.alarms.arn]

  tags = var.tags
}

resource "aws_cloudwatch_log_metric_filter" "manager_access_delivery_failed" {
  name           = "${local.name_prefix}-manager-access-delivery-failed"
  log_group_name = aws_cloudwatch_log_group.api.name
  pattern        = "{ $.marker = \"ManagerAccessDelivery\" && $.status = \"failed\" }"

  metric_transformation {
    name          = "ManagerAccessDeliveryFailed"
    namespace     = local.security_namespace
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "manager_access_delivery_failed" {
  alarm_name          = "${local.name_prefix}-manager-access-delivery-failed"
  alarm_description   = "A Site Manager recovery email failed delivery. Inspect safe ManagerAccessDelivery and manager_access_email metadata using docs/runbooks/manager-access.md."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  metric_name         = "ManagerAccessDeliveryFailed"
  namespace           = local.security_namespace
  period              = 300
  statistic           = "Sum"
  threshold           = 1
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.alarms.arn]
  ok_actions    = [aws_sns_topic.alarms.arn]

  tags = var.tags
}

resource "aws_cloudwatch_metric_alarm" "manager_access_waf_blocked" {
  # The web ACL is CLOUDFRONT-scoped (created in us-east-1), and AWS/WAFV2
  # publishes its metrics there. An alarm in the module's home region never
  # saw this metric; it has to live in us-east-1 and notify the us-east-1
  # topic (platform-alarms.tf).
  provider = aws.us_east_1

  alarm_name          = "${local.name_prefix}-manager-access-waf-blocked"
  alarm_description   = "The WAF ManagerAccessRateLimit rule is blocking a burst of public recovery requests. Triage with docs/runbooks/manager-access.md."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  metric_name         = "BlockedRequests"
  namespace           = "AWS/WAFV2"
  period              = 300
  statistic           = "Sum"
  threshold           = 10
  treat_missing_data  = "notBreaching"

  # AWS/WAFV2 dimensions are the visibility_config METRIC names, not the
  # rule/ACL names (main.tf sets both; they differ for every rule).
  dimensions = {
    Region = "Global"
    Rule   = "${local.name_prefix}-manager-access-rate"
    WebACL = aws_wafv2_web_acl.web.visibility_config[0].metric_name
  }

  alarm_actions = [aws_sns_topic.alarms_us_east_1.arn]

  tags = var.tags
}

resource "aws_cloudwatch_log_metric_filter" "manager_security_notification_failed" {
  name           = "${local.name_prefix}-manager-security-notification-failed"
  log_group_name = aws_cloudwatch_log_group.api.name
  pattern        = "{ $.marker = \"ManagerSecurityNotification\" && $.status = \"failed\" }"

  metric_transformation {
    name          = "ManagerSecurityNotificationFailed"
    namespace     = local.security_namespace
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "manager_security_notification_failed" {
  alarm_name          = "${local.name_prefix}-manager-security-notification-failed"
  alarm_description   = "A post-enrollment Site Manager security notification failed. Enrollment remains valid; restore delivery and follow docs/runbooks/manager-access.md."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  metric_name         = "ManagerSecurityNotificationFailed"
  namespace           = local.security_namespace
  period              = 300
  statistic           = "Sum"
  threshold           = 1
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.alarms.arn]
  ok_actions    = [aws_sns_topic.alarms.arn]

  tags = var.tags
}

resource "aws_cloudwatch_log_metric_filter" "revocation_operation_partial" {
  name           = "${local.name_prefix}-revocation-operation-partial"
  log_group_name = aws_cloudwatch_log_group.api.name
  pattern        = "{ $.marker = \"RevocationOperationPartial\" }"

  metric_transformation {
    name          = "RevocationOperationPartial"
    namespace     = local.security_namespace
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "revocation_operation_partial" {
  alarm_name          = "${local.name_prefix}-revocation-operation-partial"
  alarm_description   = "A Site-wide revocation invalidated canonical credentials but did not reconcile every display/legacy record. Follow docs/runbooks/device-revocation.md."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  metric_name         = "RevocationOperationPartial"
  namespace           = local.security_namespace
  period              = 300
  statistic           = "Sum"
  threshold           = 1
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.alarms.arn]
  ok_actions    = [aws_sns_topic.alarms.arn]

  tags = var.tags
}
