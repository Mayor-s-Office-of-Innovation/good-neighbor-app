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

# Proofpoint authenticates the outbound hop from SES Mail Manager. Terraform
# owns only the encrypted container and access policy; the JSON value is set
# out-of-band so the SMTP password never enters source control or state:
# {"username":"<provided SMTP username>","password":"<provided SMTP password>"}
resource "aws_secretsmanager_secret" "city_smtp_relay" {
  count = var.provision_city_smtp_relay_foundation ? 1 : 0

  #checkov:skip=CKV2_AWS_57:DT owns credential rotation; the operational agreement provides 30 days for normal rotations and an emergency path for immediate changes.
  name        = "${local.name_prefix}-city-smtp-relay"
  description = "City Proofpoint SMTP credentials for SES Mail Manager (value set out-of-band)."
  kms_key_id  = aws_kms_key.smtp_secrets[0].arn
  tags        = var.tags
}

# Applications submit mail to an authenticated Mail Manager ingress point.
# This separate credential prevents the City/Proofpoint password from ever
# being available to application code. Expected JSON: {"password":"<random>"}.
resource "aws_secretsmanager_secret" "mail_manager_ingress" {
  count = var.provision_city_smtp_relay_foundation ? 1 : 0

  #checkov:skip=CKV2_AWS_57:Rotation is coordinated with every SMTP client; Mail Manager accepts AWSCURRENT and AWSPREVIOUS during a controlled manual rotation.
  name        = "${local.name_prefix}-mail-manager-ingress"
  description = "Authentication password for the SES Mail Manager application ingress (value set out-of-band)."
  kms_key_id  = aws_kms_key.smtp_secrets[0].arn
  tags        = var.tags
}

resource "aws_secretsmanager_secret_policy" "city_smtp_relay" {
  count = var.provision_city_smtp_relay_foundation ? 1 : 0

  secret_arn = aws_secretsmanager_secret.city_smtp_relay[0].arn
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowMailManagerRelayRead"
      Effect    = "Allow"
      Principal = { Service = "ses.amazonaws.com" }
      Action    = ["secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue"]
      Resource  = aws_secretsmanager_secret.city_smtp_relay[0].arn
      Condition = {
        StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.current.account_id }
        ArnLike      = { "aws:SourceArn" = "arn:aws:ses:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:mailmanager-smtp-relay/*" }
      }
    }]
  })
}

resource "aws_secretsmanager_secret_policy" "mail_manager_ingress" {
  count = var.provision_city_smtp_relay_foundation ? 1 : 0

  secret_arn = aws_secretsmanager_secret.mail_manager_ingress[0].arn
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowMailManagerIngressRead"
      Effect    = "Allow"
      Principal = { Service = "ses.amazonaws.com" }
      Action    = ["secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue"]
      Resource  = aws_secretsmanager_secret.mail_manager_ingress[0].arn
      Condition = {
        StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.current.account_id }
        ArnLike      = { "aws:SourceArn" = "arn:aws:ses:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:mailmanager-ingress-point/*" }
      }
    }]
  })
}
