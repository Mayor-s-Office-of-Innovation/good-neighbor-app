variable "aws_region" {
  description = "AWS region for the environment."
  type        = string
  default     = "us-west-2"
}

variable "application" {
  description = "Required CCSF Application tag."
  type        = string
  default     = "Good-Neighbor-App"
}

variable "application_owner" {
  description = "Required CCSF ApplicationOwner tag."
  type        = string
  default     = "innovation@sfgov.org"
}

variable "environment" {
  description = "Required CCSF Environment tag."
  type        = string
  default     = "dev"
}

variable "data_classification" {
  description = "Required CCSF DataClassification tag."
  type        = string
  default     = "sensitive"

  validation {
    condition     = contains(["public", "internal", "sensitive", "protected", "regulated"], var.data_classification)
    error_message = "Data classification must match the CCSF SDLC allowed values."
  }
}

variable "internet_exposure" {
  description = "Required CCSF InternetExposure tag."
  type        = string
  default     = "public-facing"

  validation {
    condition     = contains(["public-facing", "internal-only"], var.internet_exposure)
    error_message = "Internet exposure must be public-facing or internal-only."
  }
}

variable "asset_criticality" {
  description = "Required CCSF AssetCriticality tag."
  type        = string
  default     = "tier-2"

  validation {
    condition     = contains(["tier-1", "tier-2", "tier-3", "tier-4"], var.asset_criticality)
    error_message = "Asset criticality must match the CCSF resilience tiers."
  }
}

variable "compliance" {
  description = "Required CCSF Compliance tag. Empty string means no current regulated regime."
  type        = string
  default     = ""
}

variable "frontend_domain_names" {
  description = "Custom domain names for the dev frontend distribution."
  type        = list(string)
  default     = ["dev.goodneighborsf.org"]
}

variable "frontend_certificate_arn" {
  description = "ACM certificate ARN in us-east-1 for the dev frontend custom domain."
  type        = string
  default     = "arn:aws:acm:us-east-1:518892333858:certificate/9b05189c-4b0f-474e-91ca-06b0c295b906"
}
