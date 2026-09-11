# Created through the AWS CLI during SES setup; CI adopts it through this import.
resource "aws_sesv2_email_identity" "setup_codes" {
  email_identity = "goodneighborsf.org"

  dkim_signing_attributes {
    next_signing_key_length = "RSA_2048_BIT"
  }
}

import {
  to = aws_sesv2_email_identity.setup_codes
  id = "goodneighborsf.org"
}

output "setup_code_email_identity_arn" {
  description = "Verified SES domain identity for codes@goodneighborsf.org in this account."
  value       = aws_sesv2_email_identity.setup_codes.arn
}

output "setup_code_email_dkim_tokens" {
  description = "Public DKIM tokens; the prod root owns the authoritative DNS records."
  value       = aws_sesv2_email_identity.setup_codes.dkim_signing_attributes[0].tokens
}

# The root hosted zone is in prod, so both accounts' DKIM records live here.
# Bootstrap tokens cover the interval before dev CI exports the SES outputs.
# After dev deploys, its state becomes the source of truth, including replacements.
locals {
  setup_code_dev_dkim_tokens = try(
    data.terraform_remote_state.dev.outputs.setup_code_email_dkim_tokens,
    [
      "7rxq7zquj342nyi6ipribuy3p67fh2ik",
      "mdld2zah6porodxrvafpl4ti4nvp4oai",
      "gi2cbrtmuxmodqdztfoq33ee5ifc4pqi",
    ]
  )
}

resource "aws_route53_record" "setup_code_dev_dkim" {
  count = 3

  zone_id = data.aws_route53_zone.frontend_root.zone_id
  name    = "${local.setup_code_dev_dkim_tokens[count.index]}._domainkey.goodneighborsf.org"
  type    = "CNAME"
  ttl     = 300
  records = ["${local.setup_code_dev_dkim_tokens[count.index]}.dkim.amazonses.com"]
}

resource "aws_route53_record" "setup_code_prod_dkim" {
  count = 3

  zone_id = data.aws_route53_zone.frontend_root.zone_id
  name    = "${aws_sesv2_email_identity.setup_codes.dkim_signing_attributes[0].tokens[count.index]}._domainkey.goodneighborsf.org"
  type    = "CNAME"
  ttl     = 300
  records = ["${aws_sesv2_email_identity.setup_codes.dkim_signing_attributes[0].tokens[count.index]}.dkim.amazonses.com"]
}

import {
  to = aws_route53_record.setup_code_dev_dkim[0]
  id = "Z0308170YNRHEPQH0O3C_7rxq7zquj342nyi6ipribuy3p67fh2ik._domainkey.goodneighborsf.org_CNAME"
}

import {
  to = aws_route53_record.setup_code_dev_dkim[1]
  id = "Z0308170YNRHEPQH0O3C_mdld2zah6porodxrvafpl4ti4nvp4oai._domainkey.goodneighborsf.org_CNAME"
}

import {
  to = aws_route53_record.setup_code_dev_dkim[2]
  id = "Z0308170YNRHEPQH0O3C_gi2cbrtmuxmodqdztfoq33ee5ifc4pqi._domainkey.goodneighborsf.org_CNAME"
}

import {
  to = aws_route53_record.setup_code_prod_dkim[0]
  id = "Z0308170YNRHEPQH0O3C_62ksufgjegveq6ijsxdi4kim56pbnzli._domainkey.goodneighborsf.org_CNAME"
}

import {
  to = aws_route53_record.setup_code_prod_dkim[1]
  id = "Z0308170YNRHEPQH0O3C_lszi54fsbfmxwpjkxnpwxm6gn4ei6r6y._domainkey.goodneighborsf.org_CNAME"
}

import {
  to = aws_route53_record.setup_code_prod_dkim[2]
  id = "Z0308170YNRHEPQH0O3C_wphsrkmkzsag5j5jpljuhtugtf5e3w5k._domainkey.goodneighborsf.org_CNAME"
}
