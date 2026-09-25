locals {
  frontend_domain_name        = trimsuffix(aws_route53_zone.goodneighbor.name, ".")
  legacy_frontend_domain_name = trimsuffix(data.aws_route53_zone.frontend_root.name, ".")
  frontend_domain_names       = [local.frontend_domain_name, local.legacy_frontend_domain_name]
}

data "aws_route53_zone" "frontend_root" {
  name         = "goodneighborsf.org."
  private_zone = false
}

resource "aws_route53_record" "frontend_subdomain_delegation" {
  zone_id = data.aws_route53_zone.frontend_root.zone_id
  name    = "dev.${local.legacy_frontend_domain_name}"
  type    = "NS"
  ttl     = 300
  records = var.dev_frontend_dns_name_servers
}

resource "aws_acm_certificate" "frontend" {
  provider                  = aws.us_east_1
  domain_name               = local.frontend_domain_name
  subject_alternative_names = [local.legacy_frontend_domain_name]
  validation_method         = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "frontend_certificate_validation" {
  for_each = {
    for option in aws_acm_certificate.frontend.domain_validation_options :
    option.domain_name => {
      name    = option.resource_record_name
      record  = option.resource_record_value
      type    = option.resource_record_type
      zone_id = option.domain_name == local.frontend_domain_name ? aws_route53_zone.goodneighbor.zone_id : data.aws_route53_zone.frontend_root.zone_id
    }
  }

  allow_overwrite = true
  zone_id         = each.value.zone_id
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
  zone_id = data.aws_route53_zone.frontend_root.zone_id
  name    = local.legacy_frontend_domain_name
  type    = "A"

  alias {
    name                   = module.app.cloudfront_domain_name
    zone_id                = "Z2FDTNDATAQYW2"
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "frontend_ipv6" {
  zone_id = data.aws_route53_zone.frontend_root.zone_id
  name    = local.legacy_frontend_domain_name
  type    = "AAAA"

  alias {
    name                   = module.app.cloudfront_domain_name
    zone_id                = "Z2FDTNDATAQYW2"
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "frontend_canonical_ipv4" {
  zone_id = aws_route53_zone.goodneighbor.zone_id
  name    = local.frontend_domain_name
  type    = "A"

  alias {
    name                   = module.app.cloudfront_domain_name
    zone_id                = "Z2FDTNDATAQYW2"
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "frontend_canonical_ipv6" {
  zone_id = aws_route53_zone.goodneighbor.zone_id
  name    = local.frontend_domain_name
  type    = "AAAA"

  alias {
    name                   = module.app.cloudfront_domain_name
    zone_id                = "Z2FDTNDATAQYW2"
    evaluate_target_health = false
  }
}
