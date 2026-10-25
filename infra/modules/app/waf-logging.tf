# CloudFront-scoped WAF and its log destination both live in us-east-1.
resource "aws_cloudwatch_log_group" "waf" {
  provider          = aws.us_east_1
  name              = "aws-waf-logs-${local.name_prefix}"
  retention_in_days = 14
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
