# Cost allocation is controlled by the billing management account. Standalone
# accounts may manage activation here; linked accounts must leave it external.
resource "aws_ce_cost_allocation_tag" "application" {
  count = var.manage_application_cost_allocation_tag ? 1 : 0

  tag_key = "Application"
  status  = "Active"
}

# Preserve the existing activation state address for environments that manage it.
moved {
  from = aws_ce_cost_allocation_tag.application
  to   = aws_ce_cost_allocation_tag.application[0]
}

resource "aws_budgets_budget" "daily_application_cost" {
  name         = "${local.name_prefix}-daily-application-cost"
  budget_type  = "COST"
  limit_amount = tostring(var.daily_cost_warning_usd)
  limit_unit   = "USD"
  time_unit    = "DAILY"

  # All Good Neighbor-attributed costs in this account, across regions.
  # Separately tagged analyzer/model costs are deliberately not included.
  cost_filter {
    name   = "TagKeyValue"
    values = [format("user:Application$%s", var.application)]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = var.daily_cost_warning_usd
    threshold_type             = "ABSOLUTE_VALUE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = var.alarm_emails
  }

  lifecycle {
    precondition {
      condition     = length(var.alarm_emails) > 0 && length(var.alarm_emails) <= 10
      error_message = "The daily cost warning requires between 1 and 10 alarm email recipients."
    }
  }

  # The budget remains configured even when activation belongs to the payer.
  depends_on = [aws_ce_cost_allocation_tag.application]
  tags       = var.tags
}
