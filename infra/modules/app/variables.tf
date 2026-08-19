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

