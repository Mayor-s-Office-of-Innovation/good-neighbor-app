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

variable "enable_311_submission" {
  description = "Enable backend CreateSR submissions to SF311 HUB when task app actions run."
  type        = bool
  default     = false
}

variable "sf311_createsr_url" {
  description = "SF311 HUB CreateSR endpoint URL."
  type        = string
  default     = "https://oicdev-axallnoytkrb-px.integration.us-phoenix-1.ocp.oraclecloud.com/ic/api/integration/v1/flows/rest/CREATESR/2.0"
}

variable "sf311_agency_lookup_url" {
  description = "SF311 HUB agency lookup endpoint URL."
  type        = string
  default     = "https://oicdev-axallnoytkrb-px.integration.us-phoenix-1.ocp.oraclecloud.com/ic/api/integration/v1/flows/rest/HUBWEB/1.0/lookup_agency_table"
}

variable "sf311_default_responsible_agency" {
  description = "Optional fallback ResponsibleAgency value if the HUB lookup response does not map the selected service code."
  type        = string
  default     = ""
}

variable "sf311_classifier_service_code_map" {
  description = "JSON object mapping classifier labels to SF311 service codes, keyed by classifier id."
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

variable "feedback_survey_id" {
  description = "PostHog survey UUID that receives `survey sent` feedback events (API-type survey, one open-text question). Either ID unset = feedback forwarder stays log-only (the kill switch)."
  type        = string
  default     = ""
}

variable "feedback_question_id" {
  description = "PostHog question UUID inside feedback_survey_id; the response key is $survey_response_<this>."
  type        = string
  default     = ""
}
