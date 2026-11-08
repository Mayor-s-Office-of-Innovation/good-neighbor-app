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
      aws_cloudwatch_log_metric_filter.insights_projection_published,
      aws_cloudwatch_log_metric_filter.insights_job_failed,
      aws_cloudwatch_metric_alarm.insights_job_failed,
      aws_cloudwatch_metric_alarm.insights_jobs_dlq_not_empty,
      aws_cloudwatch_metric_alarm.insights_jobs_queue_backlog,
      aws_cloudwatch_metric_alarm.insights_projection_stalled,
      aws_iam_role_policy.analytics_convert,
      aws_iam_role_policy.analytics_projection,
      aws_iam_role_policy.analytics_query,
      aws_iam_role_policy.insights_jobs,
      aws_lambda_event_source_mapping.insights_jobs,
      aws_lambda_function.analytics_convert,
      aws_lambda_function.analytics_query,
      aws_lambda_function.insights_jobs,
      aws_lambda_function_event_invoke_config.analytics_convert,
      aws_lambda_function_event_invoke_config.analytics_projection,
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
    error_message = "Every job file must expire at S3's shortest, 1 day (24-48 h), outliving the job lifetime in jobs.js."
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

  assert {
    condition = anytrue([
      for statement in data.aws_iam_policy_document.analytics_convert.statement :
      contains(statement.actions, "lambda:InvokeFunction") && contains(statement.resources, aws_lambda_function.analytics_projection.arn)
    ])
    error_message = "The convert role must invoke the projection Lambda, or its success destination fails silently."
  }

  assert {
    condition = anytrue([
      for statement in data.aws_iam_policy_document.analytics_projection.statement :
      contains(statement.actions, "s3:GetObject") && contains(statement.resources, "${aws_s3_bucket.analytics_lake.arn}/readings/*")
    ])
    error_message = "The projection build must read the lake's readings, or every build fails."
  }

  assert {
    condition = anytrue([
      for statement in data.aws_iam_policy_document.analytics_projection.statement :
      contains(statement.actions, "s3:PutObject") && contains(statement.resources, "${aws_s3_bucket.analytics_lake.arn}/projections/*")
    ])
    error_message = "The projection build must write projections, or no snapshot is ever published."
  }

  assert {
    condition     = aws_lambda_function_event_invoke_config.analytics_projection.maximum_event_age_in_seconds <= 3600
    error_message = "A build queued behind the one slot must not retry for hours; a later convert queues a fresh one."
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.insights_jobs_queue_backlog.evaluation_periods * aws_cloudwatch_metric_alarm.insights_jobs_queue_backlog.period + aws_cloudwatch_metric_alarm.insights_jobs_queue_backlog.threshold <= 900
    error_message = "The backlog alarm must fire by 15 minutes, before jobs.js gives up on a queued job."
  }

  assert {
    condition = (
      aws_cloudwatch_metric_alarm.insights_job_failed.metric_name == one(aws_cloudwatch_log_metric_filter.insights_job_failed.metric_transformation).name
      && aws_cloudwatch_metric_alarm.insights_job_failed.namespace == one(aws_cloudwatch_log_metric_filter.insights_job_failed.metric_transformation).namespace
      && aws_cloudwatch_log_metric_filter.insights_job_failed.log_group_name == aws_cloudwatch_log_group.insights_jobs.name
      && aws_cloudwatch_log_metric_filter.insights_job_failed.pattern == "{ $.level = \"ERROR\" && $.jobId = %.% }"
      && aws_cloudwatch_metric_alarm.insights_job_failed.threshold == 1
    )
    error_message = "One failed job must page someone; run() stores the failure, so the Lambda Errors alarm never sees it."
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.insights_jobs_dlq_not_empty.dimensions["QueueName"] == aws_sqs_queue.insights_jobs_dlq.name
    error_message = "The DLQ alarm must watch the Insights jobs DLQ."
  }

  assert {
    condition = (
      aws_cloudwatch_metric_alarm.insights_projection_stalled.metric_name == one(aws_cloudwatch_log_metric_filter.insights_projection_published.metric_transformation).name
      && aws_cloudwatch_metric_alarm.insights_projection_stalled.namespace == one(aws_cloudwatch_log_metric_filter.insights_projection_published.metric_transformation).namespace
      && aws_cloudwatch_metric_alarm.insights_projection_stalled.treat_missing_data == "breaching"
    )
    error_message = "The stalled alarm must count the published marker and treat silence as breaching, or a build that never runs goes unnoticed."
  }
}

run "insights_waf" {
  command = plan

  plan_options {
    target = [aws_wafv2_web_acl.web]
  }

  # The full list, so an added, dropped or loosened exemption fails, not only a changed count.
  assert {
    condition = anytrue([
      for rule in aws_wafv2_web_acl.web.rule : (
        length(rule.action[0].block) == 1
        && rule.statement[0].and_statement[0].statement[0].label_match_statement[0].key == "awswaf:managed:aws:core-rule-set:SizeRestrictions_Body"
        && try(jsonencode([
          for s in slice(rule.statement[0].and_statement[0].statement, 1, length(rule.statement[0].and_statement[0].statement)) : [
            for m in s.not_statement[0].statement[0].and_statement[0].statement : {
              search     = m.byte_match_statement[0].search_string
              position   = m.byte_match_statement[0].positional_constraint
              field      = length(m.byte_match_statement[0].field_to_match[0].uri_path) == 1 ? "path" : length(m.byte_match_statement[0].field_to_match[0].method) == 1 ? "method" : "other"
              transforms = sort([for t in m.byte_match_statement[0].text_transformation : "${t.priority}:${t.type}"])
            }
          ]
          ]) == jsonencode([
          for route in ["/v1/assessments:evaluate", "/admin/v1/site-imports/preview", "/admin/v1/reports/insights", "/admin/v1/reporting/trends"] : [
            { search = route, position = "EXACTLY", field = "path", transforms = ["0:NONE"] },
            { search = "POST", position = "EXACTLY", field = "method", transforms = ["0:NONE"] },
          ]
        ]), false)
      )
      if rule.name == "BodySizeRestrictionsOutsideAssessmentEvaluation"
    ])
    error_message = "The 8 KiB body rule must exempt exactly the evaluate, site-import preview, Insights report and trends POSTs, by exact, untransformed path and method, or a report of about 200 Sites is blocked or another route skips the check."
  }

  assert {
    condition = anytrue([
      for rule in aws_wafv2_web_acl.web.rule : toset([
        for o in rule.statement[0].managed_rule_group_statement[0].rule_action_override : o.name
        if length(o.action_to_use[0].count) == 1 && length(o.action_to_use[0].allow) == 0
      ]) == toset(["SizeRestrictions_BODY", "SizeRestrictions_QUERYSTRING"])
      if rule.name == "AWSManagedRulesCommonRuleSet"
    ])
    error_message = "The Common Rule Set's body and query-string size rules must only count, so the label rules below decide which routes they block; an allow would skip every later rule."
  }

  # Long reporting filters pass, but % or .. could disguise another route.
  assert {
    condition = anytrue([
      for rule in aws_wafv2_web_acl.web.rule : (
        length(rule.action[0].block) == 1
        && rule.action[0].block[0].custom_response[0].response_code == 413
        && length(rule.statement[0].and_statement[0].statement) == 2
        && rule.statement[0].and_statement[0].statement[0].label_match_statement[0].key == "awswaf:managed:aws:core-rule-set:SizeRestrictions_QueryString"
        && try(jsonencode([
          for s in rule.statement[0].and_statement[0].statement[1].or_statement[0].statement : [
            for m in(length(s.not_statement) == 1 ? s.not_statement[0].statement[0].byte_match_statement : s.byte_match_statement) : {
              negated    = length(s.not_statement) == 1
              search     = m.search_string
              position   = m.positional_constraint
              field      = length(m.field_to_match[0].uri_path) == 1 ? "path" : length(m.field_to_match[0].method) == 1 ? "method" : "other"
              transforms = sort([for t in m.text_transformation : "${t.priority}:${t.type}"])
            }
          ][0]
          ]) == jsonencode([
          { negated = true, search = "/admin/v1/reporting/", position = "STARTS_WITH", field = "path", transforms = ["0:NONE"] },
          { negated = true, search = "GET", position = "EXACTLY", field = "method", transforms = ["0:NONE"] },
          { negated = false, search = "%", position = "CONTAINS", field = "path", transforms = ["0:NONE"] },
          { negated = false, search = "..", position = "CONTAINS", field = "path", transforms = ["0:NONE"] },
        ]), false)
      )
      if rule.name == "QueryStringSizeRestrictionsOutsideInsightsReads"
    ])
    error_message = "The Insights GET read routes must be exempt from the 2 KB query-string rule by raw path with no % or .., or a filter of 100 Sites is blocked or another route skips the check."
  }
}
