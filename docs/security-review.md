# Security Review

Status: not started

## Scope

- Frontend static web app hosted on AWS.
- API Gateway and Lambda handlers.
- SQS asynchronous processing.
- Bedrock AI integration.
- Managed Postgres via Prisma.
- S3 storage.
- Cognito authentication and authorization.
- Terraform and GitHub Actions deployment pipeline.

## Go-Live Evidence

- [ ] Threat model reviewed.
- [ ] Secrets scan clean.
- [ ] Dependency scan clean or exceptions approved.
- [ ] SAST findings reviewed.
- [ ] Terraform scan findings reviewed.
- [ ] IAM policies reviewed for least privilege.
- [ ] Database encryption and backup settings verified.
- [ ] S3 public access blocks verified.
- [ ] CloudFront security headers verified.
- [ ] WAF rules and rate limits verified.
- [ ] Mozilla Observatory A+.
- [ ] SSL Labs A+.
- [ ] Accessibility review passed.
- [ ] Core Web Vitals passed.
