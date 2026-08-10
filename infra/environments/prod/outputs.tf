output "frontend_bucket_name" {
  description = "S3 bucket for frontend assets."
  value       = module.app.frontend_bucket_name
}

output "submission_queue_url" {
  description = "SQS queue URL for offline submissions."
  value       = module.app.submission_queue_url
}

