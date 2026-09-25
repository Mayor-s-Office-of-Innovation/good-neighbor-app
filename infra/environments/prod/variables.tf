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
  default     = "prod"
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
  description = "Required CCSF Compliance tag. None means no current regulated regime."
  type        = string
  default     = "None"

  validation {
    condition     = length(trimspace(var.compliance)) > 0
    error_message = "Compliance must be non-empty; use None when no regulated regime applies."
  }
}

variable "bedrock_model_id" {
  description = "Bedrock model or inference profile ID for deployed description validation."
  type        = string
  default     = "anthropic.claude-sonnet-4-20250514-v1:0"
}

variable "dev_frontend_dns_name_servers" {
  description = "Public Route 53 name servers for the DEV-owned dev.goodneighborsf.org delegated zone. Update only through an explicit DEV-to-PROD DNS handoff."
  type        = list(string)
  default = [
    "ns-1312.awsdns-36.org",
    "ns-1886.awsdns-43.co.uk",
    "ns-482.awsdns-60.com",
    "ns-645.awsdns-16.net",
  ]

  validation {
    condition = (
      length(var.dev_frontend_dns_name_servers) == 4 &&
      length(toset(var.dev_frontend_dns_name_servers)) == 4 &&
      alltrue([
        for name_server in var.dev_frontend_dns_name_servers :
        can(regex("^ns-[0-9]+\\.awsdns-[0-9]+\\.(com|net|org|co\\.uk)\\.?$", name_server))
      ])
    )
    error_message = "Exactly four distinct Route 53 authoritative name servers must be provided."
  }
}

variable "setup_code_dev_dkim_tokens" {
  description = "Public Easy DKIM tokens exported by the DEV SES identity and handed off explicitly for publication in the PROD-owned root zone."
  type        = list(string)
  default = [
    "7rxq7zquj342nyi6ipribuy3p67fh2ik",
    "mdld2zah6porodxrvafpl4ti4nvp4oai",
    "gi2cbrtmuxmodqdztfoq33ee5ifc4pqi",
  ]

  validation {
    condition = (
      length(var.setup_code_dev_dkim_tokens) == 3 &&
      length(toset(var.setup_code_dev_dkim_tokens)) == 3 &&
      alltrue([
        for token in var.setup_code_dev_dkim_tokens :
        can(regex("^[a-z0-9]{32}$", token))
      ])
    )
    error_message = "Exactly three distinct 32-character DEV Easy DKIM tokens must be provided."
  }
}
