# Delegated production zone in the DEV AWS account. Keep this existing zone and
# its four name servers: the parent sf.gov delegation already points here.
# Application records, certificates, and CloudFront aliases are in domain.tf.
# The legacy gn.sf.gov hosted zone remains out of scope here.
resource "aws_route53_zone" "goodneighbor" {
  name    = "goodneighbor.sf.gov"
  comment = "Delegated production DNS zone for the Good Neighbor App."

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_route53_record" "frontend_caa" {
  zone_id = aws_route53_zone.goodneighbor.zone_id
  name    = aws_route53_zone.goodneighbor.name
  type    = "CAA"
  ttl     = 300
  records = [
    "0 issue \"amazon.com\"",
    "0 issue \"amazontrust.com\"",
    "0 issue \"awstrust.com\"",
    "0 issue \"amazonaws.com\"",
  ]
}

output "goodneighbor_dns_zone_id" {
  description = "Route 53 public hosted zone for goodneighbor.sf.gov."
  value       = aws_route53_zone.goodneighbor.zone_id
}

output "goodneighbor_dns_name_servers" {
  description = "Four assigned name servers for the existing goodneighbor.sf.gov delegation."
  value       = aws_route53_zone.goodneighbor.name_servers
}

# Route 53 DNSSEC and public query logging require us-east-1 resources.
data "aws_caller_identity" "goodneighbor_dns" {}

resource "aws_kms_key" "goodneighbor_dnssec" {
  #checkov:skip=CKV_AWS_7:Route 53 requires an asymmetric ECC_NIST_P256 signing key; KMS automatic rotation is unsupported for asymmetric keys. Rotate via coordinated KSK/parent DS rollover.
  provider                 = aws.us_east_1
  description              = "goodneighbor.sf.gov DNSSEC key-signing key"
  customer_master_key_spec = "ECC_NIST_P256"
  key_usage                = "SIGN_VERIFY"
  deletion_window_in_days  = 30
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AccountAdministration"
        Effect    = "Allow"
        Principal = { AWS = "arn:aws:iam::${data.aws_caller_identity.goodneighbor_dns.account_id}:root" }
        Action    = "kms:*"
        Resource  = "*"
      },
      {
        Sid       = "Route53Signing"
        Effect    = "Allow"
        Principal = { Service = "dnssec-route53.amazonaws.com" }
        Action    = ["kms:DescribeKey", "kms:GetPublicKey", "kms:Sign"]
        Resource  = "*"
        Condition = {
          StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.goodneighbor_dns.account_id }
          ArnEquals    = { "aws:SourceArn" = aws_route53_zone.goodneighbor.arn }
        }
      },
      {
        Sid       = "Route53Grant"
        Effect    = "Allow"
        Principal = { Service = "dnssec-route53.amazonaws.com" }
        Action    = "kms:CreateGrant"
        Resource  = "*"
        Condition = { Bool = { "kms:GrantIsForAWSResource" = true } }
      }
    ]
  })

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_route53_key_signing_key" "goodneighbor" {
  hosted_zone_id             = aws_route53_zone.goodneighbor.id
  key_management_service_arn = aws_kms_key.goodneighbor_dnssec.arn
  name                       = "goodneighbor_sf_gov"
}

resource "aws_route53_hosted_zone_dnssec" "goodneighbor" {
  hosted_zone_id = aws_route53_zone.goodneighbor.id
  depends_on     = [aws_route53_key_signing_key.goodneighbor]
}

resource "aws_kms_key" "goodneighbor_dns_logs" {
  provider                = aws.us_east_1
  description             = "goodneighbor.sf.gov DNS query log encryption"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AccountAdministration"
        Effect    = "Allow"
        Principal = { AWS = "arn:aws:iam::${data.aws_caller_identity.goodneighbor_dns.account_id}:root" }
        Action    = "kms:*"
        Resource  = "*"
      },
      {
        Sid       = "CloudWatchLogsEncryption"
        Effect    = "Allow"
        Principal = { Service = "logs.us-east-1.amazonaws.com" }
        Action    = ["kms:Encrypt", "kms:Decrypt", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:DescribeKey"]
        Resource  = "*"
        Condition = {
          ArnEquals = {
            "kms:EncryptionContext:aws:logs:arn" = "arn:aws:logs:us-east-1:${data.aws_caller_identity.goodneighbor_dns.account_id}:log-group:/aws/route53/goodneighbor.sf.gov"
          }
        }
      }
    ]
  })
}

resource "aws_cloudwatch_log_group" "goodneighbor_dns" {
  provider          = aws.us_east_1
  name              = "/aws/route53/goodneighbor.sf.gov"
  retention_in_days = 365
  kms_key_id        = aws_kms_key.goodneighbor_dns_logs.arn
}

resource "aws_cloudwatch_log_resource_policy" "goodneighbor_dns" {
  provider    = aws.us_east_1
  policy_name = "good-neighbor-dns-query-logs"
  policy_document = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "route53.amazonaws.com" }
      Action    = ["logs:CreateLogStream", "logs:PutLogEvents"]
      Resource  = "${aws_cloudwatch_log_group.goodneighbor_dns.arn}:*"
      Condition = {
        StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.goodneighbor_dns.account_id }
        ArnEquals    = { "aws:SourceArn" = aws_route53_zone.goodneighbor.arn }
      }
    }]
  })
}

resource "aws_route53_query_log" "goodneighbor" {
  cloudwatch_log_group_arn = aws_cloudwatch_log_group.goodneighbor_dns.arn
  zone_id                  = aws_route53_zone.goodneighbor.id
  depends_on               = [aws_cloudwatch_log_resource_policy.goodneighbor_dns]
}

output "goodneighbor_dnssec_ds_record" {
  description = "Give DT this DS record after delegation to establish the parent DNSSEC chain of trust."
  value       = aws_route53_key_signing_key.goodneighbor.ds_record
  depends_on  = [aws_route53_hosted_zone_dnssec.goodneighbor]
}
