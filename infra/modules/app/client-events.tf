# Client analytics events and client error reports:
# API Gateway → SQS → consumer Lambda → PostHog.
#
# POST /v1/client-events and POST /v1/client-errors used to be served by the
# intake Lambda, which awaited a PostHog round trip before answering 204. A
# four-photo perimeter check emits ~55 events, so a few concurrent users held
# every reserved slot and the function throttled (2026-11-01 load test).
# Client-side batching cut the request count; this takes the Lambda out of the
# request path altogether: the gateway's first-party SQS integration writes
# the body to a queue and answers 204, and the consumer below forwards whole
# batches to PostHog in one call. A PostHog outage now costs redeliveries (and
# ultimately dead letters) instead of dropped events.
#
# Both routes share one queue and one consumer. A static `Kind` message
# attribute set by each integration (never derived from the request) tells
# the consumer which scrub and forwarder to use.
#
# The HTTP handlers (backend/src/handlers/client-events.js, client-errors.js)
# still exist for the local dev harness and stay wired in the intake Lambda
# as a fallback: pointing a route back at aws_apigatewayv2_integration.intake
# restores the old path with no code change. See docs/runbooks/client-events.md.

# ---- Queue + dead letters ----------------------------------------------------

resource "aws_sqs_queue" "client_events_dlq" {
  name                      = "${local.name_prefix}-client-events-dlq"
  kms_master_key_id         = aws_kms_key.app.arn
  message_retention_seconds = 1209600 # 14 days
  tags                      = var.tags
}

resource "aws_sqs_queue" "client_events" {
  name                      = "${local.name_prefix}-client-events"
  kms_master_key_id         = aws_kms_key.app.arn
  message_retention_seconds = 345600 # 4 days: long enough to ride out a PostHog incident
  # ≥ 6× the consumer timeout (30 s), per the SQS event-source guidance.
  visibility_timeout_seconds = 180
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.client_events_dlq.arn
    maxReceiveCount     = 5
  })
  tags = var.tags
}

# ---- API Gateway → SQS -------------------------------------------------------

data "aws_iam_policy_document" "apigateway_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["apigateway.amazonaws.com"]
    }
    # Only API Gateway acting for this account may assume the role
    # (confused-deputy guard; the role can do nothing but enqueue anyway).
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_iam_role" "client_events_gateway" {
  name               = "${local.name_prefix}-client-events-gateway"
  assume_role_policy = data.aws_iam_policy_document.apigateway_assume.json
  tags               = var.tags
}

data "aws_iam_policy_document" "client_events_gateway" {
  statement {
    sid       = "SendClientEvents"
    effect    = "Allow"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.client_events.arn]
  }

  statement {
    # The queue is KMS-encrypted with the app key; SendMessage needs a data key.
    sid       = "EncryptWithAppKey"
    effect    = "Allow"
    actions   = ["kms:GenerateDataKey", "kms:Decrypt"]
    resources = [aws_kms_key.app.arn]
  }
}

resource "aws_iam_role_policy" "client_events_gateway" {
  name   = "${local.name_prefix}-client-events-gateway"
  role   = aws_iam_role.client_events_gateway.id
  policy = data.aws_iam_policy_document.client_events_gateway.json
}

locals {
  # One integration per intake kind. The body goes through untouched: the
  # only way to attach a request header here would be to splice it into a
  # static JSON string, and parameter mapping cannot escape it, so a header
  # containing a quote would produce a malformed request. The clients
  # therefore put their user agent in the body (frontend/src/services/
  # analytics.js and error-report.js), which $request.body carries verbatim.
  # `Kind` is a constant per integration — no request data in it — and is
  # what backend/src/lambda/client-events-consumer.js dispatches on.
  client_intake_kinds = {
    client_events = { route = "POST /v1/client-events", kind = "client-event" }
    client_errors = { route = "POST /v1/client-errors", kind = "client-error" }
  }
}

resource "aws_apigatewayv2_integration" "client_intake_queue" {
  for_each = local.client_intake_kinds

  api_id                 = aws_apigatewayv2_api.http.id
  integration_type       = "AWS_PROXY"
  integration_subtype    = "SQS-SendMessage"
  credentials_arn        = aws_iam_role.client_events_gateway.arn
  payload_format_version = "1.0" # service integrations are 1.0 only

  request_parameters = {
    QueueUrl    = aws_sqs_queue.client_events.url
    MessageBody = "$request.body"
    MessageAttributes = jsonencode({
      Kind = { DataType = "String", StringValue = each.value.kind }
    })
  }

  # SQS answers 200 with a SendMessage result body; clients expect the
  # intake's 204 and never read a body.
  response_parameters {
    status_code = "200"
    mappings = {
      "overwrite:statuscode" = "204"
    }
  }
}

# Anonymous by design, like the other intakes; the per-path WAF rate rules
# (ClientEventsRateLimit, ClientErrorsRateLimit in main.tf) and the body-size
# rule still apply in front of them.
resource "aws_apigatewayv2_route" "client_intake" {
  #checkov:skip=CKV_AWS_309:Public best-effort intakes; sendBeacon carries no credentials. Payloads are allowlist-scrubbed by the consumer and bounded by WAF.
  for_each = local.client_intake_kinds

  api_id    = aws_apigatewayv2_api.http.id
  route_key = each.value.route
  target    = "integrations/${aws_apigatewayv2_integration.client_intake_queue[each.key].id}"
}

# These two routes used to be instances of the intake route resource. Without
# the moves Terraform would plan an unordered destroy and create of the same
# route key, which API Gateway rejects as a duplicate if the create runs first;
# with them it updates each route's integration target in place.
moved {
  from = aws_apigatewayv2_route.intake["POST /v1/client-events"]
  to   = aws_apigatewayv2_route.client_intake["client_events"]
}

moved {
  from = aws_apigatewayv2_route.intake["POST /v1/client-errors"]
  to   = aws_apigatewayv2_route.client_intake["client_errors"]
}

# ---- Consumer Lambda ---------------------------------------------------------

resource "aws_cloudwatch_log_group" "client_events_consumer" {
  name              = "/aws/lambda/${local.name_prefix}-client-events-consumer"
  retention_in_days = 365
  kms_key_id        = aws_kms_key.app.arn
  tags              = var.tags
}

data "archive_file" "client_events_consumer" {
  type        = "zip"
  source_dir  = "${path.module}/../../../backend/dist/client-events-consumer"
  output_path = "${path.module}/dist/client-events-consumer.zip"
}

resource "aws_lambda_function" "client_events_consumer" {
  #checkov:skip=CKV_AWS_116:SQS-invoked; failed batches redeliver and dead-letter through the queue's redrive policy, so a Lambda DLQ is N/A.
  #checkov:skip=CKV_AWS_117:No VPC — the function needs public egress to PostHog; revisit with VPC + endpoints.
  #checkov:skip=CKV_AWS_272:Code signing not set up for this app yet; tracked follow-up.
  function_name    = "${local.name_prefix}-client-events-consumer"
  role             = aws_iam_role.client_events_consumer.arn
  runtime          = "nodejs24.x"
  handler          = "index.handler"
  filename         = data.archive_file.client_events_consumer.output_path
  source_code_hash = data.archive_file.client_events_consumer.output_base64sha256
  memory_size      = 256
  # One PostHog call per batch with a 5 s budget plus a cold-start secret read.
  timeout     = 30
  kms_key_arn = aws_kms_key.app.arn
  # Matches the event source mapping's maximum_concurrency below; a bigger
  # backlog waits in the queue rather than fanning out.
  reserved_concurrent_executions = 5

  tracing_config {
    mode = "Active"
  }

  environment {
    variables = {
      POSTHOG_API_KEY_SECRET_ARN = aws_secretsmanager_secret.posthog_project_api_key.arn
      POSTHOG_HOST               = var.posthog_host
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.client_events_consumer,
    aws_iam_role_policy.client_events_consumer,
  ]
  tags = var.tags
}

resource "aws_iam_role" "client_events_consumer" {
  name               = "${local.name_prefix}-client-events-consumer"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
  tags               = var.tags
}

data "aws_iam_policy_document" "client_events_consumer" {
  statement {
    sid    = "ConsumeQueue"
    effect = "Allow"
    actions = [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
    ]
    resources = [aws_sqs_queue.client_events.arn]
  }

  statement {
    sid       = "ReadPosthogSecret"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.posthog_project_api_key.arn]
  }

  statement {
    # Decrypt queue messages and the secret; both use the app key.
    sid       = "UseAppKey"
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.app.arn]
  }

  statement {
    sid       = "Logs"
    effect    = "Allow"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.client_events_consumer.arn}:*"]
  }

  statement {
    sid       = "XRay"
    effect    = "Allow"
    actions   = ["xray:PutTraceSegments", "xray:PutTelemetryRecords"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "client_events_consumer" {
  #checkov:skip=CKV_AWS_355:X-Ray PutTraceSegments/PutTelemetryRecords have no resource-level scope; "*" is required.
  name   = "${local.name_prefix}-client-events-consumer"
  role   = aws_iam_role.client_events_consumer.id
  policy = data.aws_iam_policy_document.client_events_consumer.json
}

resource "aws_lambda_event_source_mapping" "client_events" {
  event_source_arn = aws_sqs_queue.client_events.arn
  function_name    = aws_lambda_function.client_events_consumer.arn
  # Up to 100 bodies per PostHog call. Each body is a client-side batch the
  # WAF caps at 8 KiB (the client flushes at 6 KiB), so a full invocation
  # posts well under 1 MB to PostHog's 20 MB batch limit. A batch_size above
  # 10 requires a batching window; 5 s is invisible for analytics and lets a
  # burst coalesce.
  batch_size                         = 100
  maximum_batching_window_in_seconds = 5
  function_response_types            = ["ReportBatchItemFailures"]

  scaling_config {
    maximum_concurrency = 5
  }
}

# ---- Alarms + log metrics ----------------------------------------------------

# Same markers as the intake log group (alarms.tf) so the existing
# ClientEventForwardFailed / ClientEventDropped / ClientErrorForwardFailed /
# ClientErrorDropped alarms see both transports.
resource "aws_cloudwatch_log_metric_filter" "client_events_consumer_error_forward_failed" {
  name           = "${local.name_prefix}-client-events-consumer-error-forward-failed"
  log_group_name = aws_cloudwatch_log_group.client_events_consumer.name
  pattern        = "{ $.marker = \"ClientErrorForwardFailed\" }"

  metric_transformation {
    name          = "ClientErrorForwardFailed"
    namespace     = local.error_namespace
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_log_metric_filter" "client_events_consumer_error_dropped" {
  name           = "${local.name_prefix}-client-events-consumer-error-dropped"
  log_group_name = aws_cloudwatch_log_group.client_events_consumer.name
  pattern        = "{ $.marker = \"ClientErrorDropped\" }"

  metric_transformation {
    name          = "ClientErrorDropped"
    namespace     = local.error_namespace
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_log_metric_filter" "client_events_consumer_forward_failed" {
  name           = "${local.name_prefix}-client-events-consumer-forward-failed"
  log_group_name = aws_cloudwatch_log_group.client_events_consumer.name
  pattern        = "{ $.marker = \"ClientEventForwardFailed\" }"

  metric_transformation {
    name          = "ClientEventForwardFailed"
    namespace     = local.error_namespace
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_log_metric_filter" "client_events_consumer_dropped" {
  name           = "${local.name_prefix}-client-events-consumer-dropped"
  log_group_name = aws_cloudwatch_log_group.client_events_consumer.name
  pattern        = "{ $.marker = \"ClientEventDropped\" }"

  metric_transformation {
    name          = "ClientEventDropped"
    namespace     = local.error_namespace
    value         = "1"
    default_value = "0"
  }
}

# Uncaught errors feed the shared ServerError alarm, same convention as the
# other function log groups.
resource "aws_cloudwatch_log_metric_filter" "client_events_consumer_errors" {
  name           = "${local.name_prefix}-client-events-consumer-server-errors"
  log_group_name = aws_cloudwatch_log_group.client_events_consumer.name
  pattern        = "{ $.level = \"ERROR\" }"

  metric_transformation {
    name          = "ServerError"
    namespace     = local.error_namespace
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "client_events_dlq_not_empty" {
  alarm_name          = "${local.name_prefix}-client-events-dlq-not-empty"
  alarm_description   = "Client analytics events or error reports exhausted their redeliveries in ${aws_sqs_queue.client_events_dlq.name}: PostHog ingest has been failing for a sustained period, or the consumer is broken. The payloads are still in CloudWatch (ClientEventForwardFailed / ClientErrorForwardFailed lines carry them). Redrive the DLQ once forwarding works. See docs/runbooks/client-events.md."
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
    QueueName = aws_sqs_queue.client_events_dlq.name
  }

  alarm_actions = [aws_sns_topic.alarms.arn]
  ok_actions    = [aws_sns_topic.alarms.arn]

  tags = var.tags
}

# The consumer is not keeping up (or is not running): analytics are late.
# Ten minutes is far beyond the 5 s batching window plus a few redeliveries.
resource "aws_cloudwatch_metric_alarm" "client_events_queue_stale" {
  alarm_name          = "${local.name_prefix}-client-events-queue-stale"
  alarm_description   = "The oldest client analytics event or error report has waited over 10 minutes in ${aws_sqs_queue.client_events.name}. The consumer is throttled, erroring, or disabled; PostHog data is delayed, nothing user-facing is affected. See docs/runbooks/client-events.md."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  threshold           = 600
  period              = 300
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateAgeOfOldestMessage"
  statistic           = "Maximum"
  treat_missing_data  = "notBreaching"

  dimensions = {
    QueueName = aws_sqs_queue.client_events.name
  }

  alarm_actions = [aws_sns_topic.alarms.arn]
  ok_actions    = [aws_sns_topic.alarms.arn]

  tags = var.tags
}
