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
