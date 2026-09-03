# API Gateway v2 HTTP API fronting the api Lambda. One integration; every route
# key targets it, and the Lambda dispatches on event.routeKey. No authorizer for
# MVP — the site-code flow mints no Cognito JWT, so requests resolve to
# DEMO_SITE_ID (tenant isolation lands with the deferred JWT authorizer). The
# route set mirrors backend/scripts/local-api.mjs and backend/src/lambda/api.js.

locals {
  api_routes = [
    "POST /site-code",
    # Device bootstrap (Option 4 device auth — docs/adr/0010): open, no authorizer.
    "POST /v1/devices",
    "POST /v1/devices/token:refresh",
    # Everything below is authorizer-protected (except /health + the intakes).
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
    "POST /submissions",
    "POST /v1/client-errors",
    "POST /v1/feedback",
    "GET /health",
  ]

  # Routes an anonymous caller may reach: bootstrap + health + best-effort
  # intakes. Everything else gets the device-token authorizer (Option 4).
  # As a MAP keyed by route, so the route resource can do `route_is_open[x]`.
  route_is_open = {
    "POST /site-code"                = true
    "POST /v1/devices"               = true
    "POST /v1/devices/token:refresh" = true
    "GET /health"                    = true
    "POST /v1/client-errors"         = true
    "POST /v1/feedback"              = true
    "POST /submissions"              = true
  }
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

# Device-token REQUEST authorizer (Option 4 device auth). Verifies the Bearer
# JWT + DEVICE# revocation state (backend/src/lambda/authorizer.js) and injects
# the Cognito-shaped claims handlers already read. Identity source = the
# Authorization header, so API Gateway caches verdicts per token; the TTL bounds
# revocation propagation.
resource "aws_apigatewayv2_authorizer" "device_token" {
  api_id                            = aws_apigatewayv2_api.http.id
  name                              = "${local.name_prefix}-device-token"
  authorizer_type                   = "REQUEST"
  authorizer_uri                    = aws_lambda_function.authorizer.invoke_arn
  identity_sources                  = ["$request.header.authorization"]
  authorizer_payload_format_version = "2.0"
  authorizer_result_ttl_in_seconds  = 60
}

resource "aws_apigatewayv2_route" "routes" {
  # The checkov skip for CKV_AWS_309 applies ONLY to the open routes below
  # (bootstrap + health + best-effort intakes): they are anonymous by design.
  # Every other route attaches the device-token authorizer (Option 4), which
  # satisfies the control — protected routes carry no skip.
  for_each = toset(local.api_routes)

  api_id    = aws_apigatewayv2_api.http.id
  route_key = each.value
  target    = "integrations/${aws_apigatewayv2_integration.api.id}"

  # Open routes skip the authorizer; everything else requires the device token.
  # `local.route_is_open` is a map keyed by route for this conditional.
  #checkov:skip=CKV_AWS_309:Open routes only (bootstrap/health/intakes) are anonymous by design; all other routes attach the device-token authorizer.
  authorizer_id = local.route_is_open[each.value] ? null : aws_apigatewayv2_authorizer.device_token.id
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
