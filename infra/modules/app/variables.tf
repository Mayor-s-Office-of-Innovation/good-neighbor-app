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

