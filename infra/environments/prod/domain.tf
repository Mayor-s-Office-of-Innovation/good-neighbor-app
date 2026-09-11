locals {
  frontend_domain_name = trimsuffix(data.aws_route53_zone.frontend_root.name, ".")
}

data "aws_route53_zone" "frontend_root" {
  name         = "goodneighborsf.org."
  private_zone = false
}

data "terraform_remote_state" "dev" {
  backend = "s3"

  config = {
    bucket = "good-neighbor-app-terraform-state"
    key    = "dev/terraform.tfstate"
    region = "us-west-2"
  }
}

resource "aws_route53_record" "frontend_subdomain_delegation" {
  zone_id = data.aws_route53_zone.frontend_root.zone_id
  name    = "dev.${local.frontend_domain_name}"
  type    = "NS"
  ttl     = 300
  records = data.terraform_remote_state.dev.outputs.frontend_dns_name_servers
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
  zone_id         = data.aws_route53_zone.frontend_root.zone_id
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
  name    = local.frontend_domain_name
  type    = "A"

  alias {
    name                   = module.app.cloudfront_domain_name
    zone_id                = "Z2FDTNDATAQYW2"
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "frontend_ipv6" {
  zone_id = data.aws_route53_zone.frontend_root.zone_id
  name    = local.frontend_domain_name
  type    = "AAAA"

  alias {
    name                   = module.app.cloudfront_domain_name
    zone_id                = "Z2FDTNDATAQYW2"
    evaluate_target_health = false
  }
}
