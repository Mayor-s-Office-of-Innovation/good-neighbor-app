# The two Lambdas and their SQS wiring. Deployable bundles are produced by
# `npm run build:lambdas` (esbuild → backend/dist/{api,worker}/index.mjs) before
# `terraform plan`; the archive's source_code_hash drives redeploys.

data "archive_file" "api" {
  type        = "zip"
  source_dir  = "${path.module}/../../../backend/dist/api"
  output_path = "${path.module}/dist/api.zip"
}

data "archive_file" "worker" {
  type        = "zip"
  source_dir  = "${path.module}/../../../backend/dist/worker"
  output_path = "${path.module}/dist/worker.zip"
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

resource "aws_lambda_function" "api" {
  #checkov:skip=CKV_AWS_116:Sync API-Gateway-invoked function; failures return to the caller, so a Lambda DLQ is N/A (the worker keeps a real DLQ).
  #checkov:skip=CKV_AWS_117:No VPC — the function needs public AWS-API egress and holds no VPC-only data; revisit with VPC + endpoints.
  #checkov:skip=CKV_AWS_272:Code signing not set up for this app yet; tracked follow-up.
  function_name                  = "${local.name_prefix}-api"
  role                           = aws_iam_role.api.arn
  runtime                        = "nodejs22.x"
  handler                        = "index.handler"
  filename                       = data.archive_file.api.output_path
  source_code_hash               = data.archive_file.api.output_base64sha256
  memory_size                    = 512
  timeout                        = 29
  kms_key_arn                    = aws_kms_key.app.arn
  reserved_concurrent_executions = 10

  tracing_config {
    mode = "Active"
  }

  environment {
    variables = {
      DYNAMO_TABLE     = aws_dynamodb_table.app.name
      SQS_QUEUE_URL    = aws_sqs_queue.submissions.url
      S3_UPLOAD_BUCKET = aws_s3_bucket.uploads.bucket
      DEMO_SITE_ID     = "demo-site"
      BEDROCK_MODEL_ID = var.bedrock_model_id
    }
  }

  depends_on = [aws_cloudwatch_log_group.api]
  tags       = var.tags
}

resource "aws_lambda_function" "worker" {
  #checkov:skip=CKV_AWS_117:No VPC — the function needs public egress to the analyzer + AWS APIs; revisit with VPC + endpoints.
  #checkov:skip=CKV_AWS_272:Code signing not set up for this app yet; tracked follow-up.
  #checkov:skip=CKV_AWS_115:SQS-triggered worker — concurrency is bounded on the event-source mapping (scaling_config.maximum_concurrency) below, not via reserved concurrency here. Reserved concurrency on an SQS trigger causes throttling→DLQ failures (see comment below).
  function_name    = "${local.name_prefix}-worker"
  role             = aws_iam_role.worker.arn
  runtime          = "nodejs22.x"
  handler          = "index.handler"
  filename         = data.archive_file.worker.output_path
  source_code_hash = data.archive_file.worker.output_base64sha256
  memory_size      = 1024
  timeout          = 300 # 5 min: headroom for a slow single analyzer call (photos now analyzed concurrently, so this bounds one call, not the batch)
  kms_key_arn      = aws_kms_key.app.arn
  # Concurrency is bounded on the SQS event-source mapping below via
  # `scaling_config.maximum_concurrency`, NOT via reserved concurrency here.
  # Reserved concurrency on an SQS trigger causes throttling-induced failures
  # that redrive to the DLQ (AWS docs: don't set it below 5 with SQS); the ESM
  # cap bounds the drain rate without that side effect. The true downstream
  # limit is the Bedrock (Sonnet 4, us-east-1) RPM/TPM quota.

  tracing_config {
    mode = "Active"
  }

  # Async-invoke safety net. SQS-triggered failures redrive via the queue's own
  # redrive policy below; this covers any non-SQS async path.
  dead_letter_config {
    target_arn = aws_sqs_queue.submissions_dlq.arn
  }

  environment {
    variables = {
      DYNAMO_TABLE                = aws_dynamodb_table.app.name
      SQS_QUEUE_URL               = aws_sqs_queue.submissions.url
      S3_UPLOAD_BUCKET            = aws_s3_bucket.uploads.bucket
      ANALYZER_BASE_URL           = var.analyzer_base_url
      ANALYZER_API_KEY_SECRET_ARN = aws_secretsmanager_secret.analyzer_api_key.arn
    }
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
    maxReceiveCount     = 5
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
  # artifact is analyzed as soon as it lands. Peak concurrency is unchanged — it's
  # bounded by scaling_config.maximum_concurrency below, not by batching. The only
  # trade-off is smaller batches → more worker invocations, whose in-process
  # fan-out simply moves to across-instance concurrency (which has headroom).
  maximum_batching_window_in_seconds = 0
  function_response_types            = ["ReportBatchItemFailures"]

  # Bound how many worker invocations SQS drives concurrently. With no batching
  # window each invocation typically carries a single artifact, so peak Bedrock
  # calls ≈ maximum_concurrency (co-arriving photos may still share a batch and
  # fan out in-process, but that no longer changes the peak).
  #
  # 20 → up to ~20 concurrent Sonnet 4 calls at burst (one artifact per invocation
  # now that there's no batching window; was ~60 when a batch carried ~3 photos).
  # This REQUIRES a Bedrock quota increase (us-east-1, cross-region Sonnet 4) above
  # the defaults, or the app throttles (429 → SQS redrive). At ~8,500 tokens/call
  # the target is roughly:
  #   TPM ≥ 2,500,000  (default 200,000)   ← binding limit
  #   RPM ≥ 500        (default 200)
  # These targets were sized on the old ~60-call peak, so they now carry extra
  # headroom; prompt caching (#2) + output trim (#3) in the analyzer cut per-call
  # tokens further. Keep the conservative sizing for burst safety. Valid range 2–1000.
  scaling_config {
    maximum_concurrency = 20
  }
}

resource "aws_lambda_permission" "api_gateway" {
  statement_id  = "AllowApiGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http.execution_arn}/*/*"
}
