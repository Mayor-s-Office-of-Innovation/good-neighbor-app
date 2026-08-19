terraform {
  required_version = ">= 1.9.0"

  required_providers {
    aws = {
      source = "hashicorp/aws"
      # CLOUDFRONT-scoped WAF (aws_wafv2_web_acl.web) must be created in
      # us-east-1, so the root passes a second, aliased provider.
      configuration_aliases = [aws.us_east_1]
    }
    archive = {
      source = "hashicorp/archive"
    }
  }
}
