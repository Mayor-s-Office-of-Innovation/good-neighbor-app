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

output "cognito_user_pool_id" {
  description = "Cognito user pool id."
  value       = aws_cognito_user_pool.users.id
}

output "cognito_client_id" {
  description = "Cognito app client id."
  value       = aws_cognito_user_pool_client.web.id
}

