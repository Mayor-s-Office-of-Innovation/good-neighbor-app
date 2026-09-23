# Both application stacks run in the DEV AWS account. The dev root is the sole
# Terraform owner of the verified goodneighborsf.org SES identity; production
# only consumes its ARN for setup-code delivery. The goodneighborsf.org parent
# DNS zone Z0308170YNRHEPQH0O3C (AWS account 701893741736) and its DKIM
# records are maintained by SF Mayor's Office of Innovation, outside both app
# Terraform roots.
output "setup_code_email_identity_arn" {
  description = "Shared SES identity ARN owned by the dev Terraform root."
  value       = data.terraform_remote_state.dev.outputs.setup_code_email_identity_arn
}
