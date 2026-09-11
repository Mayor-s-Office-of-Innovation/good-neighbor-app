locals {
  frontend_domain_name = "dev.goodneighborsf.org"
}

resource "aws_route53_zone" "frontend_subdomain" {
  #checkov:skip=CKV2_AWS_38:Delegated dev-only subdomain; full DNSSEC would also require parent-zone DS management across accounts and is deferred until the root domain is managed end-to-end in Terraform.
  #checkov:skip=CKV2_AWS_39:This delegated dev-only subdomain is low-volume and non-production; Route53 query logging is deferred to the broader production DNS observability pass.
  name    = local.frontend_domain_name
  comment = "Delegated hosted zone for the Good Neighbor App dev frontend."
}

resource "aws_acm_certificate" "frontend" {
  provider          = aws.us_east_1
  domain_name       = local.frontend_domain_name
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "frontend_certificate_validation" {
  for_each = {
    for option in aws_acm_certificate.frontend.domain_validation_options :
    option.domain_name => {
      name   = option.resource_record_name
      record = option.resource_record_value
      type   = option.resource_record_type
    }
  }

  allow_overwrite = true
  zone_id         = aws_route53_zone.frontend_subdomain.zone_id
  name            = each.value.name
  type            = each.value.type
  ttl             = 300
  records         = [each.value.record]
}

resource "aws_acm_certificate_validation" "frontend" {
  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.frontend.arn
  validation_record_fqdns = [for record in aws_route53_record.frontend_certificate_validation : record.fqdn]
}

resource "aws_route53_record" "frontend_ipv4" {
  zone_id = aws_route53_zone.frontend_subdomain.zone_id
  name    = local.frontend_domain_name
  type    = "A"

  alias {
    name                   = module.app.cloudfront_domain_name
    zone_id                = "Z2FDTNDATAQYW2"
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "frontend_ipv6" {
  zone_id = aws_route53_zone.frontend_subdomain.zone_id
  name    = local.frontend_domain_name
  type    = "AAAA"

  alias {
    name                   = module.app.cloudfront_domain_name
    zone_id                = "Z2FDTNDATAQYW2"
    evaluate_target_health = false
  }
}
