variable "enable_support_chat" {
  description = "Enable grounded support answers after the dev evaluation. False is the kill switch; Help still offers email."
  type        = bool
  default     = false
}

variable "support_model_id" {
  description = "Regional Bedrock text model for support (no tools or cross-region profiles)."
  type        = string
  default     = "amazon.nova-lite-v1:0"
  validation {
    condition     = can(regex("^[a-z0-9-]+\\.[a-zA-Z0-9.:-]+$", var.support_model_id)) && !startswith(var.support_model_id, "us.")
    error_message = "Use a regional foundation model ID, not an ARN or cross-region inference profile."
  }
}

# Generated in CI, persisted once, never checked into source. This header is
# supplied only by the field-app distribution; direct API calls fail closed.
data "aws_secretsmanager_random_password" "support_origin" {
  password_length     = 48
  exclude_punctuation = true
}

# The app key policy references CloudFront. This independent key avoids a
# CloudFront -> origin secret -> app key -> CloudFront dependency cycle.
resource "aws_kms_key" "support_origin" {
  description             = "Encrypt the support origin-verification token"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  tags                    = var.tags
}

resource "aws_secretsmanager_secret" "support_origin" {
  name                    = "${local.name_prefix}-support-origin"
  kms_key_id              = aws_kms_key.support_origin.arn
  recovery_window_in_days = 30
  tags                    = var.tags
}

resource "aws_secretsmanager_secret_version" "support_origin" {
  secret_id     = aws_secretsmanager_secret.support_origin.id
  secret_string = data.aws_secretsmanager_random_password.support_origin.random_password
  lifecycle {
    ignore_changes = [secret_string]
  }
}

data "archive_file" "support" {
  type        = "zip"
  source_dir  = "${path.module}/../../../backend/dist/support"
  output_path = "${path.module}/dist/support.zip"
}

resource "aws_cloudwatch_log_group" "support" {
  name              = "/aws/lambda/${local.name_prefix}-support"
  retention_in_days = 365
  kms_key_id        = aws_kms_key.app.arn
  tags              = var.tags
}

resource "aws_iam_role" "support" {
  name               = "${local.name_prefix}-support"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
  tags               = var.tags
}

data "aws_iam_policy_document" "support" {
  statement {
    actions   = ["bedrock:InvokeModel"]
    resources = ["arn:aws:bedrock:${data.aws_region.current.name}::foundation-model/${var.support_model_id}"]
  }
  statement {
    # Regional configuration read only: the function refuses inference if
    # invocation logging could retain question/answer text.
    actions   = ["bedrock:GetModelInvocationLoggingConfiguration"]
    resources = ["*"]
  }
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.support.arn}:*"]
  }
  statement {
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.app.arn]
  }
}

resource "aws_iam_role_policy" "support" {
  #checkov:skip=CKV_AWS_355:GetModelInvocationLoggingConfiguration is a regional settings read with no resource-level scope.
  name   = "${local.name_prefix}-support"
  role   = aws_iam_role.support.id
  policy = data.aws_iam_policy_document.support.json
}

resource "aws_lambda_function" "support" {
  #checkov:skip=CKV_AWS_116:Synchronous endpoint; bounded errors return directly to the client, no asynchronous retries.
  #checkov:skip=CKV_AWS_117:Public TLS egress to Bedrock; no application data-plane permissions.
  #checkov:skip=CKV_AWS_272:Code signing not set up for this app yet; follows the existing deployment pipeline.
  #checkov:skip=CKV_AWS_50:No active request tracing for this privacy-sensitive endpoint; aggregate metrics and Lambda monitoring only.
  function_name                  = "${local.name_prefix}-support"
  role                           = aws_iam_role.support.arn
  runtime                        = "nodejs24.x"
  handler                        = "index.handler"
  filename                       = data.archive_file.support.output_path
  source_code_hash               = data.archive_file.support.output_base64sha256
  memory_size                    = 256
  timeout                        = 18
  reserved_concurrent_executions = 5
  kms_key_arn                    = aws_kms_key.app.arn
  environment {
    variables = {
      SUPPORT_ENABLED      = tostring(var.enable_support_chat)
      SUPPORT_MODEL_ID     = var.support_model_id
      SUPPORT_ORIGIN_TOKEN = aws_secretsmanager_secret_version.support_origin.secret_string
    }
  }
  depends_on = [aws_cloudwatch_log_group.support, aws_iam_role_policy.support]
  tags       = var.tags
}

resource "aws_apigatewayv2_integration" "support" {
  api_id                 = aws_apigatewayv2_api.http.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.support.invoke_arn
  payload_format_version = "2.0"
  timeout_milliseconds   = 19000
}

resource "aws_apigatewayv2_route" "support" {
  api_id             = aws_apigatewayv2_api.http.id
  route_key          = "POST /v1/support"
  target             = "integrations/${aws_apigatewayv2_integration.support.id}"
  authorization_type = "CUSTOM"
  authorizer_id      = aws_apigatewayv2_authorizer.device_token.id
}

resource "aws_lambda_permission" "support" {
  statement_id  = "AllowSupportApiGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.support.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http.execution_arn}/*/POST/v1/support"
}

resource "aws_cloudwatch_log_metric_filter" "support_unavailable" {
  name           = "${local.name_prefix}-support-unavailable"
  log_group_name = aws_cloudwatch_log_group.support.name
  pattern        = "{ $.marker = \"SupportUnavailable\" }"
  metric_transformation {
    name      = "SupportUnavailable"
    namespace = "GoodNeighbor/Support"
    value     = "1"
  }
}

resource "aws_cloudwatch_log_metric_filter" "support_tokens" {
  for_each       = toset(["inputTokens", "outputTokens"])
  name           = "${local.name_prefix}-support-${each.value}"
  log_group_name = aws_cloudwatch_log_group.support.name
  pattern        = "{ $.marker = \"SupportResponse\" }"
  metric_transformation {
    name      = "Support-${local.name_prefix}-${each.value}"
    namespace = "GoodNeighbor/Support"
    value     = "$.${each.value}"
  }
}

resource "aws_cloudwatch_metric_alarm" "support_unavailable" {
  alarm_name          = "${local.name_prefix}-support-unavailable"
  alarm_description   = "Support could not answer at least five requests. Check model access, regional invocation logging and latency; no question/answer bodies are logged."
  namespace           = "GoodNeighbor/Support"
  metric_name         = "SupportUnavailable"
  statistic           = "Sum"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 5
  period              = 300
  evaluation_periods  = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  tags                = var.tags
}

resource "aws_cloudwatch_metric_alarm" "support_throttles" {
  alarm_name          = "${local.name_prefix}-support-throttles"
  alarm_description   = "Support concurrency is exhausted. Check traffic and model latency before changing its cost ceiling."
  namespace           = "AWS/Lambda"
  metric_name         = "Throttles"
  dimensions          = { FunctionName = aws_lambda_function.support.function_name }
  statistic           = "Sum"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 5
  period              = 300
  evaluation_periods  = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  tags                = var.tags
}
