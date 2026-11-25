# Offline checks of module-level security hardening invariants, on a mock AWS
# provider that needs no credentials.

mock_provider "aws" {
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

# Synthetic 12-digit mock account ID assembled without a literal account token.
override_data {
  target = data.aws_caller_identity.current
  values = {
    account_id = 1e11
  }
}

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
      aws_cloudfront_function.sf311_media_path,
      aws_cognito_user_pool.users,
      aws_cognito_user_pool_client.admin,
      aws_dynamodb_table.app,
      aws_iam_role_policy.analytics_export,
      aws_iam_role_policy.api,
      aws_iam_role_policy.authorizer,
      aws_iam_role_policy.client_events_gateway,
      aws_iam_role_policy.duplicate_dispatch,
      aws_iam_role_policy.duplicate_worker,
      aws_iam_role_policy.support,
      aws_kms_key.alarms_us_east_1,
      aws_kms_key.app,
      aws_lambda_function.api,
      aws_lambda_function.support,
      aws_lambda_permission.analytics_lake_s3,
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
        && s.Condition.StringEquals["aws:SourceAccount"] == data.aws_caller_identity.current.account_id
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
            && s.Condition.StringEquals["aws:SourceAccount"] == data.aws_caller_identity.current.account_id
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
    condition     = contains(one(aws_cognito_user_pool.users.user_attribute_update_settings).attributes_require_verification_before_update, "email")
    error_message = "Cognito user pool must require email verification before updating an email attribute."
  }

  assert {
    condition     = !contains(aws_cognito_user_pool_client.admin.write_attributes, "email") && !contains(aws_cognito_user_pool_client.admin.write_attributes, "email_verified")
    error_message = "The admin Cognito app client must not allow self-service writes to email or email_verified."
  }

  assert {
    condition = (
      !contains(keys(aws_lambda_function.support.environment[0].variables), "SUPPORT_ORIGIN_TOKEN")
      && contains(keys(aws_lambda_function.support.environment[0].variables), "SUPPORT_ORIGIN_TOKEN_SECRET_ARN")
      && !contains(keys(aws_lambda_function.api.environment[0].variables), "SHORT_CODE_ORIGIN_TOKEN")
      && contains(keys(aws_lambda_function.api.environment[0].variables), "SHORT_CODE_ORIGIN_TOKEN_SECRET_ARN")
    )
    error_message = "Origin verification tokens must be referenced by Secrets Manager ARN, never passed as plaintext Lambda environment variables."
  }

  assert {
    condition = (
      contains(keys(aws_lambda_function.support.environment[0].variables), "SUPPORT_ORIGIN_TOKEN_VERSION")
      && contains(keys(aws_lambda_function.api.environment[0].variables), "SHORT_CODE_ORIGIN_TOKEN_VERSION")
    )
    error_message = "Both origin-token consumers must carry the secret version id so a rotation restarts them instead of leaving the old token cached."
  }

  assert {
    condition = alltrue([
      for doc in [data.aws_iam_policy_document.support, data.aws_iam_policy_document.api] : (
        anytrue([
          for s in doc.statement :
          contains(s.actions, "secretsmanager:GetSecretValue") && contains(s.resources, aws_secretsmanager_secret.support_origin.arn)
        ])
        && anytrue([
          for s in doc.statement :
          contains(s.actions, "kms:Decrypt") && contains(s.resources, aws_kms_key.support_origin.arn)
        ])
      )
    ])
    error_message = "Both support and api Lambda roles must be granted GetSecretValue and kms:Decrypt on the support_origin secret and key."
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

  assert {
    condition = alltrue([
      for rule in aws_wafv2_web_acl.web.rule : alltrue(concat(
        [
          for b in try(rule.statement[0].rate_based_statement[0].scope_down_statement[0].byte_match_statement, []) :
          contains([for t in b.text_transformation : t.type], "URL_DECODE")
          && contains([for t in b.text_transformation : t.type], "NORMALIZE_PATH")
        ],
        [
          for s in try(rule.statement[0].rate_based_statement[0].scope_down_statement[0].or_statement[0].statement, []) :
          contains([for t in s.byte_match_statement[0].text_transformation : t.type], "URL_DECODE")
          && contains([for t in s.byte_match_statement[0].text_transformation : t.type], "NORMALIZE_PATH")
        ],
      ))
      if contains([
        "SupportRateLimit",
        "ClientErrorsRateLimit",
        "FeedbackRateLimit",
        "DeviceAuthRateLimit",
        "EnrollmentCodeRateLimit",
        "ManagerAccessRateLimit",
        "ClientEventsRateLimit",
      ], rule.name)
    ])
    error_message = "Every path-scoped WAF rate-limit rule must apply URL_DECODE and NORMALIZE_PATH to prevent percent-encoding and slash-normalization bypasses."
  }

  assert {
    condition     = aws_lambda_permission.analytics_lake_s3.source_account == data.aws_caller_identity.current.account_id
    error_message = "S3 invoke permission on analytics_convert must pin source_account to prevent confused-deputy invocation."
  }

  assert {
    condition = anytrue([
      for s in data.aws_iam_policy_document.authorizer.statement : (
        s.sid == "QueryLegacyProviderMemberships"
        && anytrue([
          for c in s.condition : c.test == "Null" && c.variable == "dynamodb:LeadingKeys" && contains(c.values, "false")
        ])
      )
    ])
    error_message = "Authorizer ForAllValues DynamoDB LeadingKeys condition must pair with Null = false."
  }

  assert {
    condition = anytrue([
      for s in data.aws_iam_policy_document.analytics_export.statement : (
        s.sid == "WatermarkItem"
        && anytrue([
          for c in s.condition : c.test == "ForAllValues:StringEquals" && c.variable == "dynamodb:LeadingKeys" && contains(c.values, "ANALYTICS#EXPORT")
        ])
        && anytrue([
          for c in s.condition : c.test == "Null" && c.variable == "dynamodb:LeadingKeys" && contains(c.values, "false")
        ])
      )
    ])
    error_message = "analytics_export WatermarkItem DynamoDB access must be scoped to ANALYTICS#EXPORT."
  }

  assert {
    condition = alltrue([
      for policy in [
        aws_iam_role_policy.duplicate_dispatch.policy,
        aws_iam_role_policy.duplicate_worker.policy,
        ] : alltrue([
          for s in jsondecode(policy).Statement : (
            try(s.Condition["ForAllValues:StringLike"]["dynamodb:LeadingKeys"], null) != null
            && try(s.Condition.Null["dynamodb:LeadingKeys"], null) == "false"
          )
          if contains(s.Action, "dynamodb:PutItem")
      ])
    ])
    error_message = "duplicate_dispatch and duplicate_worker dynamodb:PutItem statements must enforce LeadingKeys conditions."
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_kms_key.app.policy).Statement :
      !contains(try(tolist(s.Condition.ArnLike["kms:EncryptionContext:aws:logs:arn"]), [s.Condition.ArnLike["kms:EncryptionContext:aws:logs:arn"]]), "arn:aws:logs:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:log-group:*")
      if s.Sid == "AllowCloudWatchLogs"
    ])
    error_message = "aws_kms_key.app AllowCloudWatchLogs must scope to this application's log-group prefixes, not log-group:*."
  }
}

run "sf311_media_edge_restriction" {
  command = apply

  plan_options {
    target = [
      aws_cloudfront_distribution.sf311_media,
    ]
  }

  assert {
    condition = anytrue([
      for fa in one(aws_cloudfront_distribution.sf311_media.default_cache_behavior).function_association :
      fa.event_type == "viewer-request" && fa.function_arn == aws_cloudfront_function.sf311_media_path.arn
    ])
    error_message = "sf311_media CloudFront distribution must attach sf311_media_path viewer-request function to restrict paths to /v1/311-media."
  }
}
