# Offline checks of the read-only plan role, on a mock AWS provider that needs no
# credentials. They read the policy as written; only AWS can evaluate it.

mock_provider "aws" {
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }

  # The provider rejects the mock's random strings where it expects an ARN or ID.
  # Terraform 1.9, which CI runs, checks the whole module when a test cleans up.
  mock_resource "aws_cloudfront_function" {
    defaults = {
      arn = "arn:aws:cloudfront::111111111111:function/mock"
    }
  }
  mock_resource "aws_iam_role" {
    defaults = {
      arn = "arn:aws:iam::111111111111:role/mock"
    }
  }
  mock_resource "aws_kms_key" {
    defaults = {
      arn = "arn:aws:kms:us-west-2:111111111111:key/mock"
    }
  }
  mock_resource "aws_sqs_queue" {
    defaults = {
      arn = "arn:aws:sqs:us-west-2:111111111111:other-queue"
    }
  }
  mock_resource "aws_sns_topic" {
    defaults = {
      arn = "arn:aws:sns:us-west-2:111111111111:mock"
    }
  }
  mock_resource "aws_s3_bucket" {
    defaults = {
      arn = "arn:aws:s3:::mock"
    }
  }
  mock_resource "aws_apigatewayv2_api" {
    defaults = {
      execution_arn = "arn:aws:execute-api:us-west-2:111111111111:mock"
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

  mock_resource "aws_wafv2_web_acl" {
    defaults = {
      arn = "arn:aws:wafv2:us-east-1:111111111111:global/webacl/mock/00000000"
    }
  }
  mock_resource "aws_acm_certificate" {
    defaults = {
      arn = "arn:aws:acm:us-east-1:111111111111:certificate/mock"
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
  setup_code_email_identity_arn = "arn:aws:ses:us-west-2:111111111111:identity/example.org"
  provider_app_url              = "https://example.org/"
  sf311_media_domain_name       = "media.example.org"
  sf311_media_zone_id           = "Z0000000000000"
}

run "plan_role_stays_out_by_default" {
  command = plan

  plan_options {
    target = [aws_iam_role.plan]
  }

  assert {
    condition     = length(aws_iam_role.plan) == 0
    error_message = "Only an environment that names a GitHub subject gets the plan role."
  }
}

run "plan_role_needs_the_state_object" {
  command = plan

  variables {
    plan_role_github_subject = "repo:example/app:environment:dev-plan"
  }

  plan_options {
    target = [aws_iam_role_policy.plan]
  }

  expect_failures = [var.plan_role_state_object]
}

run "plan_role_is_read_only_and_tied_to_one_github_environment" {
  # Apply on the mock provider, which calls no AWS API, so the policies are built.
  command = apply

  variables {
    plan_role_github_subject = "repo:example/app:environment:dev-plan"
    plan_role_state_object   = "state-bucket/dev/terraform.tfstate"
  }

  plan_options {
    target = [
      # Terraform 1.9's test cleanup stops if it can't work out for_each keys, and
      # some come from this certificate's validation records, so it must be created.
      aws_acm_certificate.sf311_media,
      aws_iam_role_policy.plan,
      aws_iam_role_policy_attachment.plan_read_only,
    ]
  }

  assert {
    condition     = aws_iam_role_policy_attachment.plan_read_only[0].policy_arn == "arn:aws:iam::aws:policy/ReadOnlyAccess"
    error_message = "The plan role must carry AWS's read-only policy and nothing broader."
  }

  assert {
    condition = anytrue([
      for condition in data.aws_iam_policy_document.plan_assume[0].statement[0].condition :
      condition.variable == "token.actions.githubusercontent.com:sub" && condition.test == "StringEquals" && length(condition.values) == 1 && contains(condition.values, "repo:example/app:environment:dev-plan")
    ])
    error_message = "Only the named GitHub Environment may assume the plan role."
  }

  assert {
    condition = toset(one([
      for statement in data.aws_iam_policy_document.plan[0].statement : statement.actions if statement.sid == "DenyDataReads"
      ])) == toset([
      "cloudtrail:LookupEvents",
      "cognito-idp:AdminGetDevice",
      "cognito-idp:AdminGetUser",
      "cognito-idp:AdminListDevices",
      "cognito-idp:AdminListGroupsForUser",
      "cognito-idp:AdminListUserAuthEvents",
      "cognito-idp:ListUsers",
      "cognito-idp:ListUsersInGroup",
      "dynamodb:BatchGetItem",
      "dynamodb:GetItem",
      "dynamodb:GetRecords",
      "dynamodb:PartiQLSelect",
      "dynamodb:Query",
      "dynamodb:ReadDataForReplication",
      "dynamodb:Scan",
      "logs:FilterLogEvents",
      "logs:GetLogEvents",
      "logs:GetLogRecord",
      "logs:GetQueryResults",
      "logs:StartLiveTail",
      "logs:StartQuery",
      "ses:GetSuppressedDestination",
      "ses:ListSuppressedDestinations",
      "sqs:ReceiveMessage",
      "xray:BatchGetTraces",
    ])
    error_message = "A plan never needs these reads, and each returns residents' or staff data."
  }

  assert {
    condition = alltrue([
      for statement in data.aws_iam_policy_document.plan[0].statement :
      statement.sid != "DenyObjectReads" || (statement.effect == "Deny" && statement.not_resources == toset(["arn:aws:s3:::state-bucket/dev/terraform.tfstate"]))
    ])
    error_message = "The plan role may read only the state object out of S3."
  }

  assert {
    condition = anytrue([
      for statement in data.aws_iam_policy_document.plan[0].statement :
      statement.sid == "ReadLambdaEnvironments" && anytrue([for condition in statement.condition : condition.variable == "kms:ViaService"])
    ])
    error_message = "The app key may decrypt only through Lambda, so the role can't open other data it encrypts."
  }
}
