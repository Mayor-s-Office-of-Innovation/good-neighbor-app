output "frontend_bucket_name" {
  description = "S3 bucket for frontend assets."
  value       = aws_s3_bucket.frontend.bucket
}

output "admin_frontend_bucket_name" {
  description = "S3 bucket for admin frontend assets."
  value       = aws_s3_bucket.admin_frontend.bucket
}

output "upload_bucket_name" {
  description = "S3 bucket for uploaded objects."
  value       = aws_s3_bucket.uploads.bucket
}

output "submission_queue_url" {
  description = "SQS queue URL for offline submissions."
  value       = aws_sqs_queue.submissions.url
}

output "dynamodb_table_name" {
  description = "Single-table DynamoDB store name (DYNAMO_TABLE)."
  value       = aws_dynamodb_table.app.name
}

output "dynamodb_table_stream_arn" {
  description = "DynamoDB Streams ARN for the Phase 5 aggregator."
  value       = aws_dynamodb_table.app.stream_arn
}

output "cognito_user_pool_id" {
  description = "Cognito user pool id."
  value       = aws_cognito_user_pool.users.id
}

output "cognito_client_id" {
  description = "Cognito app client id."
  value       = aws_cognito_user_pool_client.web.id
}

output "admin_cognito_client_id" {
  description = "Cognito app client id for the central admin console."
  value       = aws_cognito_user_pool_client.admin.id
}

output "cognito_managed_login_domain" {
  description = "Cognito managed-login domain for admin OAuth redirects."
  value       = "https://${aws_cognito_user_pool_domain.managed_login.domain}.auth.${data.aws_region.current.name}.amazoncognito.com"
}

output "api_url" {
  description = "Base HTTPS URL for API routes through the secured CloudFront edge."
  value       = "https://${aws_cloudfront_distribution.frontend.domain_name}"
}

output "cloudfront_distribution_id" {
  description = "CloudFront distribution id (for env-scoped cache invalidation)."
  value       = aws_cloudfront_distribution.frontend.id
}

output "cloudfront_domain_name" {
  description = "CloudFront domain name serving the frontend."
  value       = aws_cloudfront_distribution.frontend.domain_name
}

output "admin_cloudfront_distribution_id" {
  description = "CloudFront distribution id for the admin frontend."
  value       = aws_cloudfront_distribution.admin.id
}

output "admin_cloudfront_domain_name" {
  description = "CloudFront domain name serving the admin frontend."
  value       = aws_cloudfront_distribution.admin.domain_name
}

output "analyzer_secret_arn" {
  description = "Secrets Manager ARN holding the analyzer x-api-key (value set out-of-band)."
  value       = aws_secretsmanager_secret.analyzer_api_key.arn
}
