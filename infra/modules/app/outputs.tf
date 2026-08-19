output "frontend_bucket_name" {
  description = "S3 bucket for frontend assets."
  value       = aws_s3_bucket.frontend.bucket
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

output "api_url" {
  description = "Base invoke URL of the HTTP API ($default stage)."
  value       = aws_apigatewayv2_api.http.api_endpoint
}

output "cloudfront_distribution_id" {
  description = "CloudFront distribution id (for env-scoped cache invalidation)."
  value       = aws_cloudfront_distribution.frontend.id
}

output "cloudfront_domain_name" {
  description = "CloudFront domain name serving the frontend."
  value       = aws_cloudfront_distribution.frontend.domain_name
}

output "analyzer_secret_arn" {
  description = "Secrets Manager ARN holding the analyzer x-api-key (value set out-of-band)."
  value       = aws_secretsmanager_secret.analyzer_api_key.arn
}

