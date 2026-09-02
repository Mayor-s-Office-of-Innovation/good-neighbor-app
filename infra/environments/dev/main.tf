terraform {
  required_version = ">= 1.9.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.64"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }

  backend "s3" {
    bucket         = "good-neighbor-app-terraform-state"
    key            = "dev/terraform.tfstate"
    region         = "us-west-2"
    dynamodb_table = "good-neighbor-app-terraform-locks"
    encrypt        = true
  }
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
  source = "../../modules/app"

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  application         = var.application
  environment         = var.environment
  data_classification = var.data_classification
  bedrock_model_id    = var.bedrock_model_id
  analyzer_base_url   = "https://ipipaqh985.execute-api.us-east-1.amazonaws.com/dev"
  # PostHog feedback survey (see docs/runbooks/feedback-ops.md §3): plain
  # identifiers, not secrets. The phc_ ingest key itself is set out-of-band
  # via put-secret-value on gnp-dev-posthog-project-api-key.
  feedback_survey_id       = "01a0633b-35d7-0000-9917-4ad2f1a7aa60"
  feedback_question_id     = "256e7e9d-9579-489a-ad5f-bcdd1b8e6baf"
  tags                     = local.common_tags
  frontend_domain_names    = [local.frontend_domain_name]
  frontend_certificate_arn = aws_acm_certificate_validation.frontend.certificate_arn
}
