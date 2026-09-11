output "frontend_bucket_name" {
  description = "S3 bucket for frontend assets."
  value       = module.app.frontend_bucket_name
}

output "submission_queue_url" {
  description = "SQS queue URL for offline submissions."
  value       = module.app.submission_queue_url
}

output "dynamodb_table_name" {
  description = "Single-table DynamoDB store name (DYNAMO_TABLE)."
  value       = module.app.dynamodb_table_name
}

output "api_url" {
  description = "Base invoke URL of the HTTP API (for the frontend build + /health smoke test)."
  value       = module.app.api_url
}

output "cloudfront_distribution_id" {
  description = "CloudFront distribution id (env-scoped cache invalidation)."
  value       = module.app.cloudfront_distribution_id
}

output "cloudfront_domain_name" {
  description = "CloudFront domain name serving the frontend."
  value       = module.app.cloudfront_domain_name
}

output "admin_frontend_bucket_name" {
  description = "Admin authentication and deployment: admin_frontend_bucket_name."
  value       = module.app.admin_frontend_bucket_name
}

output "admin_cloudfront_distribution_id" {
  description = "Admin authentication and deployment: admin_cloudfront_distribution_id."
  value       = module.app.admin_cloudfront_distribution_id
}

output "admin_cloudfront_domain_name" {
  description = "Admin authentication and deployment: admin_cloudfront_domain_name."
  value       = module.app.admin_cloudfront_domain_name
}

output "admin_cognito_client_id" {
  description = "Admin authentication and deployment: admin_cognito_client_id."
  value       = module.app.admin_cognito_client_id
}

output "cognito_user_pool_id" {
  description = "Admin authentication and deployment: cognito_user_pool_id."
  value       = module.app.cognito_user_pool_id
}

output "cognito_managed_login_domain" {
  description = "Admin authentication and deployment: cognito_managed_login_domain."
  value       = module.app.cognito_managed_login_domain
}
