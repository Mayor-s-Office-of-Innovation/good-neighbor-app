terraform {
  required_version = ">= 1.9.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.64"
    }
  }

  # Configure before first shared deployment.
  # backend "s3" {
  #   bucket         = "good-neighbor-app-terraform-state"
  #   key            = "dev/terraform.tfstate"
  #   region         = "us-west-2"
  #   dynamodb_table = "good-neighbor-app-terraform-locks"
  #   encrypt        = true
  # }
}

provider "aws" {
  region = var.aws_region

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

  application        = var.application
  environment        = var.environment
  data_classification = var.data_classification
  tags               = local.common_tags
}

