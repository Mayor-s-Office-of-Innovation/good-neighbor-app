# The app Lambdas and their SQS wiring. Deployable bundles are produced by
# `npm run build:lambdas` (esbuild → backend/dist/{api,worker}/index.mjs) before
# `terraform plan`; the archive's source_code_hash drives redeploys.

# Ticket creation can run synchronously in the API or silently after analysis
# in the worker. Keep both runtimes on one configuration map so those paths
# cannot drift apart.
locals {
  sf311_lambda_environment = {
    SF311_MEDIA_BASE_URL              = "https://${var.sf311_media_domain_name}"
    GNP_311_SUBMISSION_ENABLED        = tostring(var.enable_311_submission)
    GNP_311_ASYNC_FILING              = tostring(var.enable_311_async_filing)
    SF311_CREATESR_URL                = var.sf311_createsr_url
    SF311_UPDATESR_URL                = var.sf311_updatesr_url
    SF311_AGENCY_LOOKUP_URL           = var.sf311_agency_lookup_url
    SF311_LATEST_UPDATES_URL          = var.sf311_latest_updates_url
    SF311_BASIC_AUTH_SECRET_ARN       = aws_secretsmanager_secret.sf311_basic_auth.arn
    SF311_DEFAULT_RESPONSIBLE_AGENCY  = var.sf311_default_responsible_agency
    SF311_CLASSIFIER_SERVICE_CODE_MAP = var.sf311_classifier_service_code_map
  }

  email_lambda_environment = var.enable_city_smtp_relay ? {
    EMAIL_TRANSPORT              = "smtp"
    MAIL_MANAGER_SMTP_HOST       = aws_cloudformation_stack.city_smtp_relay[0].outputs["IngressARecord"]
    MAIL_MANAGER_SMTP_USERNAME   = aws_cloudformation_stack.city_smtp_relay[0].outputs["IngressPointId"]
    MAIL_MANAGER_SMTP_SECRET_ARN = aws_secretsmanager_secret.mail_manager_ingress[0].arn
    SETUP_CODE_EMAIL_FROM        = var.city_smtp_from_address
    } : {
    EMAIL_TRANSPORT              = "ses"
    MAIL_MANAGER_SMTP_HOST       = ""
    MAIL_MANAGER_SMTP_USERNAME   = ""
    MAIL_MANAGER_SMTP_SECRET_ARN = ""
    SETUP_CODE_EMAIL_FROM        = var.setup_code_email_from
  }
}

data "archive_file" "api" {
  type        = "zip"
  source_dir  = "${path.module}/../../../backend/dist/api"
  output_path = "${path.module}/dist/api.zip"
}

data "archive_file" "authorizer" {
  type        = "zip"
  source_dir  = "${path.module}/../../../backend/dist/authorizer"
  output_path = "${path.module}/dist/authorizer.zip"
}

data "archive_file" "cognito_email_sender" {
  type        = "zip"
  source_dir  = "${path.module}/../../../backend/dist/cognito-email-sender"
  output_path = "${path.module}/dist/cognito-email-sender.zip"
}

data "archive_file" "intake" {
  type        = "zip"
  source_dir  = "${path.module}/../../../backend/dist/intake"
  output_path = "${path.module}/dist/intake.zip"
}

data "archive_file" "worker" {
  type        = "zip"
  source_dir  = "${path.module}/../../../backend/dist/worker"
  output_path = "${path.module}/dist/worker.zip"
}

data "archive_file" "analytics_export" {
  type        = "zip"
  source_dir  = "${path.module}/../../../backend/dist/analytics-export"
  output_path = "${path.module}/dist/analytics-export.zip"
}

data "archive_file" "analytics_convert" {
  type        = "zip"
  source_dir  = "${path.module}/../../../backend/dist/analytics-convert"
  output_path = "${path.module}/dist/analytics-convert.zip"
}

data "archive_file" "analytics_report" {
  type        = "zip"
  source_dir  = "${path.module}/../../../backend/dist/analytics-report"
  output_path = "${path.module}/dist/analytics-report.zip"
}

data "archive_file" "analytics_query" {
  type        = "zip"
  source_dir  = "${path.module}/../../../backend/dist/analytics-query"
  output_path = "${path.module}/dist/analytics-query.zip"
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/aws/lambda/${local.name_prefix}-api"
  retention_in_days = 365
  kms_key_id        = aws_kms_key.app.arn
  tags              = var.tags
}

resource "aws_cloudwatch_log_group" "worker" {
  name              = "/aws/lambda/${local.name_prefix}-worker"
  retention_in_days = 365
  kms_key_id        = aws_kms_key.app.arn
  tags              = var.tags
}

resource "aws_cloudwatch_log_group" "cognito_email_sender" {
  count = var.enable_cognito_custom_email_sender ? 1 : 0

  name              = "/aws/lambda/${local.name_prefix}-cognito-email-sender"
  retention_in_days = 365
  kms_key_id        = aws_kms_key.app.arn
  tags              = var.tags
}

resource "aws_lambda_function" "cognito_email_sender" {
  count = var.enable_cognito_custom_email_sender ? 1 : 0

  #checkov:skip=CKV_AWS_116:Synchronous Cognito trigger; an invocation failure must fail the originating Cognito delivery rather than enter a DLQ.
  #checkov:skip=CKV_AWS_117:Public egress is required for the authenticated Mail Manager SMTP endpoint.
  #checkov:skip=CKV_AWS_272:Code signing is not yet configured for this application.
  function_name                  = "${local.name_prefix}-cognito-email-sender"
  role                           = aws_iam_role.cognito_email_sender[0].arn
  runtime                        = "nodejs22.x"
  handler                        = "index.handler"
  filename                       = data.archive_file.cognito_email_sender.output_path
  source_code_hash               = data.archive_file.cognito_email_sender.output_base64sha256
  memory_size                    = 256
  timeout                        = 20
  kms_key_arn                    = aws_kms_key.app.arn
  reserved_concurrent_executions = 2

  tracing_config {
    mode = "Active"
  }

  environment {
    variables = {
      ADMIN_APP_URL                   = var.cognito_admin_app_url
      COGNITO_EMAIL_KMS_KEY_ARN       = aws_kms_key.cognito_email[0].arn
      EMAIL_TRANSPORT                 = "smtp"
      ENVIRONMENT                     = var.environment
      MAIL_MANAGER_SMTP_HOST          = aws_cloudformation_stack.city_smtp_relay[0].outputs["IngressARecord"]
      MAIL_MANAGER_SMTP_USERNAME      = aws_cloudformation_stack.city_smtp_relay[0].outputs["IngressPointId"]
      MAIL_MANAGER_SMTP_SECRET_ARN    = aws_secretsmanager_secret.mail_manager_ingress[0].arn
      SETUP_CODE_EMAIL_FROM           = var.city_smtp_from_address
      SETUP_CODE_EMAIL_SUBJECT_PREFIX = var.environment == "prod" ? "" : "[${var.environment}] "
    }
  }

  depends_on = [aws_cloudwatch_log_group.cognito_email_sender]
  tags       = var.tags
}

resource "aws_lambda_permission" "cognito_email_sender" {
  count = var.enable_cognito_custom_email_sender ? 1 : 0

  statement_id   = "AllowCognitoInvoke"
  action         = "lambda:InvokeFunction"
  function_name  = aws_lambda_function.cognito_email_sender[0].function_name
  principal      = "cognito-idp.amazonaws.com"
  source_account = data.aws_caller_identity.current.account_id
}

resource "aws_lambda_function" "api" {
  #checkov:skip=CKV_AWS_115:Intentional use of account unreserved concurrency for synchronized perimeter checks across 400 sites; the former cap of 10 rejected normal result reads. API Gateway matches regional account quotas; WAF rate limits and API Lambda throttle alarms remain in place.
  #checkov:skip=CKV_AWS_116:Sync API-Gateway-invoked function; failures return to the caller, so a Lambda DLQ is N/A (the worker keeps a real DLQ).
  #checkov:skip=CKV_AWS_117:No VPC — the function needs public AWS-API egress and holds no VPC-only data; revisit with VPC + endpoints.
  #checkov:skip=CKV_AWS_272:Code signing not set up for this app yet; tracked follow-up.
  function_name    = "${local.name_prefix}-api"
  role             = aws_iam_role.api.arn
  runtime          = "nodejs24.x"
  handler          = "index.handler"
  filename         = data.archive_file.api.output_path
  source_code_hash = data.archive_file.api.output_base64sha256
  memory_size      = 512
  timeout          = 29
  kms_key_arn      = aws_kms_key.app.arn

  tracing_config {
    mode = "Active"
  }

  environment {
    variables = merge({
      SHORT_CODE_ORIGIN_TOKEN     = aws_secretsmanager_secret_version.support_origin.secret_string
      DUPLICATE_DETECTION_ENABLED = tostring(var.enable_duplicate_detection)
      DYNAMO_TABLE                = aws_dynamodb_table.app.name
      COGNITO_USER_POOL_ID        = aws_cognito_user_pool.users.id
      SQS_QUEUE_URL               = aws_sqs_queue.submissions.url
      ANALYSIS_QUEUE_URL          = aws_sqs_queue.analysis.url
      S3_UPLOAD_BUCKET            = aws_s3_bucket.uploads.bucket
      S3_COMPLAINT_BUCKET         = aws_s3_bucket.complaints.bucket
      S3_COMPLIANCE_LETTER_BUCKET = aws_s3_bucket.compliance_letters.bucket
      DEMO_SITE_ID                = "demo-site"
      BEDROCK_MODEL_ID            = var.bedrock_model_id
      ANALYZER_BASE_URL           = var.analyzer_base_url
      ANALYZER_API_KEY_SECRET_ARN = aws_secretsmanager_secret.analyzer_api_key.arn
      # Device token minting (Option 4 device auth — docs/adr/0010): the api
      # Lambda mints session tokens for the registration/refresh routes.
      DEVICE_TOKEN_SECRET_SECRET_ARN  = aws_secretsmanager_secret.device_token_key.arn
      SETUP_CODE_EMAIL_REPLY_TO       = var.setup_code_email_reply_to
      SETUP_CODE_EMAIL_SUBJECT_PREFIX = var.environment == "prod" ? "" : "[${var.environment}] "
      PROVIDER_APP_URL                = var.provider_app_url
      # Business metrics (lib/metrics.js, EMF): CheckStarted / CheckCompleted.
      METRICS_NAMESPACE = local.metrics_namespace
    }, local.sf311_lambda_environment, local.email_lambda_environment)
  }

  # The source limiter trusts the viewer header only after the edge has
  # overwritten it. Wait for propagation before updating API code/configuration,
  # so old edge requests cannot enter a shared missing-identity bucket.
  depends_on = [
    aws_cloudwatch_log_group.api,
    aws_cloudfront_distribution.frontend,
  ]
  tags = var.tags
}

# Best-effort public intakes: client errors, client analytics events, user
# feedback (backend/src/lambda/intake.js). Split from the api function so the
# PostHog forward each handler awaits before answering 204 can never hold the
# api function's executions during a PostHog slowdown — the only aggregate
# bound on this anonymous traffic is the reservation below (the per-IP WAF
# rate rules cannot cap many IPs). Throttled beacons fail silently client-side.
resource "aws_cloudwatch_log_group" "intake" {
  name              = "/aws/lambda/${local.name_prefix}-intake"
  retention_in_days = 365
  kms_key_id        = aws_kms_key.app.arn
  tags              = var.tags
}

resource "aws_lambda_function" "intake" {
  #checkov:skip=CKV_AWS_116:Sync API-Gateway-invoked function; the handlers always answer 204 and never retry, so a Lambda DLQ is N/A.
  #checkov:skip=CKV_AWS_117:No VPC — the function needs public egress to PostHog; revisit with VPC + endpoints.
  #checkov:skip=CKV_AWS_272:Code signing not set up for this app yet; tracked follow-up.
  function_name    = "${local.name_prefix}-intake"
  role             = aws_iam_role.intake.arn
  runtime          = "nodejs24.x"
  handler          = "index.handler"
  filename         = data.archive_file.intake.output_path
  source_code_hash = data.archive_file.intake.output_base64sha256
  memory_size      = 256
  # Forwarders bound their own egress (events 1 s, errors/feedback 3 s), so
  # the function never needs the gateway's full 29 s.
  timeout     = 10
  kms_key_arn = aws_kms_key.app.arn
  # Initial headroom for telemetry bursts from 100 concurrent perimeter checks;
  # validate this sizing with distributed load tests and throttle metrics.
  # Keep a ceiling so anonymous traffic or slow PostHog calls cannot consume
  # the rest of the account's concurrency.
  reserved_concurrent_executions = 50

  tracing_config {
    mode = "Active"
  }

  environment {
    variables = {
      POSTHOG_API_KEY_SECRET_ARN = aws_secretsmanager_secret.posthog_project_api_key.arn
      POSTHOG_HOST               = var.posthog_host
      # Feedback destination (docs/runbooks/feedback-ops.md): plain
      # identifiers, not secrets. Empty defaults keep the forwarder log-only
      # until the surveys exist in the project (the kill switch too).
      FEEDBACK_SURVEY_ID   = var.feedback_survey_id
      FEEDBACK_QUESTION_ID = var.feedback_question_id
    }
  }

  depends_on = [aws_cloudwatch_log_group.intake]
  tags       = var.tags
}

resource "aws_lambda_permission" "intake_api_gateway" {
  statement_id  = "AllowApiGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.intake.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http.execution_arn}/*/*"
}

resource "aws_cloudwatch_log_group" "authorizer" {
  name              = "/aws/lambda/${local.name_prefix}-authorizer"
  retention_in_days = 365
  kms_key_id        = aws_kms_key.app.arn
  tags              = var.tags
}

resource "aws_lambda_function" "authorizer" {
  #checkov:skip=CKV_AWS_116:Sync API-Gateway authorizer function; verdicts return to the gateway, so a Lambda DLQ is N/A.
  #checkov:skip=CKV_AWS_117:No VPC — the function needs public AWS-API egress and holds no VPC-only data; revisit with VPC + endpoints.
  #checkov:skip=CKV_AWS_272:Code signing not set up for this app yet; tracked follow-up.
  function_name    = "${local.name_prefix}-authorizer"
  role             = aws_iam_role.authorizer.arn
  runtime          = "nodejs24.x"
  handler          = "index.handler"
  filename         = data.archive_file.authorizer.output_path
  source_code_hash = data.archive_file.authorizer.output_base64sha256
  memory_size      = 256
  timeout          = 5
  kms_key_arn      = aws_kms_key.app.arn
  # Bound the authorizer's blast radius (cost/abuse) without starving real
  # traffic: every authorizer-gated request passes through here, so the cap is
  # 20x the api function's reservation (its verdicts are cached 60s by the
  # gateway per token). 200 concurrent ≈ 12k RPS — far above honest load.
  reserved_concurrent_executions = 200

  tracing_config {
    mode = "Active"
  }

  environment {
    variables = {
      DYNAMO_TABLE                   = aws_dynamodb_table.app.name
      DEVICE_TOKEN_SECRET_SECRET_ARN = aws_secretsmanager_secret.device_token_key.arn
    }
  }

  depends_on = [aws_cloudwatch_log_group.authorizer]
  tags       = var.tags
}

resource "aws_lambda_function" "worker" {
  #checkov:skip=CKV_AWS_117:No VPC — the function needs public egress to the analyzer + AWS APIs; revisit with VPC + endpoints.
  #checkov:skip=CKV_AWS_272:Code signing not set up for this app yet; tracked follow-up.
  #checkov:skip=CKV_AWS_115:SQS-triggered worker — concurrency is bounded on the event-source mapping (scaling_config.maximum_concurrency) below, not via reserved concurrency here. This legacy worker also consumes the DynamoDB outbox stream; foreground analysis has a separate reserved worker.
  function_name    = "${local.name_prefix}-worker"
  role             = aws_iam_role.worker.arn
  runtime          = "nodejs24.x"
  handler          = "index.handler"
  filename         = data.archive_file.worker.output_path
  source_code_hash = data.archive_file.worker.output_base64sha256
  memory_size      = 1024
  timeout          = 300 # 5 min: headroom for a slow single analyzer call (photos now analyzed concurrently, so this bounds one call, not the batch)
  kms_key_arn      = aws_kms_key.app.arn
  # Background work and pre-migration analysis messages share this worker.

  tracing_config {
    mode = "Active"
  }

  # Async-invoke safety net. SQS-triggered failures redrive via the queue's own
  # redrive policy below; this covers any non-SQS async path.
  dead_letter_config {
    target_arn = aws_sqs_queue.submissions_dlq.arn
  }

  environment {
    variables = merge({
      DYNAMO_TABLE                = aws_dynamodb_table.app.name
      SQS_QUEUE_URL               = aws_sqs_queue.submissions.url
      S3_UPLOAD_BUCKET            = aws_s3_bucket.uploads.bucket
      S3_COMPLAINT_BUCKET         = aws_s3_bucket.complaints.bucket
      S3_COMPLIANCE_LETTER_BUCKET = aws_s3_bucket.compliance_letters.bucket
      ANALYZER_BASE_URL           = var.analyzer_base_url
      ANALYZER_API_KEY_SECRET_ARN = aws_secretsmanager_secret.analyzer_api_key.arn
      REVERSE_GEOCODING_ENABLED   = "true"
      # Business metrics (lib/metrics.js, EMF): Analysis* + AnalyzerLatencyMs.
      METRICS_NAMESPACE               = local.metrics_namespace
      SETUP_CODE_EMAIL_REPLY_TO       = var.setup_code_email_reply_to
      SETUP_CODE_EMAIL_SUBJECT_PREFIX = var.environment == "prod" ? "" : "[${var.environment}] "
    }, local.sf311_lambda_environment, local.email_lambda_environment)
  }

  depends_on = [aws_cloudwatch_log_group.worker]
  tags       = var.tags
}

# Dead-letter queue for submission/analyze messages that exhaust their retries.
resource "aws_sqs_queue" "submissions_dlq" {
  name                      = "${local.name_prefix}-submissions-dlq"
  kms_master_key_id         = aws_kms_key.app.arn
  message_retention_seconds = 1209600 # 14 days
  tags                      = var.tags
}

resource "aws_sqs_queue_redrive_policy" "submissions" {
  queue_url = aws_sqs_queue.submissions.id

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.submissions_dlq.arn
    # Keep in sync with MAX_FILING_ATTEMPTS in backend/src/workers/sf311-job.js.
    maxReceiveCount = 5
  })
}

resource "aws_lambda_event_source_mapping" "worker" {
  event_source_arn = aws_sqs_queue.submissions.arn
  function_name    = aws_lambda_function.worker.arn
  batch_size       = 10
  # 0 = dispatch messages the moment they arrive; do NOT wait to accumulate a
  # batch. A check's photos register (→ enqueue) staggered, gated on each photo's
  # own S3 PUT finishing, so a >0 window quantized them into waves ~window-seconds
  # apart — the fast finishers went in one invocation, stragglers waited out the
  # window and started a full window later (observed: a 5s window split 5 photos
  # 3+2 with a ~5s gap, adding ~5s of pure wait to the tail analyses). At 0 each
  # artifact is analyzed as soon as it lands. This changes only latency and the
  # TYPICAL batch size — it does NOT cap records-per-invocation (batch_size still
  # does that), so it does not change the worst-case peak concurrency below.
  maximum_batching_window_in_seconds = 0
  function_response_types            = ["ReportBatchItemFailures"]

  # Background queue; new perimeter evidence uses the dedicated analysis queue.
  scaling_config {
    maximum_concurrency = 20
  }
}

# Revocation and compliance-letter requests are committed with durable outbox
# entries. This stream mapping forwards them to the worker queue and projects
# site activity into the supervisor status read model. Projection keys do not
# match the filter, so reporting writes cannot trigger a feedback loop.
resource "aws_lambda_event_source_mapping" "revocation_outbox" {
  event_source_arn = aws_dynamodb_table.app.stream_arn
  function_name    = aws_lambda_function.worker.arn
  # TRIM_HORIZON avoids a deployment-order gap: if the updated API writes an
  # outbox row before this mapping becomes active, the retained INSERT still
  # gets dispatched. The filter keeps unrelated table history out.
  starting_position       = "TRIM_HORIZON"
  batch_size              = 10
  function_response_types = ["ReportBatchItemFailures"]

  filter_criteria {
    filter {
      pattern = jsonencode({ eventName = ["INSERT", "MODIFY"], dynamodb = { NewImage = { pk = { S = [{ prefix = "SITE#" }] } } } })
    }
    filter {
      pattern = jsonencode({ eventName = ["INSERT"], dynamodb = { NewImage = { entityType = { S = ["REVOCATION_OUTBOX", "COMPLIANCE_LETTER_OUTBOX", "SF311_OUTBOX"] } } } })
    }
  }

  depends_on = [aws_iam_role_policy.worker]
}

resource "aws_lambda_permission" "api_gateway" {
  statement_id  = "AllowApiGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http.execution_arn}/*/*"
}

resource "aws_lambda_permission" "api_gateway_authorizer" {
  statement_id  = "AllowApiGatewayInvokeAuthorizer"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.authorizer.function_name
  principal     = "apigateway.amazonaws.com"
  # Authorizer invocations use the AUTHORIZER arn form —
  # arn:aws:execute-api:<region>:<acct>:<api-id>/authorizers/<authorizer-id> —
  # with NO stage segment (unlike route invocations, whose arn carries
  # <stage>/<http-verb>/<path>; the API Gateway docs give this stage-less shape
  # for the authorizer add-permission source-arn). Wildcards stand in for the
  # authorizer id, matching the api Lambda's /*/* grant granularity above.
  source_arn = "${aws_apigatewayv2_api.http.execution_arn}/authorizers/*"
}
