terraform {
  required_version = ">= 1.9.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.21"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }

  backend "s3" {}
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = local.common_tags
  }
}

# CLOUDFRONT-scoped WAF must be created in us-east-1; the module takes this as an
# aliased provider.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = local.common_tags
  }
}

locals {
  common_tags = {
    Application        = var.application
    ApplicationOwner   = var.application_owner
    Environment        = var.environment
    DataClassification = var.data_classification
    InternetExposure   = var.internet_exposure
    AssetCriticality   = var.asset_criticality
    Compliance         = var.compliance
  }
}

module "app" {
  # PROD is a linked account; cost-tag activation belongs to the billing payer.
  manage_application_cost_allocation_tag = false
  source                                 = "../../modules/app"
  setup_code_email_identity_arn          = aws_sesv2_email_identity.setup_codes.arn
  provider_app_url                       = "https://${local.frontend_domain_name}/"
  cognito_admin_app_url                  = "https://goodneighbor-compliance.sf.gov/"

  # Both SMTP secrets are populated out-of-band before enabling delivery.
  provision_city_smtp_relay_foundation = true
  enable_city_smtp_relay               = true
  city_smtp_from_address               = "goodneighbor@sf.gov"
  enable_cognito_custom_email_sender   = true

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  application             = var.application
  environment             = var.environment
  s3_bucket_name_prefix   = "gnp-prod"
  data_classification     = var.data_classification
  bedrock_model_id        = var.bedrock_model_id
  analyzer_base_url       = "https://xvcwo6m20a.execute-api.us-east-1.amazonaws.com/prod"
  alarm_emails            = var.alarm_emails
  tags                    = local.common_tags
  sf311_media_domain_name = "media.${local.frontend_domain_name}"
  sf311_media_zone_id     = aws_route53_zone.goodneighbor.zone_id

  frontend_domain_names    = local.frontend_domain_names
  frontend_certificate_arn = aws_acm_certificate_validation.frontend.certificate_arn
}
