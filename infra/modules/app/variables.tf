variable "application" {
  description = "Application name."
  type        = string
}

variable "environment" {
  description = "Deployment environment."
  type        = string
}

variable "data_classification" {
  description = "Data classification."
  type        = string
}

variable "tags" {
  description = "Required CCSF common tags."
  type        = map(string)
}

variable "analyzer_base_url" {
  description = "Base URL of the external analyzer service (empty until it deploys)."
  type        = string
  default     = ""
}

variable "frontend_domain_names" {
  description = "Custom domain names to attach to the frontend CloudFront distribution."
  type        = list(string)
  default     = []
}

variable "frontend_certificate_arn" {
  description = "ACM certificate ARN in us-east-1 for the frontend custom domains. Empty uses the default CloudFront certificate."
  type        = string
  default     = ""

  validation {
    condition     = length(var.frontend_domain_names) == 0 || trimspace(var.frontend_certificate_arn) != ""
    error_message = "frontend_certificate_arn must be set when frontend_domain_names is non-empty."
  }
}

variable "bedrock_model_id" {
  description = "Bedrock model or inference profile ID for description validation."
  type        = string
}

variable "posthog_host" {
  description = "PostHog ingest host for client-error forwarding (US cloud default; forwarder is log-only until the egress sign-off)."
  type        = string
  default     = "https://us.i.posthog.com"
}
