# Bearer links use a dedicated edge so standard SPA access logs never capture
# their query tokens. API Gateway's existing access log format omits queries.
# The origin remains the same API Lambda; no public S3 access is introduced.
resource "aws_cloudfront_response_headers_policy" "sf311_media" {
  name = "${local.name_prefix}-311-media-security"

  security_headers_config {
    content_security_policy {
      content_security_policy = "default-src 'none'; base-uri 'none'; frame-ancestors 'none'"
      override                = true
    }
    content_type_options { override = true }
    frame_options {
      frame_option = "DENY"
      override     = true
    }
    referrer_policy {
      referrer_policy = "no-referrer"
      override        = true
    }
    strict_transport_security {
      access_control_max_age_sec = 31536000
      include_subdomains         = true
      preload                    = true
      override                   = true
    }
  }

  custom_headers_config {
    items {
      header   = "Cache-Control"
      value    = "no-store"
      override = true
    }
  }
}

resource "aws_cloudfront_distribution" "sf311_media" {
  #checkov:skip=CKV_AWS_305:API-only bearer media distribution; no index object exists and root requests intentionally return the API 404.
  #checkov:skip=CKV_AWS_86:Bearer tokens must not enter CloudFront standard access logs; API Gateway records route/status/request IDs without query strings.
  #checkov:skip=CKV_AWS_310:Single API origin; no independent failover origin exists.
  #checkov:skip=CKV_AWS_374:Public citywide 311 attachment access; no geo restriction is intentional.
  #checkov:skip=CKV2_AWS_47:Log4j is covered by the attached WAF managed KnownBadInputs rules.
  enabled         = true
  is_ipv6_enabled = true
  comment         = "${local.name_prefix} 311 attachment leases"
  price_class     = "PriceClass_100"
  web_acl_id      = aws_wafv2_web_acl.web.arn
  aliases         = [var.sf311_media_domain_name]

  origin {
    domain_name = replace(aws_apigatewayv2_api.http.api_endpoint, "https://", "")
    origin_id   = "api-gateway"
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    target_origin_id           = "api-gateway"
    viewer_protocol_policy     = "https-only"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    cache_policy_id            = data.aws_cloudfront_cache_policy.disabled.id
    origin_request_policy_id   = data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.sf311_media.id
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }
  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.sf311_media.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
  tags = var.tags
}

resource "aws_acm_certificate" "sf311_media" {
  provider          = aws.us_east_1
  domain_name       = var.sf311_media_domain_name
  validation_method = "DNS"
  tags              = var.tags
  lifecycle { create_before_destroy = true }
}

resource "aws_route53_record" "sf311_media_validation" {
  for_each = {
    for option in aws_acm_certificate.sf311_media.domain_validation_options :
    option.domain_name => option
  }
  zone_id = var.sf311_media_zone_id
  name    = each.value.resource_record_name
  type    = each.value.resource_record_type
  ttl     = 300
  records = [each.value.resource_record_value]
}

resource "aws_acm_certificate_validation" "sf311_media" {
  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.sf311_media.arn
  validation_record_fqdns = [for record in aws_route53_record.sf311_media_validation : record.fqdn]
}

resource "aws_route53_record" "sf311_media" {
  for_each = toset(["A", "AAAA"])
  zone_id  = var.sf311_media_zone_id
  name     = var.sf311_media_domain_name
  type     = each.value
  alias {
    name                   = aws_cloudfront_distribution.sf311_media.domain_name
    zone_id                = aws_cloudfront_distribution.sf311_media.hosted_zone_id
    evaluate_target_health = false
  }
}
