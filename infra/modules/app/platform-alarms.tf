# Platform-level alarms. Context and conventions: docs/runbooks/observability.md.
#
# alarms.tf watches what the CODE says (marker / level metric filters). This
# file watches what the PLATFORM says — the AWS/* namespaces — so failures the
# code never gets to log (crashes, timeouts, throttles, a queue backing up,
# messages dead-lettering, the gateway timing out an integration) still page.
# Same SNS topic, same recipients. Thresholds are starting points; tune after
# a couple of weeks of real data.

# ---- Queue ------------------------------------------------------------------

# Highest-value alarm here: before it, a photo that exhausted its 5 retries
# landed in the DLQ silently and the user saw "Analysis didn't finish" with
# nobody paged.
resource "aws_cloudwatch_metric_alarm" "submissions_dlq_not_empty" {
  alarm_name          = "${local.name_prefix}-submissions-dlq-not-empty"
  alarm_description   = "At least one submission/analyze/translate message exhausted its retries and is sitting in the dead-letter queue. Inspect the DLQ body (ids only, never media), find the matching logServerError lines in the worker log group, fix, then redrive from the SQS console. See docs/runbooks/observability.md."
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
    QueueName = aws_sqs_queue.submissions_dlq.name
  }

  alarm_actions = [aws_sns_topic.alarms.arn]
  ok_actions    = [aws_sns_topic.alarms.arn]

  tags = var.tags
}

# The worker is falling behind (analyzer slow, concurrency cap hit, or the
# worker is failing and redelivering). 600 s is well before the 1800 s
# visibility timeout × 5 receives that precede dead-lettering, so this fires
# while the backlog is still recoverable.
resource "aws_cloudwatch_metric_alarm" "submissions_queue_backlog" {
  alarm_name          = "${local.name_prefix}-submissions-queue-backlog"
  alarm_description   = "The oldest message on the submissions queue has waited more than 10 minutes: the worker is behind (slow analyzer, concurrency cap, or repeated failures). Check AnalyzerLatencyMs and the worker error alarms."
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
    QueueName = aws_sqs_queue.submissions.name
  }

  alarm_actions = [aws_sns_topic.alarms.arn]
  ok_actions    = [aws_sns_topic.alarms.arn]

  tags = var.tags
}

# ---- Lambda -----------------------------------------------------------------

locals {
  # Function → error threshold per 5 min. The intake is best-effort public
  # traffic, so it gets a higher bar than the user-facing api/authorizer and
  # the worker. Errors here are invocation errors the platform counts
  # (uncaught throw, timeout, out-of-memory) — a superset of what the
  # logServerError filters see, since a timeout or OOM never reaches them.
  lambda_error_alarms = {
    api        = { function = aws_lambda_function.api.function_name, threshold = 3 }
    worker     = { function = aws_lambda_function.worker.function_name, threshold = 3 }
    authorizer = { function = aws_lambda_function.authorizer.function_name, threshold = 3 }
    intake     = { function = aws_lambda_function.intake.function_name, threshold = 5 }
  }

  # A throttle on these is a user-visible failure (api: reserved concurrency
  # 10; authorizer: 200). The worker is capped on its event-source mapping and
  # must never throttle; if it does the cap is misconfigured.
  lambda_throttle_alarms = {
    api        = aws_lambda_function.api.function_name
    authorizer = aws_lambda_function.authorizer.function_name
    worker     = aws_lambda_function.worker.function_name
  }
}

resource "aws_cloudwatch_metric_alarm" "lambda_errors" {
  for_each = local.lambda_error_alarms

  alarm_name          = "${local.name_prefix}-${each.key}-lambda-errors"
  alarm_description   = "The ${each.key} Lambda reported invocation errors (uncaught throw, timeout, or out-of-memory). Timeouts and OOMs never reach the logServerError filters, so this is the only alarm for them. Check the function's log group for Task timed out / Runtime exited lines."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  threshold           = each.value.threshold
  period              = 300
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  statistic           = "Sum"
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = each.value.function
  }

  alarm_actions = [aws_sns_topic.alarms.arn]
  ok_actions    = [aws_sns_topic.alarms.arn]

  tags = var.tags
}

resource "aws_cloudwatch_metric_alarm" "lambda_throttles" {
  for_each = local.lambda_throttle_alarms

  alarm_name          = "${local.name_prefix}-${each.key}-lambda-throttles"
  alarm_description   = "The ${each.key} Lambda was throttled. For api/authorizer this is a user-facing failure (raise the reservation or find the burst). For the worker it should be impossible (event-source maximum_concurrency bounds it) — check lambda.tf."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  threshold           = 1
  period              = 300
  namespace           = "AWS/Lambda"
  metric_name         = "Throttles"
  statistic           = "Sum"
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = each.value
  }

  alarm_actions = [aws_sns_topic.alarms.arn]
  ok_actions    = [aws_sns_topic.alarms.arn]

  tags = var.tags
}

# Early warning that analyzer calls are approaching the worker's 300 s
# timeout (a timeout surfaces as a Lambda error + a redelivery, so catching the
# climb first is cheaper than catching the cliff).
resource "aws_cloudwatch_metric_alarm" "worker_duration_high" {
  alarm_name          = "${local.name_prefix}-worker-duration-high"
  alarm_description   = "Worker p95 duration is above 4 minutes against a 5-minute timeout: analyzer calls are running long. Check AnalyzerLatencyMs by Kind before the next step is a timeout and a redelivery."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  threshold           = 240000
  period              = 300
  namespace           = "AWS/Lambda"
  metric_name         = "Duration"
  extended_statistic  = "p95"
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = aws_lambda_function.worker.function_name
  }

  alarm_actions = [aws_sns_topic.alarms.arn]
  ok_actions    = [aws_sns_topic.alarms.arn]

  tags = var.tags
}

# ---- API Gateway ------------------------------------------------------------

# The gateway's own view of failures: includes integration timeouts (the api
# Lambda's 29 s cap) and authorizer failures that the Lambda log groups never
# record as a 5xx.
resource "aws_cloudwatch_metric_alarm" "api_5xx" {
  alarm_name          = "${local.name_prefix}-api-5xx"
  alarm_description   = "API Gateway returned more than 5 server errors in 5 minutes. Query the api_gw access-log group on status >= 500 and integrationErr to see whether it is the Lambda, the authorizer, or a gateway timeout."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  threshold           = 5
  period              = 300
  namespace           = "AWS/ApiGateway"
  metric_name         = "5xx"
  statistic           = "Sum"
  treat_missing_data  = "notBreaching"

  dimensions = {
    ApiId = aws_apigatewayv2_api.http.id
  }

  alarm_actions = [aws_sns_topic.alarms.arn]
  ok_actions    = [aws_sns_topic.alarms.arn]

  tags = var.tags
}

# ---- DynamoDB ---------------------------------------------------------------

# On-demand tables still throttle on a hot partition (one busy SITE# key) or
# during a burst beyond the previous peak. Any throttle is a failed app call.
resource "aws_cloudwatch_metric_alarm" "dynamodb_throttles" {
  alarm_name          = "${local.name_prefix}-dynamodb-throttles"
  alarm_description   = "The app table throttled reads or writes. On-demand capacity still throttles a hot partition; find the busy SITE# key via Contributor Insights or the api logs around the alarm time."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  threshold           = 1
  treat_missing_data  = "notBreaching"

  metric_query {
    id          = "throttles"
    expression  = "reads + writes"
    label       = "Read + write throttle events"
    return_data = true
  }

  metric_query {
    id = "reads"
    metric {
      namespace   = "AWS/DynamoDB"
      metric_name = "ReadThrottleEvents"
      period      = 300
      stat        = "Sum"
      dimensions = {
        TableName = aws_dynamodb_table.app.name
      }
    }
  }

  metric_query {
    id = "writes"
    metric {
      namespace   = "AWS/DynamoDB"
      metric_name = "WriteThrottleEvents"
      period      = 300
      stat        = "Sum"
      dimensions = {
        TableName = aws_dynamodb_table.app.name
      }
    }
  }

  alarm_actions = [aws_sns_topic.alarms.arn]
  ok_actions    = [aws_sns_topic.alarms.arn]

  tags = var.tags
}

# ---- Uptime (Route53 health check) -----------------------------------------
#
# An external probe of the public app hostname's /health route (CloudFront →
# API Gateway → api Lambda), checked every 30 s from Route53's global
# checkers. Route53 publishes the HealthCheckStatus / HealthCheckPercentageHealthy
# metrics in us-east-1 ONLY, and a CloudWatch alarm can only notify an SNS
# topic in its own region — hence the us-east-1 topic + key below (also used
# by the CloudFront-scoped WAF alarm in alarms.tf, whose metric lives there
# too). Recipients are the same var.alarm_emails list, so each address gets a
# second confirmation email for the us-east-1 topic.

locals {
  # Prefer the custom domain (what users and the WAF see); fall back to the
  # distribution's own hostname for alias-less deployments.
  app_public_host = length(var.frontend_domain_names) > 0 ? var.frontend_domain_names[0] : aws_cloudfront_distribution.frontend.domain_name
}

resource "aws_route53_health_check" "app" {
  fqdn              = local.app_public_host
  port              = 443
  type              = "HTTPS"
  resource_path     = "/health"
  request_interval  = 30
  failure_threshold = 3
  measure_latency   = false
  enable_sni        = true

  tags = merge(var.tags, { Name = "${local.name_prefix}-app-health" })
}

resource "aws_kms_key" "alarms_us_east_1" {
  provider = aws.us_east_1

  description             = "KMS key for the ${var.application} ${var.environment} us-east-1 alarm topic"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "EnableIamUserPermissions"
        Effect = "Allow"
        Principal = {
          AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"
        }
        Action   = "kms:*"
        Resource = "*"
      },
      {
        # Mirrors AllowCloudWatchAlarmsPublish on aws_kms_key.app (main.tf).
        Sid    = "AllowCloudWatchAlarmsPublish"
        Effect = "Allow"
        Principal = {
          Service = "cloudwatch.amazonaws.com"
        }
        Action = [
          "kms:Decrypt",
          "kms:GenerateDataKey*"
        ]
        Resource = "*"
        Condition = {
          StringEquals = {
            "aws:SourceAccount" = "${data.aws_caller_identity.current.account_id}"
          }
        }
      }
    ]
  })
  tags = var.tags
}

resource "aws_kms_alias" "alarms_us_east_1" {
  provider = aws.us_east_1

  name          = "alias/${local.name_prefix}-alarms-us-east-1"
  target_key_id = aws_kms_key.alarms_us_east_1.key_id
}

resource "aws_sns_topic" "alarms_us_east_1" {
  provider = aws.us_east_1

  name              = "${local.name_prefix}-alarms-us-east-1"
  kms_master_key_id = aws_kms_key.alarms_us_east_1.arn
  tags              = var.tags
}

resource "aws_sns_topic_subscription" "alarm_emails_us_east_1" {
  provider = aws.us_east_1
  for_each = toset(var.alarm_emails)

  topic_arn = aws_sns_topic.alarms_us_east_1.arn
  protocol  = "email"
  endpoint  = each.value
}

resource "aws_cloudwatch_metric_alarm" "app_health_check" {
  provider = aws.us_east_1

  alarm_name          = "${local.name_prefix}-app-health-check"
  alarm_description   = "Route53 health checkers cannot get a 2xx/3xx from https://${local.app_public_host}/health for 3 consecutive minutes. Missing data is treated as unhealthy. Check CloudFront, API Gateway, and the api Lambda in that order."
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  threshold           = 1
  period              = 60
  namespace           = "AWS/Route53"
  metric_name         = "HealthCheckStatus"
  statistic           = "Minimum"
  treat_missing_data  = "breaching"

  dimensions = {
    HealthCheckId = aws_route53_health_check.app.id
  }

  alarm_actions = [aws_sns_topic.alarms_us_east_1.arn]
  ok_actions    = [aws_sns_topic.alarms_us_east_1.arn]

  tags = var.tags
}
