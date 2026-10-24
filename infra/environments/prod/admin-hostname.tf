locals {
  admin_domain_name = trimsuffix(aws_route53_zone.admin.name, ".")
}

resource "aws_route53_record" "admin_caa" {
  zone_id = aws_route53_zone.admin.zone_id
  name    = local.admin_domain_name
  type    = "CAA"
  ttl     = 300
  records = ["0 issue \"amazon.com\"", "0 issuewild \";\""]
}

resource "aws_acm_certificate" "admin" {
  provider          = aws.us_east_1
  domain_name       = local.admin_domain_name
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  depends_on = [aws_route53_record.admin_caa]
}

resource "aws_route53_record" "admin_certificate_validation" {
  for_each = {
    for option in aws_acm_certificate.admin.domain_validation_options :
    option.domain_name => {
      name   = option.resource_record_name
      record = option.resource_record_value
      type   = option.resource_record_type
    }
  }

  zone_id = aws_route53_zone.admin.zone_id
  name    = each.value.name
  type    = each.value.type
  ttl     = 300
  records = [each.value.record]
}

resource "aws_acm_certificate_validation" "admin" {
  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.admin.arn
  validation_record_fqdns = [for record in aws_route53_record.admin_certificate_validation : record.fqdn]
}

resource "aws_route53_record" "admin_application" {
  for_each = toset(["A", "AAAA"])

  zone_id = aws_route53_zone.admin.zone_id
  name    = local.admin_domain_name
  type    = each.value

  alias {
    name                   = module.app.admin_cloudfront_domain_name
    zone_id                = "Z2FDTNDATAQYW2"
    evaluate_target_health = false
  }
}

output "admin_app_url" {
  description = "Canonical production compliance dashboard URL."
  value       = "https://${local.admin_domain_name}/"
}
