output "frontend_bucket_name" {
  description = "S3 bucket for frontend assets."
  value       = module.app.frontend_bucket_name
}

output "submission_queue_url" {
  description = "SQS queue URL for offline submissions."
  value       = module.app.submission_queue_url
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

output "frontend_dns_name_servers" {
  description = "Authoritative name servers for the delegated dev.goodneighborsf.org hosted zone."
  value       = aws_route53_zone.frontend_subdomain.name_servers
}
