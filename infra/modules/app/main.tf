locals {
  name_prefix = lower(replace("${var.application}-${var.environment}", "_", "-"))
}

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

resource "aws_kms_key" "app" {
  description             = "KMS key for ${var.application} ${var.environment} application data"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "EnableIamUserPermissions"
        Effect = "Allow"
        Principal = {
          AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"
        }
        Action   = "kms:*"
        Resource = "*"
      },
      {
        # CloudFront OAC reads SSE-KMS objects from the frontend bucket; without
        # this the distribution returns AccessDenied on every object. Scoped to
        # this env's distribution via SourceArn.
        Sid    = "AllowCloudFrontDecryptFrontend"
        Effect = "Allow"
        Principal = {
          Service = "cloudfront.amazonaws.com"
        }
        Action   = "kms:Decrypt"
        Resource = "*"
        Condition = {
          StringEquals = {
            "AWS:SourceArn" = aws_cloudfront_distribution.frontend.arn
          }
        }
      },
      {
        # CloudWatch Logs encrypts the Lambda/API log groups with this CMK.
        # Scoped to this account's log groups in this region via the encryption
        # context (AWS's documented pattern).
        Sid    = "AllowCloudWatchLogs"
        Effect = "Allow"
        Principal = {
          Service = "logs.${data.aws_region.current.name}.amazonaws.com"
        }
        Action = [
          "kms:Encrypt",
          "kms:Decrypt",
          "kms:ReEncrypt*",
          "kms:GenerateDataKey*",
          "kms:DescribeKey"
        ]
        Resource = "*"
        Condition = {
          ArnLike = {
            "kms:EncryptionContext:aws:logs:arn" = "arn:aws:logs:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:log-group:*"
          }
        }
      }
    ]
  })
  tags = var.tags
}

resource "aws_kms_alias" "app" {
  name          = "alias/${local.name_prefix}-app"
  target_key_id = aws_kms_key.app.key_id
}

resource "aws_s3_bucket" "frontend" {
  bucket_prefix = "${local.name_prefix}-frontend-"
  force_destroy = false
}

resource "aws_s3_bucket" "access_logs" {
  #checkov:skip=CKV_AWS_18:Access-log buckets are not access-logged to avoid recursive logging.
  bucket_prefix = "${local.name_prefix}-access-logs-"
  force_destroy = false
}

resource "aws_s3_bucket_public_access_block" "access_logs" {
  bucket                  = aws_s3_bucket.access_logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id

  rule {
    apply_server_side_encryption_by_default {
      kms_master_key_id = aws_kms_key.app.arn
      sse_algorithm     = "aws:kms"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id

  rule {
    id     = "expire-access-logs"
    status = "Enabled"

    filter {
      prefix = ""
    }

    expiration {
      days = 365
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

resource "aws_s3_bucket_public_access_block" "frontend" {
  bucket                  = aws_s3_bucket.frontend.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  rule {
    apply_server_side_encryption_by_default {
      kms_master_key_id = aws_kms_key.app.arn
      sse_algorithm     = "aws:kms"
    }
  }
}

resource "aws_s3_bucket_logging" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  target_bucket = aws_s3_bucket.access_logs.id
  target_prefix = "frontend/"
}

resource "aws_s3_bucket_lifecycle_configuration" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  rule {
    id     = "expire-noncurrent-frontend-assets"
    status = "Enabled"

    filter {
      prefix = ""
    }

    noncurrent_version_expiration {
      noncurrent_days = 90
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

resource "aws_s3_bucket" "uploads" {
  bucket_prefix = "${local.name_prefix}-uploads-"
  force_destroy = false
}

resource "aws_s3_bucket_public_access_block" "uploads" {
  bucket                  = aws_s3_bucket.uploads.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "uploads" {
  bucket = aws_s3_bucket.uploads.id

  rule {
    apply_server_side_encryption_by_default {
      kms_master_key_id = aws_kms_key.app.arn
      sse_algorithm     = "aws:kms"
    }
  }
}

resource "aws_s3_bucket_versioning" "uploads" {
  bucket = aws_s3_bucket.uploads.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_logging" "uploads" {
  bucket = aws_s3_bucket.uploads.id

  target_bucket = aws_s3_bucket.access_logs.id
  target_prefix = "uploads/"
}

resource "aws_s3_bucket_lifecycle_configuration" "uploads" {
  bucket = aws_s3_bucket.uploads.id

  rule {
    id     = "expire-incomplete-uploads"
    status = "Enabled"

    filter {
      prefix = ""
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }

    noncurrent_version_expiration {
      noncurrent_days = 90
    }
  }
}

resource "aws_s3_bucket_cors_configuration" "uploads" {
  bucket = aws_s3_bucket.uploads.id

  # Media is uploaded directly from the browser via presigned PUT URLs, so the
  # bucket must answer CORS preflight for the frontend origin(s). Reads stay
  # server-side (worker), but GET/HEAD are allowed for presigned preview URLs.
  cors_rule {
    allowed_methods = ["PUT", "GET", "HEAD"]
    allowed_origins = distinct(concat(
      ["https://${aws_cloudfront_distribution.frontend.domain_name}"],
      [for name in var.frontend_domain_names : "https://${name}"],
    ))
    allowed_headers = ["*"]
    expose_headers  = ["ETag"]
    max_age_seconds = 3000
  }
}

resource "aws_sqs_queue" "submissions" {
  name                       = "${local.name_prefix}-submissions"
  kms_master_key_id          = aws_kms_key.app.arn
  message_retention_seconds  = 345600
  visibility_timeout_seconds = 1800 # ≥ worker Lambda timeout (300s); AWS-recommended 6× for the SQS event source mapping
  tags                       = var.tags
}

resource "aws_dynamodb_table" "app" {
  # Single-table store (data-model doc). pk/sk carry every entity; sparse GSIs
  # index only the item types that set their keys, so each listing is a clean
  # query with no filtering.
  name         = "${local.name_prefix}-app"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  # GSI1 keys — set only on check headers (checks timeline).
  attribute {
    name = "gsi1pk"
    type = "S"
  }

  attribute {
    name = "gsi1sk"
    type = "S"
  }

  # GSI2 keys — set only on tasks (per-site worklist).
  attribute {
    name = "gsi2pk"
    type = "S"
  }

  attribute {
    name = "gsi2sk"
    type = "S"
  }

  # GSI4 keys — set only on conditions (site/date/severity condition history).
  attribute {
    name = "gsi4pk"
    type = "S"
  }

  attribute {
    name = "gsi4sk"
    type = "S"
  }

  # GSI5 keys — set only on unresolved conditions.
  attribute {
    name = "gsi5pk"
    type = "S"
  }

  attribute {
    name = "gsi5sk"
    type = "S"
  }

  # GSI1 — checks timeline: SITE#<siteId> / <startedAt ISO>. (AP6, AP12)
  global_secondary_index {
    name            = "GSI1"
    hash_key        = "gsi1pk"
    range_key       = "gsi1sk"
    projection_type = "ALL"
  }

  # GSI2 — site worklist: SITE#<siteId>#TASK#<status> / <createdAt>#<kind>#<severity>#<taskId>. (AP10)
  # GSI3 (cross-site escalation queue) is sparse and deferred to Phase 7 — it can
  # be added to the live table later with no rebuild.
  global_secondary_index {
    name            = "GSI2"
    hash_key        = "gsi2pk"
    range_key       = "gsi2sk"
    projection_type = "ALL"
  }

  # GSI4 — site condition history by severity:
  # SITE#<siteId>#CONDITION#SEV#<severity> / <reportedAt>#<assessmentId>#<conditionId>.
  global_secondary_index {
    name            = "GSI4"
    hash_key        = "gsi4pk"
    range_key       = "gsi4sk"
    projection_type = "ALL"
  }

  # GSI5 — sparse unresolved-condition queue:
  # SITE#<siteId>#CONDITION#UNRESOLVED / <reportedAt>#SEV#<severity>#<assessmentId>#<conditionId>.
  global_secondary_index {
    name            = "GSI5"
    hash_key        = "gsi5pk"
    range_key       = "gsi5sk"
    projection_type = "ALL"
  }

  point_in_time_recovery {
    enabled = true
  }

  stream_enabled   = true
  stream_view_type = "NEW_AND_OLD_IMAGES"

  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.app.arn
  }

  # TTL attribute wired but inactive — activation deferred to the post-MVP
  # retention pass (test data is disposable, cleared between cycles).
  ttl {
    attribute_name = "expiresAt"
    enabled        = false
  }

  tags = var.tags
}

resource "aws_cognito_user_pool" "users" {
  name = "${local.name_prefix}-users"

  deletion_protection = var.environment == "prod" ? "ACTIVE" : "INACTIVE"

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  auto_verified_attributes = ["email"]

  # Per-tenant site binding for the deferred JWT authorizer. Schema attributes
  # are add-only on a live pool, so we declare it now (harmless while unused) to
  # avoid a painful migration once token issuance + the authorizer land.
  schema {
    name                     = "siteId"
    attribute_data_type      = "String"
    mutable                  = true
    required                 = false
    developer_only_attribute = false

    string_attribute_constraints {
      min_length = 1
      max_length = 128
    }
  }

  password_policy {
    minimum_length                   = 14
    require_lowercase                = true
    require_numbers                  = true
    require_symbols                  = true
    require_uppercase                = true
    temporary_password_validity_days = 7
  }

  tags = var.tags
}

resource "aws_cognito_user_pool_client" "web" {
  name         = "${local.name_prefix}-web"
  user_pool_id = aws_cognito_user_pool.users.id

  explicit_auth_flows = [
    "ALLOW_REFRESH_TOKEN_AUTH",
    "ALLOW_USER_SRP_AUTH"
  ]

  prevent_user_existence_errors = "ENABLED"
}

resource "aws_cloudfront_response_headers_policy" "security" {
  name = "${local.name_prefix}-security-headers"

  security_headers_config {
    content_security_policy {
      # script-src allows 'self' plus one sha256 hash: the pre-paint theme-init
      # inline script in frontend/index.html (kept inline on purpose to avoid a
      # theme flash before first paint). No 'unsafe-inline' — only that one
      # known script is permitted; an injected inline script hashes differently
      # and stays blocked. This hash is coupled to the exact bytes of that
      # script, so it MUST be regenerated and deployed with the frontend on any
      # edit to it. Regenerate from a fresh build with:
      #   cd frontend && npm run build && node -e 'const fs=require("fs"),c=require("crypto");const h=fs.readFileSync("dist/index.html","utf8");const m=/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/i.exec(h);console.log("sha256-"+c.createHash("sha256").update(m[1],"utf8").digest("base64"))'
      content_security_policy = "default-src 'self'; base-uri 'self'; connect-src 'self' https://${aws_s3_bucket.uploads.bucket_regional_domain_name}; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data: blob:; media-src 'self' blob:; object-src 'none'; script-src 'self' 'sha256-5rcv/GJbmG54xVM3aFN2g2zzX8gx7IiHjAimoG8sp/s='; style-src 'self' 'unsafe-inline'"
      override                = true
    }

    content_type_options {
      override = true
    }

    frame_options {
      frame_option = "DENY"
      override     = true
    }

    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }

    strict_transport_security {
      access_control_max_age_sec = 31536000
      include_subdomains         = true
      preload                    = true
      override                   = true
    }

    xss_protection {
      mode_block = true
      protection = true
      override   = true
    }
  }

  custom_headers_config {
    items {
      header   = "Permissions-Policy"
      override = true
      value    = "camera=(), microphone=(), geolocation=()"
    }
  }
}

resource "aws_wafv2_web_acl" "web" {
  # CLOUDFRONT-scoped WAF must live in us-east-1 regardless of the app's region.
  provider = aws.us_east_1

  name  = "${local.name_prefix}-web-acl"
  scope = "CLOUDFRONT"

  default_action {
    allow {}
  }

  rule {
    name     = "AWSManagedRulesCommonRuleSet"
    priority = 1

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name_prefix}-common-rules"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "AWSManagedRulesKnownBadInputsRuleSet"
    priority = 2

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name_prefix}-known-bad-inputs"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "RateLimit"
    priority = 3

    action {
      block {}
    }

    statement {
      rate_based_statement {
        aggregate_key_type = "IP"
        limit              = 2000
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name_prefix}-rate-limit"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${local.name_prefix}-web-acl"
    sampled_requests_enabled   = true
  }

  tags = var.tags
}
