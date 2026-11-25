# Offline checks of module-level security hardening invariants, on a mock AWS
# provider that needs no credentials.

mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "aws"
    }
  }
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
  mock_resource "aws_cloudfront_function" {
    defaults = {
      arn = "arn:aws:cloudfront::aws:function/mock"
    }
  }
  mock_resource "aws_cloudfront_distribution" {
    defaults = {
      arn = "arn:aws:cloudfront::aws:distribution/EMOCK"
    }
  }
  mock_resource "aws_iam_role" {
    defaults = {
      arn = "arn:aws:iam::aws:role/mock"
    }
  }
  mock_resource "aws_kms_key" {
    defaults = {
      arn = "arn:aws:kms:us-west-2:aws:key/mock"
    }
  }
  mock_resource "aws_lambda_function" {
    defaults = {
      arn = "arn:aws:lambda:us-west-2:aws:function:mock"
    }
  }
  mock_resource "aws_sqs_queue" {
    defaults = {
      arn = "arn:aws:sqs:us-west-2:aws:mock"
      id  = "https://sqs.us-west-2.amazonaws.com/aws/mock"
    }
  }
  mock_resource "aws_sns_topic" {
    defaults = {
      arn = "arn:aws:sns:us-west-2:aws:mock"
    }
  }
  mock_resource "aws_s3_bucket" {
    defaults = {
      arn = "arn:aws:s3:::mock"
    }
  }
  mock_resource "aws_apigatewayv2_api" {
    defaults = {
      execution_arn = "arn:aws:execute-api:us-west-2:aws:mock"
    }
  }
  mock_resource "aws_cognito_user_pool" {
    defaults = {
      id = "us-west-2_mock"
    }
  }
}

mock_provider "aws" {
  alias = "us_east_1"

  mock_resource "aws_sns_topic" {
    defaults = {
      arn = "arn:aws:sns:us-east-1:aws:alarms-us-east-1"
    }
  }
  mock_resource "aws_wafv2_web_acl" {
    defaults = {
      arn = "arn:aws:wafv2:us-east-1:aws:global/webacl/mock/00000000"
    }
  }
  mock_resource "aws_acm_certificate" {
    defaults = {
      arn = "arn:aws:acm:us-east-1:aws:certificate/mock"
      domain_validation_options = [
        {
          domain_name           = "media.example.org"
          resource_record_name  = "_validation.media.example.org"
          resource_record_type  = "CNAME"
          resource_record_value = "_validation.acm-validations.aws"
        },
      ]
    }
  }
}

mock_provider "archive" {}

variables {
  application                   = "good-neighbor"
  environment                   = "test"
  data_classification           = "internal"
  tags                          = {}
  bedrock_model_id              = "test-model"
  setup_code_email_identity_arn = "arn:aws:ses:us-west-2:aws:identity/example.org"
  provider_app_url              = "https://example.org/"
  sf311_media_domain_name       = "media.example.org"
  sf311_media_zone_id           = "Z0000000000000"
}

run "storage_and_transport_hardening" {
  command = apply

  plan_options {
    target = [
      aws_acm_certificate.sf311_media,
      aws_dynamodb_table.app,
      aws_s3_bucket_ownership_controls.access_logs,
      aws_s3_bucket_server_side_encryption_configuration.access_logs,
      aws_s3_bucket_policy.access_logs,
      aws_s3_bucket_policy.frontend,
      aws_s3_bucket_policy.admin_frontend,
      aws_s3_bucket_policy.analytics_lake,
      aws_sqs_queue_policy.tls_only,
      aws_sns_topic_policy.tls_only,
      aws_sns_topic_policy.alarms_us_east_1_tls_only,
      aws_wafv2_web_acl.web,
    ]
  }

  assert {
    condition     = aws_dynamodb_table.app.deletion_protection_enabled == true
    error_message = "The application DynamoDB table must have deletion protection enabled."
  }

  assert {
    condition     = one(aws_s3_bucket_ownership_controls.access_logs.rule).object_ownership == "BucketOwnerEnforced"
    error_message = "The access-logs bucket must use BucketOwnerEnforced instead of legacy ACLs."
  }

  assert {
    condition     = one(aws_s3_bucket_server_side_encryption_configuration.access_logs.rule).apply_server_side_encryption_by_default[0].sse_algorithm == "AES256"
    error_message = "S3 server-access-log delivery requires SSE-S3 (AES256), not SSE-KMS."
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_s3_bucket_policy.access_logs.policy).Statement : (
        s.Effect == "Allow"
        && s.Principal.Service == "logging.s3.amazonaws.com"
        && s.Action == "s3:PutObject"
        && length(s.Resource) == 4
        && s.Condition.StringEquals["aws:SourceAccount"] == "aws"
      )
      if s.Sid == "AllowS3LogDelivery"
    ])
    error_message = "The access-logs bucket policy must allow logging.s3.amazonaws.com to deliver logs from all four logged buckets in this account."
  }

  assert {
    condition = alltrue([
      for policy in [
        aws_s3_bucket_policy.access_logs.policy,
        aws_s3_bucket_policy.frontend.policy,
        aws_s3_bucket_policy.admin_frontend.policy,
        aws_s3_bucket_policy.analytics_lake.policy,
        ] : anytrue([
          for s in jsondecode(policy).Statement : (
            s.Effect == "Deny"
            && s.Condition.Bool["aws:SecureTransport"] == "false"
          )
          if s.Sid == "DenyInsecureTransport"
      ])
    ])
    error_message = "Every hardened S3 bucket policy must deny requests when aws:SecureTransport is false."
  }

  assert {
    condition     = length(aws_sqs_queue_policy.tls_only) == 13
    error_message = "Expected TLS-only queue policies on all 13 SQS queues."
  }

  assert {
    condition = alltrue([
      for p in values(aws_sqs_queue_policy.tls_only) : anytrue([
        for s in jsondecode(p.policy).Statement : (
          s.Effect == "Deny"
          && s.Action == "sqs:*"
          && s.Condition.Bool["aws:SecureTransport"] == "false"
        )
        if s.Sid == "DenyInsecureTransport"
      ])
    ])
    error_message = "Every SQS queue policy must deny non-TLS transport."
  }

  assert {
    condition = alltrue([
      for policy in concat(
        [for p in values(aws_sns_topic_policy.tls_only) : p.policy],
        [aws_sns_topic_policy.alarms_us_east_1_tls_only.policy],
        ) : (
        anytrue([
          for s in jsondecode(policy).Statement : (
            s.Effect == "Deny"
            && s.Action == "SNS:*"
            && s.Condition.Bool["aws:SecureTransport"] == "false"
          )
          if s.Sid == "DenyInsecureTransport"
        ])
        && anytrue([
          for s in jsondecode(policy).Statement : (
            s.Effect == "Allow"
            && s.Principal.Service == "cloudwatch.amazonaws.com"
            && s.Action == "SNS:Publish"
            && s.Condition.StringEquals["aws:SourceAccount"] == "aws"
          )
          if s.Sid == "AllowCloudWatchAlarmsPublish"
        ])
      )
    ])
    error_message = "Every SNS topic policy must deny non-TLS transport while preserving CloudWatch Alarms publish permissions."
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_sns_topic_policy.tls_only["alarms"].policy).Statement : (
        s.Effect == "Allow"
        && s.Principal.Service == "cloudformation.amazonaws.com"
        && s.Action == "SNS:Publish"
      )
      if s.Sid == "AllowCloudFormationPublish"
    ])
    error_message = "The primary alarms topic must preserve CloudFormation stack notification publishing."
  }

  assert {
    condition = anytrue([
      for rule in aws_wafv2_web_acl.web.rule : (
        length(rule.override_action[0].none) == 1
        && rule.statement[0].managed_rule_group_statement[0].name == "AWSManagedRulesAmazonIpReputationList"
        && rule.statement[0].managed_rule_group_statement[0].vendor_name == "AWS"
        && rule.visibility_config[0].sampled_requests_enabled == false
      )
      if rule.name == "AWSManagedRulesAmazonIpReputationList"
    ])
    error_message = "WAF ACL must include AWSManagedRulesAmazonIpReputationList in blocking mode with request sampling disabled."
  }
}
