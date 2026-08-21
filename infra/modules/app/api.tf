# API Gateway v2 HTTP API fronting the api Lambda. One integration; every route
# key targets it, and the Lambda dispatches on event.routeKey. No authorizer for
# MVP — the site-code flow mints no Cognito JWT, so requests resolve to
# DEMO_SITE_ID (tenant isolation lands with the deferred JWT authorizer). The
# route set mirrors backend/scripts/local-api.mjs and backend/src/lambda/api.js.

locals {
  api_routes = [
    "POST /site-code",
    "POST /v1/checks",
    "GET /v1/checks",
    "POST /v1/checks/{checkId}/sides/{side}/description:validate",
    "POST /v1/checks/{checkId}/artifacts:presign",
    "POST /v1/checks/{checkId}/artifacts",
    "POST /v1/checks/{checkId}/complete",
    "GET /v1/checks/{checkId}/artifacts/{artifactId}/media",
    "GET /v1/checks/{checkId}",
    "GET /v1/tasks",
    "POST /v1/tasks/{taskId}/complete",
    "POST /v1/tasks/{taskId}/cannot-do",
    "POST /v1/assessments:evaluate",
    "GET /v1/assessments/{assessmentId}/guidance",
    "POST /v1/assessments/{assessmentId}/conditions/{conditionId}/answers",
    "POST /transcribe",
    "POST /transcribe-credentials",
    "POST /submissions",
    "GET /health",
  ]
}

resource "aws_apigatewayv2_api" "http" {
  name          = "${local.name_prefix}-http"
  protocol_type = "HTTP"

  tags = var.tags
}

resource "aws_apigatewayv2_integration" "api" {
  api_id                 = aws_apigatewayv2_api.http.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.api.invoke_arn
  integration_method     = "POST"
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "routes" {
  #checkov:skip=CKV_AWS_309:No authorizer for MVP by design — the site-code flow mints no JWT, so requests resolve to DEMO_SITE_ID. Tenant isolation lands with the deferred JWT authorizer + custom:siteId.
  for_each = toset(local.api_routes)

  api_id    = aws_apigatewayv2_api.http.id
  route_key = each.value
  target    = "integrations/${aws_apigatewayv2_integration.api.id}"
}

resource "aws_cloudwatch_log_group" "api_gw" {
  name              = "/aws/apigateway/${local.name_prefix}-http"
  retention_in_days = 365
  kms_key_id        = aws_kms_key.app.arn
  tags              = var.tags
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.http.id
  name        = "$default"
  auto_deploy = true

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.api_gw.arn
    format = jsonencode({
      requestId       = "$context.requestId"
      ip              = "$context.identity.sourceIp"
      requestTime     = "$context.requestTime"
      httpMethod      = "$context.httpMethod"
      routeKey        = "$context.routeKey"
      status          = "$context.status"
      protocol        = "$context.protocol"
      responseLength  = "$context.responseLength"
      integrationErr  = "$context.integrationErrorMessage"
      integrationStat = "$context.integrationStatus"
    })
  }

  default_route_settings {
    throttling_burst_limit = 100
    throttling_rate_limit  = 200
  }

  tags = var.tags
}
