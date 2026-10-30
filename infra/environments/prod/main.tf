terraform {
  required_version = ">= 1.9.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.71"
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
  cognito_admin_app_url                  = "https://${local.admin_domain_name}/"
  admin_domain_names                     = [local.admin_domain_name]
  admin_certificate_arn                  = aws_acm_certificate_validation.admin.certificate_arn

  # Both SMTP secrets are populated out-of-band before enabling delivery.
  provision_city_smtp_relay_foundation = true
  enable_city_smtp_relay               = true
  city_smtp_from_address               = "goodneighbor@sf.gov"
  enable_cognito_custom_email_sender   = true

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  application                 = var.application
  environment                 = var.environment
  s3_bucket_name_prefix       = "gnp-prod"
  data_classification         = var.data_classification
  bedrock_model_id            = var.bedrock_model_id
  analyzer_base_url           = "https://xvcwo6m20a.execute-api.us-east-1.amazonaws.com/prod"
  duplicate_analyzer_base_url = "https://xvcwo6m20a.execute-api.us-east-1.amazonaws.com/prod"
  enable_support_chat         = true

  # Good Neighbor - Prod feedback survey; identifiers only (key stored in Secrets Manager).
  feedback_survey_id   = "01a184ca-e77d-0000-d993-bb815ab74819"
  feedback_question_id = "47e4c35b-7e7c-4c84-9fb8-a9e9a35dfaca"

  # Production cutover enabled after deployed dev validation and comparison-key provisioning.
  enable_duplicate_detection               = true
  duplicate_worker_maximum_concurrency     = 20
  duplicate_comparison_requests_per_second = 3
  duplicate_comparison_cache_version       = "image-comparison-v2"
  # Production HUB credentials are populated out-of-band in Secrets Manager.
  # Use the durable worker path already exercised in dev for every filing.
  enable_311_submission   = true
  enable_311_async_filing = true
  # Production uses its own HUB host; the module defaults remain DEV endpoints.
  sf311_createsr_url           = "https://oicprod-axallnoytkrb-px.integration.us-phoenix-1.ocp.oraclecloud.com/ic/api/integration/v1/flows/rest/CREATESR/2.0/servicerequest"
  sf311_updatesr_url           = "https://oicprod-axallnoytkrb-px.integration.us-phoenix-1.ocp.oraclecloud.com/ic/api/integration/v1/flows/rest/UPDATESRREST/1.0/"
  sf311_agency_lookup_url      = "https://oicprod-axallnoytkrb-px.integration.us-phoenix-1.ocp.oraclecloud.com/ic/api/integration/v1/flows/rest/HUBWEB/1.0/lookup_agency_table"
  sf311_latest_updates_url     = "https://oicprod-axallnoytkrb-px.integration.us-phoenix-1.ocp.oraclecloud.com/ic/api/integration/v1/flows/rest/GETSTATUSUPDATESBYSOURCEAGENCY/1.0/new_updates_by_source_agency/{agencyID}"
  alarm_emails                 = var.alarm_emails
  daily_cost_warning_usd       = 50
  enable_alarm_delivery_drills = true
  tags                         = local.common_tags
  sf311_media_domain_name      = "media.${local.frontend_domain_name}"
  sf311_media_zone_id          = aws_route53_zone.goodneighbor.zone_id

  frontend_domain_names    = local.frontend_domain_names
  frontend_certificate_arn = aws_acm_certificate_validation.frontend.certificate_arn
}
