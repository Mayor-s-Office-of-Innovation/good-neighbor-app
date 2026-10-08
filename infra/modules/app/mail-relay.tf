locals {
  mail_manager_tags = [
    for key in sort(keys(var.tags)) : {
      Key   = key
      Value = var.tags[key]
    }
  ]
}

resource "aws_cloudwatch_log_group" "mail_manager" {
  count = var.provision_city_smtp_relay_foundation ? 1 : 0

  name              = "/aws/ses/mail-manager/${local.name_prefix}"
  retention_in_days = 365
  kms_key_id        = aws_kms_key.app.arn
  tags              = var.tags
}

resource "aws_cloudwatch_log_resource_policy" "mail_manager" {
  count = var.provision_city_smtp_relay_foundation ? 1 : 0

  policy_name = "${local.name_prefix}-mail-manager-delivery"
  policy_document = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowVendedLogDelivery"
      Effect    = "Allow"
      Principal = { Service = "delivery.logs.amazonaws.com" }
      Action    = ["logs:CreateLogStream", "logs:PutLogEvents"]
      Resource  = "${aws_cloudwatch_log_group.mail_manager[0].arn}:*"
      Condition = {
        StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.current.account_id }
      }
    }]
  })
}

# The pinned hashicorp/aws provider does not expose SES Mail Manager resources.
# Keep the gateway declarative by managing AWS's native Mail Manager and Logs
# resource types in a small CloudFormation stack owned by Terraform.
resource "aws_cloudformation_stack" "city_smtp_relay" {
  count = var.enable_city_smtp_relay ? 1 : 0

  name = "${local.name_prefix}-city-smtp-relay"
  template_body = jsonencode({
    AWSTemplateFormatVersion = "2010-09-09"
    Description              = "Authenticated SES Mail Manager gateway to the City Proofpoint SMTP relay."
    Resources = {
      CityRelay = {
        Type = "AWS::SES::MailManagerRelay"
        Properties = {
          RelayName  = "${local.name_prefix}-proofpoint"
          ServerName = var.city_smtp_relay_host
          ServerPort = var.city_smtp_relay_port
          Authentication = {
            SecretArn = aws_secretsmanager_secret.city_smtp_relay[0].arn
          }
          Tags = local.mail_manager_tags
        }
      }
      RelayRuleSet = {
        Type = "AWS::SES::MailManagerRuleSet"
        Properties = {
          RuleSetName = "${local.name_prefix}-proofpoint"
          Rules = [{
            Name = "approved-envelope-sender"
            Conditions = [{
              StringExpression = {
                Evaluate = { Attribute = "MAIL_FROM" }
                Operator = "EQUALS"
                Values   = [var.city_smtp_from_address]
              }
            }]
            Actions = [{
              Relay = {
                ActionFailurePolicy = "DROP"
                MailFrom            = "PRESERVE"
                Relay               = { "Fn::GetAtt" = ["CityRelay", "RelayId"] }
              }
            }]
          }]
          Tags = local.mail_manager_tags
        }
      }
      IngressTrafficPolicy = {
        Type = "AWS::SES::MailManagerTrafficPolicy"
        Properties = {
          TrafficPolicyName   = "${local.name_prefix}-authenticated-app-mail"
          DefaultAction       = "ALLOW"
          MaxMessageSizeBytes = 10485760
          PolicyStatements    = []
          Tags                = local.mail_manager_tags
        }
      }
      ApplicationIngress = {
        Type = "AWS::SES::MailManagerIngressPoint"
        Properties = {
          IngressPointName = "${local.name_prefix}-application-mail"
          Type             = "AUTH"
          StatusToUpdate   = "ACTIVE"
          TlsPolicy        = "REQUIRED"
          IngressPointConfiguration = {
            SecretArn = aws_secretsmanager_secret.mail_manager_ingress[0].arn
          }
          NetworkConfiguration = {
            PublicNetworkConfiguration = { IpType = "IPV4" }
          }
          RuleSetId       = { "Fn::GetAtt" = ["RelayRuleSet", "RuleSetId"] }
          TrafficPolicyId = { "Fn::GetAtt" = ["IngressTrafficPolicy", "TrafficPolicyId"] }
          Tags            = local.mail_manager_tags
        }
      }
      LogDestination = {
        Type = "AWS::Logs::DeliveryDestination"
        Properties = {
          Name                    = "${local.name_prefix}-mail-manager"
          DeliveryDestinationType = "CWL"
          DestinationResourceArn  = aws_cloudwatch_log_group.mail_manager[0].arn
          OutputFormat            = "json"
          Tags                    = local.mail_manager_tags
        }
      }
      IngressLogSource = {
        Type = "AWS::Logs::DeliverySource"
        Properties = {
          Name        = "${local.name_prefix}-mail-ingress"
          LogType     = "APPLICATION_LOGS"
          ResourceArn = { "Fn::GetAtt" = ["ApplicationIngress", "IngressPointArn"] }
          Tags        = local.mail_manager_tags
        }
      }
      RuleSetLogSource = {
        Type = "AWS::Logs::DeliverySource"
        Properties = {
          Name        = "${local.name_prefix}-mail-rules"
          LogType     = "APPLICATION_LOGS"
          ResourceArn = { "Fn::GetAtt" = ["RelayRuleSet", "RuleSetArn"] }
          Tags        = local.mail_manager_tags
        }
      }
      IngressLogDelivery = {
        Type = "AWS::Logs::Delivery"
        Properties = {
          DeliverySourceName     = { Ref = "IngressLogSource" }
          DeliveryDestinationArn = { "Fn::GetAtt" = ["LogDestination", "Arn"] }
          Tags                   = local.mail_manager_tags
        }
      }
      RuleSetLogDelivery = {
        Type = "AWS::Logs::Delivery"
        Properties = {
          DeliverySourceName     = { Ref = "RuleSetLogSource" }
          DeliveryDestinationArn = { "Fn::GetAtt" = ["LogDestination", "Arn"] }
          Tags                   = local.mail_manager_tags
        }
      }
    }
    Outputs = {
      IngressARecord = { Value = { "Fn::GetAtt" = ["ApplicationIngress", "ARecord"] } }
      IngressPointId = { Value = { "Fn::GetAtt" = ["ApplicationIngress", "IngressPointId"] } }
      RelayId        = { Value = { "Fn::GetAtt" = ["CityRelay", "RelayId"] } }
    }
  })

  depends_on = [
    aws_cloudwatch_log_resource_policy.mail_manager,
    aws_secretsmanager_secret_policy.city_smtp_relay,
    aws_secretsmanager_secret_policy.mail_manager_ingress,
  ]

  tags = var.tags
}

resource "aws_cloudwatch_log_metric_filter" "mail_manager_relay_failure" {
  count = var.provision_city_smtp_relay_foundation ? 1 : 0

  name           = "${local.name_prefix}-mail-manager-relay-failure"
  log_group_name = aws_cloudwatch_log_group.mail_manager[0].name
  pattern        = "{ $.action_metadata.action_name = \"RELAY\" && $.action_metadata.action_status = \"FAILURE\" }"

  metric_transformation {
    name          = "MailManagerRelayFailure"
    namespace     = local.error_namespace
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "mail_manager_relay_failure" {
  count = var.provision_city_smtp_relay_foundation ? 1 : 0

  alarm_name          = "${local.name_prefix}-mail-manager-relay-failure"
  alarm_description   = "SES Mail Manager could not relay application email to the City Proofpoint SMTP service. Follow docs/runbooks/city-smtp.md."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  metric_name         = "MailManagerRelayFailure"
  namespace           = local.error_namespace
  period              = 300
  statistic           = "Sum"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
  tags                = var.tags
}
