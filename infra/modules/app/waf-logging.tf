# The application key is regional; WAF logs need a key beside their
# CloudFront-scoped log group in us-east-1.
resource "aws_kms_key" "waf_logs" {
  provider                = aws.us_east_1
  description             = "KMS key for ${local.name_prefix} WAF logs"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "EnableIamUserPermissions"
        Effect    = "Allow"
        Principal = { AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root" }
        Action    = "kms:*"
        Resource  = "*"
      },
      {
        Sid       = "AllowCloudWatchLogs"
        Effect    = "Allow"
        Principal = { Service = "logs.us-east-1.amazonaws.com" }
        Action = [
          "kms:Encrypt",
          "kms:Decrypt",
          "kms:ReEncrypt*",
          "kms:GenerateDataKey*",
          "kms:DescribeKey"
        ]
        Resource = "*"
        Condition = {
          ArnEquals = {
            # Construct the ARN to avoid a key <-> log group dependency cycle.
            "kms:EncryptionContext:aws:logs:arn" = "arn:aws:logs:us-east-1:${data.aws_caller_identity.current.account_id}:log-group:aws-waf-logs-${local.name_prefix}"
          }
        }
      }
    ]
  })
  tags = var.tags
}

resource "aws_kms_alias" "waf_logs" {
  provider      = aws.us_east_1
  name          = "alias/${local.name_prefix}-waf-logs"
  target_key_id = aws_kms_key.waf_logs.key_id
}

# CloudFront-scoped WAF and its log destination both live in us-east-1.
resource "aws_cloudwatch_log_group" "waf" {
  provider          = aws.us_east_1
  name              = "aws-waf-logs-${local.name_prefix}"
  retention_in_days = 365
  kms_key_id        = aws_kms_key.waf_logs.arn
  tags              = var.tags
}

resource "aws_wafv2_web_acl_logging_configuration" "web" {
  provider                = aws.us_east_1
  resource_arn            = aws_wafv2_web_acl.web.arn
  log_destination_configs = [aws_cloudwatch_log_group.waf.arn]

  logging_filter {
    default_behavior = "DROP"
    filter {
      behavior    = "KEEP"
      requirement = "MEETS_ALL"
      condition {
        action_condition {
          action = "BLOCK"
        }
      }
    }
  }

  redacted_fields {
    query_string {}
  }
  dynamic "redacted_fields" {
    for_each = toset(["authorization", "cookie", "x-api-key", "referer"])
    content {
      single_header {
        name = redacted_fields.value
      }
    }
  }
}
