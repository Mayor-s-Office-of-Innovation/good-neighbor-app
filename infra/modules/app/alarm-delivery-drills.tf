# These alarms observe only an operator-published synthetic metric. Real
# service alarms, queues and application records are untouched by the drill.
resource "aws_cloudwatch_metric_alarm" "delivery_drill" {
  count = var.enable_alarm_delivery_drills ? 1 : 0

  alarm_name          = "${local.name_prefix}-TEST-alarm-delivery"
  alarm_description   = "TEST ONLY: controlled notification delivery drill. A responder must acknowledge receipt; an OK state alone does not prove email delivery."
  namespace           = "${local.name_prefix}-operations"
  metric_name         = "AlarmDeliveryTest"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
  tags                = var.tags
}

resource "aws_cloudwatch_metric_alarm" "delivery_drill_us_east_1" {
  provider = aws.us_east_1
  count    = var.enable_alarm_delivery_drills ? 1 : 0

  alarm_name          = "${local.name_prefix}-TEST-alarm-delivery-us-east-1"
  alarm_description   = "TEST ONLY: controlled notification delivery drill. A responder must acknowledge receipt; an OK state alone does not prove email delivery."
  namespace           = "${local.name_prefix}-operations"
  metric_name         = "AlarmDeliveryTest"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms_us_east_1.arn]
  ok_actions          = [aws_sns_topic.alarms_us_east_1.arn]
  tags                = var.tags
}
