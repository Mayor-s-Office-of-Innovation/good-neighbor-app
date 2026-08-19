# The analyzer's x-api-key, held in Secrets Manager and fetched by the worker
# (backend/src/analysis/api-key.js). Terraform creates the secret *container*
# only — the value is set out-of-band so it never enters state or VCS:
#
#   aws secretsmanager put-secret-value \
#     --secret-id <this ARN> --secret-string '<key>'
#
resource "aws_secretsmanager_secret" "analyzer_api_key" {
  #checkov:skip=CKV2_AWS_57:Third-party key rotated manually out-of-band; automatic rotation needs an analyzer-side flow that doesn't exist yet.
  name        = "${local.name_prefix}-analyzer-api-key"
  description = "x-api-key for the external analyzer (value set out-of-band)."
  kms_key_id  = aws_kms_key.app.arn
  tags        = var.tags
}
