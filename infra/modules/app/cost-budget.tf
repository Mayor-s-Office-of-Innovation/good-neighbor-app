# Warning only: never stop uploads or processing because of aggregate spend.
# Cost-allocation tag activation is account-wide; this module is deployed once
# per account (dev and prod use separate accounts). If that topology changes,
# move ownership of this activation into the shared account infrastructure.
resource "aws_ce_cost_allocation_tag" "application" {
  tag_key = "Application"
  status  = "Active"
}

resource "aws_budgets_budget" "daily_application_cost" {
  name         = "${local.name_prefix}-daily-application-cost"
  budget_type  = "COST"
  limit_amount = "100"
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
    threshold                  = 100
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

  depends_on = [aws_ce_cost_allocation_tag.application]
  tags       = var.tags
}
