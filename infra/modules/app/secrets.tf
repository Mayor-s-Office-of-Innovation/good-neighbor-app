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

# PostHog project API key (write-only ingest key) for the client-error
# forwarder. Same container-only pattern: the value is set out-of-band; until
# it is, the forwarder runs in log-only mode (see handlers/posthog-api-key.js).
resource "aws_secretsmanager_secret" "posthog_project_api_key" {
  #checkov:skip=CKV2_AWS_57:Third-party ingest key rotated manually out-of-band; PostHog project keys are not credentials for any account surface.
  name        = "${local.name_prefix}-posthog-project-api-key"
  description = "PostHog project API key for client-error forwarding (value set out-of-band; absent = log-only mode)."
  kms_key_id  = aws_kms_key.app.arn
  tags        = var.tags
}

# Device-token signing key (HS256) for the device auth (docs/adr/0010). Same
# container-only pattern: the value is set out-of-band; the api Lambda (token
# minting) and the authorizer Lambda (verification) each read it via this ARN.
# Generate out-of-band, e.g.:
#   aws secretsmanager put-secret-value \
#     --secret-id <this ARN> \
#     --secret-string "$(openssl rand -base64 48)"
resource "aws_secretsmanager_secret" "device_token_key" {
  #checkov:skip=CKV2_AWS_57:HS256 signing key rotated manually out-of-band (openssl rand, per ADR 0010); automatic rotation needs a coordinated key-swap across the api + authorizer Lambdas that doesn't exist yet.
  name        = "${local.name_prefix}-device-token-key"
  description = "HS256 signing key for device session tokens (value set out-of-band)."
  kms_key_id  = aws_kms_key.app.arn
  tags        = var.tags
}

# SF311 HUB Basic Auth credentials for CreateSR and lookup calls. Terraform
# creates only the secret container; set the JSON value out-of-band:
# {"username":"...","password":"..."}
resource "aws_secretsmanager_secret" "sf311_basic_auth" {
  #checkov:skip=CKV2_AWS_57:SF311 dev credentials are rotated manually out-of-band until a production credential rotation process exists.
  name        = "${local.name_prefix}-sf311-basic-auth"
  description = "Basic Auth credentials for SF311 HUB API calls (value set out-of-band)."
  kms_key_id  = aws_kms_key.app.arn
  tags        = var.tags
}
