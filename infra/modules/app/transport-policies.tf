# Require TLS in transit on every SQS queue and SNS topic owned by this module.

locals {
  tls_enforced_sqs_queues = {
    submissions        = { id = aws_sqs_queue.submissions.id, arn = aws_sqs_queue.submissions.arn }
    submissions_dlq    = { id = aws_sqs_queue.submissions_dlq.id, arn = aws_sqs_queue.submissions_dlq.arn }
    analysis           = { id = aws_sqs_queue.analysis.id, arn = aws_sqs_queue.analysis.arn }
    analysis_dlq       = { id = aws_sqs_queue.analysis_dlq.id, arn = aws_sqs_queue.analysis_dlq.arn }
    sf311              = { id = aws_sqs_queue.sf311.id, arn = aws_sqs_queue.sf311.arn }
    sf311_dlq          = { id = aws_sqs_queue.sf311_dlq.id, arn = aws_sqs_queue.sf311_dlq.arn }
    client_events      = { id = aws_sqs_queue.client_events.id, arn = aws_sqs_queue.client_events.arn }
    client_events_dlq  = { id = aws_sqs_queue.client_events_dlq.id, arn = aws_sqs_queue.client_events_dlq.arn }
    duplicates         = { id = aws_sqs_queue.duplicates.id, arn = aws_sqs_queue.duplicates.arn }
    duplicates_dlq     = { id = aws_sqs_queue.duplicates_dlq.id, arn = aws_sqs_queue.duplicates_dlq.arn }
    warning_digest_dlq = { id = aws_sqs_queue.warning_digest_dlq.id, arn = aws_sqs_queue.warning_digest_dlq.arn }
    insights_jobs      = { id = aws_sqs_queue.insights_jobs.id, arn = aws_sqs_queue.insights_jobs.arn }
    insights_jobs_dlq  = { id = aws_sqs_queue.insights_jobs_dlq.id, arn = aws_sqs_queue.insights_jobs_dlq.arn }
  }

  tls_enforced_sns_topics = {
    alarms = {
      arn                  = aws_sns_topic.alarms.arn
      allow_cloudformation = true
    }
    duplicate_alarms = {
      arn                  = aws_sns_topic.duplicate_alarms.arn
      allow_cloudformation = false
    }
  }
}

resource "aws_sqs_queue_policy" "tls_only" {
  for_each = local.tls_enforced_sqs_queues

  queue_url = each.value.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "sqs:*"
        Resource  = each.value.arn
        Condition = {
          Bool = {
            "aws:SecureTransport" = "false"
          }
        }
      }
    ]
  })
}

# Attaching an explicit SNS topic policy replaces the default account policy,
# so preserve account-level IAM delegation plus CloudWatch (and CloudFormation
# stack notifications on the main alarms topic) alongside the TLS deny rule.
resource "aws_sns_topic_policy" "tls_only" {
  for_each = local.tls_enforced_sns_topics

  arn = each.value.arn
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      [
        {
          Sid       = "AllowAccountAccess"
          Effect    = "Allow"
          Principal = { AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root" }
          Action    = "SNS:*"
          Resource  = each.value.arn
        },
        {
          Sid       = "AllowCloudWatchAlarmsPublish"
          Effect    = "Allow"
          Principal = { Service = "cloudwatch.amazonaws.com" }
          Action    = "SNS:Publish"
          Resource  = each.value.arn
          Condition = {
            StringEquals = {
              "aws:SourceAccount" = data.aws_caller_identity.current.account_id
            }
          }
        },
      ],
      each.value.allow_cloudformation ? [
        {
          Sid       = "AllowCloudFormationPublish"
          Effect    = "Allow"
          Principal = { Service = "cloudformation.amazonaws.com" }
          Action    = "SNS:Publish"
          Resource  = each.value.arn
          Condition = {
            StringEquals = {
              "aws:SourceAccount" = data.aws_caller_identity.current.account_id
            }
          }
        }
      ] : [],
      [
        {
          Sid       = "DenyInsecureTransport"
          Effect    = "Deny"
          Principal = "*"
          Action    = "SNS:*"
          Resource  = each.value.arn
          Condition = {
            Bool = {
              "aws:SecureTransport" = "false"
            }
          }
        }
      ]
    )
  })
}

resource "aws_sns_topic_policy" "alarms_us_east_1_tls_only" {
  provider = aws.us_east_1

  arn = aws_sns_topic.alarms_us_east_1.arn
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AllowAccountAccess"
        Effect    = "Allow"
        Principal = { AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root" }
        Action    = "SNS:*"
        Resource  = aws_sns_topic.alarms_us_east_1.arn
      },
      {
        Sid       = "AllowCloudWatchAlarmsPublish"
        Effect    = "Allow"
        Principal = { Service = "cloudwatch.amazonaws.com" }
        Action    = "SNS:Publish"
        Resource  = aws_sns_topic.alarms_us_east_1.arn
        Condition = {
          StringEquals = {
            "aws:SourceAccount" = data.aws_caller_identity.current.account_id
          }
        }
      },
      {
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "SNS:*"
        Resource  = aws_sns_topic.alarms_us_east_1.arn
        Condition = {
          Bool = {
            "aws:SecureTransport" = "false"
          }
        }
      }
    ]
  })
}
