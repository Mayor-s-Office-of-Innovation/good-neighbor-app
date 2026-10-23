# Sweep effective-dated periods in Pacific time. The closure transaction creates
# the email outbox atomically; the existing stream/queue delivers each notice.
resource "aws_cloudwatch_event_rule" "compliance_expiry" {
  name                = "${local.name_prefix}-compliance-expiry"
  description         = "Archive expired perimeter check requirements and queue end notices"
  schedule_expression = "rate(15 minutes)"
  tags                = var.tags
}

resource "aws_cloudwatch_event_target" "compliance_expiry" {
  rule  = aws_cloudwatch_event_rule.compliance_expiry.name
  arn   = aws_lambda_function.worker.arn
  input = jsonencode({ type = "expire_compliance_terms" })
}

resource "aws_lambda_permission" "compliance_expiry" {
  statement_id  = "AllowComplianceExpirySchedule"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.worker.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.compliance_expiry.arn
}
