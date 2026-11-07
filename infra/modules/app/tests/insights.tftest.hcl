# Offline checks of the Insights infrastructure, on a mock AWS provider that
# needs no credentials. The mock can't evaluate IAM, so roles are proven in dev.

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

# The mock gives every queue and every bucket the same ARN, so a check that two
# ARNs match would pass even if the wrong resource were wired in.
override_resource {
  target = aws_sqs_queue.insights_jobs_dlq
  values = {
    arn = "arn:aws:sqs:us-west-2:111111111111:insights-jobs-dlq"
  }
}
override_resource {
  target = aws_sqs_queue.insights_jobs
  values = {
    arn = "arn:aws:sqs:us-west-2:111111111111:insights-jobs"
  }
}
override_resource {
  target = aws_s3_bucket.analytics_lake
  values = {
    arn = "arn:aws:s3:::analytics-lake"
  }
}
override_resource {
  target = aws_s3_bucket.insights_jobs
  values = {
    arn = "arn:aws:s3:::insights-jobs"
  }
}
override_resource {
  target = aws_lambda_function.analytics_query
  values = {
    arn = "arn:aws:lambda:us-west-2:111111111111:function:analytics-query"
  }
}
override_resource {
  target = aws_lambda_function.insights_jobs
  values = {
    arn = "arn:aws:lambda:us-west-2:111111111111:function:insights-jobs"
  }
}
override_resource {
  target = aws_lambda_function.analytics_projection
  values = {
    arn = "arn:aws:lambda:us-west-2:111111111111:function:analytics-projection"
  }
}

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

run "insights_infra" {
  # Apply on the mock provider, which calls no AWS API, so generated ARNs and IDs are known.
  command = apply

  plan_options {
    target = [
      # Terraform 1.9's test cleanup stops if it can't work out for_each keys, and
      # some come from this certificate's validation records, so it must be created.
      aws_acm_certificate.sf311_media,
      aws_apigatewayv2_route.analytics,
      aws_apigatewayv2_route.routes,
      aws_iam_role_policy.analytics_query,
      aws_iam_role_policy.insights_jobs,
      aws_lambda_event_source_mapping.insights_jobs,
      aws_lambda_function.analytics_convert,
      aws_lambda_function.analytics_query,
      aws_lambda_function.insights_jobs,
      aws_lambda_function_event_invoke_config.analytics_convert,
      aws_s3_bucket_lifecycle_configuration.insights_jobs,
    ]
  }

  assert {
    condition = alltrue([
      for route in aws_apigatewayv2_route.analytics :
      route.authorization_type == "JWT" && route.authorizer_id == aws_apigatewayv2_authorizer.admin_jwt.id
    ])
    error_message = "Every Insights route must use admin_jwt, so no data is reachable without a login."
  }

  assert {
    condition     = length(aws_apigatewayv2_route.analytics) == 12
    error_message = "Expected the 12 Insights routes."
  }

  assert {
    condition = length([
      for key in concat(keys(aws_apigatewayv2_route.analytics), keys(aws_apigatewayv2_route.routes)) :
      key if strcontains(key, "/admin/v1/analytics/")
    ]) == 0
    error_message = "The old Analytics routes must be gone, so no retired endpoint stays exposed."
  }

  assert {
    condition     = aws_sqs_queue.insights_jobs.visibility_timeout_seconds >= 6 * aws_lambda_function.insights_jobs.timeout
    error_message = "The visibility timeout must be six times the jobs Lambda's timeout, or a running job is handed out twice."
  }

  assert {
    condition     = aws_lambda_function.insights_jobs.timeout > aws_lambda_function.analytics_query.timeout
    error_message = "Jobs need longer than the 29 s the gateway allows the query Lambda, or a large export never finishes."
  }

  assert {
    condition     = jsondecode(aws_sqs_queue.insights_jobs.redrive_policy).maxReceiveCount == 5
    error_message = "Five deliveries, like the other queues, so throttling can't dead-letter a job that never ran."
  }

  assert {
    condition     = aws_lambda_event_source_mapping.insights_jobs.event_source_arn == aws_sqs_queue.insights_jobs.arn
    error_message = "The mapping must read the Insights job queue."
  }

  assert {
    condition     = aws_lambda_event_source_mapping.insights_jobs.function_name == aws_lambda_function.insights_jobs.arn
    error_message = "The jobs Lambda must run the jobs, not the query Lambda with its 29 s timeout."
  }

  assert {
    condition     = aws_lambda_event_source_mapping.insights_jobs.batch_size == 1
    error_message = "Batch size must be 1, so a large export gets the jobs Lambda's whole timeout."
  }

  assert {
    condition     = contains(aws_lambda_event_source_mapping.insights_jobs.function_response_types, "ReportBatchItemFailures")
    error_message = "The jobs Lambda reports failed jobs one by one, so the mapping must read that reply."
  }

  assert {
    condition     = jsondecode(aws_sqs_queue.insights_jobs.redrive_policy).deadLetterTargetArn == aws_sqs_queue.insights_jobs_dlq.arn
    error_message = "A DLQ must be attached, so failing jobs stop retrying."
  }

  assert {
    condition = anytrue([
      for rule in aws_s3_bucket_lifecycle_configuration.insights_jobs.rule :
      rule.status == "Enabled" && rule.expiration[0].days == 1 && rule.filter[0].prefix == ""
    ])
    error_message = "Every job file must expire after 1 day, matching the job lifetime in jobs.js."
  }

  assert {
    condition = alltrue([
      for fn in [aws_lambda_function.analytics_query, aws_lambda_function.insights_jobs] :
      fn.environment[0].variables["INSIGHTS_JOBS_BUCKET"] == aws_s3_bucket.insights_jobs.bucket
    ])
    error_message = "Without INSIGHTS_JOBS_BUCKET, export and report jobs return 503."
  }

  assert {
    condition = alltrue([
      for fn in [aws_lambda_function.analytics_query, aws_lambda_function.insights_jobs] :
      fn.environment[0].variables["INSIGHTS_JOBS_QUEUE_URL"] == aws_sqs_queue.insights_jobs.url
    ])
    error_message = "Without INSIGHTS_JOBS_QUEUE_URL, export and report jobs return 503."
  }

  assert {
    condition = alltrue([
      for policy in [data.aws_iam_policy_document.analytics_query, data.aws_iam_policy_document.insights_jobs] :
      anytrue([
        for statement in policy.statement :
        contains(statement.actions, "s3:ListBucket") && contains(statement.resources, aws_s3_bucket.analytics_lake.arn)
      ])
    ])
    error_message = "Without ListBucket on the lake, a missing latest.json answers 403 and Insights shows an error, not 'not ready'."
  }

  assert {
    condition = alltrue([
      for policy in [data.aws_iam_policy_document.analytics_query, data.aws_iam_policy_document.insights_jobs] :
      anytrue([
        for statement in policy.statement :
        contains(statement.actions, "s3:GetObject") && contains(statement.resources, "${aws_s3_bucket.analytics_lake.arn}/projections/*")
      ])
    ])
    error_message = "Both Lambdas must read the projections, or the pages and the jobs have no data."
  }

  assert {
    condition = alltrue([
      for policy in [data.aws_iam_policy_document.analytics_query, data.aws_iam_policy_document.insights_jobs] :
      anytrue([
        for statement in policy.statement :
        contains(statement.actions, "s3:ListBucket") && contains(statement.resources, aws_s3_bucket.insights_jobs.arn)
      ])
    ])
    error_message = "Without ListBucket on the jobs bucket, S3 answers a missing job with 403 and every new job fails."
  }

  assert {
    condition     = aws_lambda_function.analytics_projection.reserved_concurrent_executions == 1
    error_message = "One projection build at a time, so two can't race on latest.json."
  }

  assert {
    condition     = aws_lambda_function_event_invoke_config.analytics_convert.function_name == aws_lambda_function.analytics_convert.function_name
    error_message = "The build must start when convert succeeds, so the destination belongs on the convert Lambda."
  }

  assert {
    condition     = one(aws_lambda_function_event_invoke_config.analytics_convert.destination_config[0].on_success).destination == aws_lambda_function.analytics_projection.arn
    error_message = "Each successful convert must start a projection build, or Insights goes stale."
  }
}
