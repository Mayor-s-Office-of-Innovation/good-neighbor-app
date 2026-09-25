terraform {
  required_version = "= 1.9.8"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.64"
    }
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = local.common_tags
  }
}

variable "expected_account_id" {
  description = "AWS account that owns the production Terraform backend."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.expected_account_id))
    error_message = "expected_account_id must be a 12-digit AWS account ID."
  }
}

variable "state_bucket_name" {
  description = "Globally unique name for the production Terraform state bucket."
  type        = string
}

variable "state_log_bucket_name" {
  description = "Globally unique name for the production Terraform state access-log bucket."
  type        = string
}

variable "lock_table_name" {
  description = "Name of the production Terraform state lock table."
  type        = string
}

variable "aws_region" {
  description = "AWS region for production Terraform state resources."
  type        = string
}

variable "kms_alias_name" {
  description = "Alias for the production Terraform state KMS key."
  type        = string

  validation {
    condition     = can(regex("^alias/[a-zA-Z0-9/_-]+$", var.kms_alias_name))
    error_message = "kms_alias_name must be a valid KMS alias name beginning with alias/."
  }
}

data "aws_caller_identity" "current" {}

data "aws_iam_policy_document" "terraform_state_kms" {
  # AWS's standard account-principal recovery statement intentionally uses
  # kms:* and Resource "*". It applies only to this key, does not directly
  # grant any IAM identity access, enables separately scoped account IAM
  # policies, and prevents the key from becoming unmanageable if a role is
  # replaced. Routine backend access remains limited by the deployment role's
  # IAM policy.
  #checkov:skip=CKV_AWS_109:The AWS-standard account-principal recovery statement requires full key administration so authorized account administrators can recover and manage this key.
  #checkov:skip=CKV_AWS_111:The AWS-standard account-principal recovery statement requires full key administration so authorized account administrators can recover and manage this key.
  #checkov:skip=CKV_AWS_356:KMS key policies require Resource "*" because the key ARN is not available inside its own policy.
  statement {
    sid    = "EnableAccountIAMPoliciesAndRecovery"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${var.expected_account_id}:root"]
    }

    actions   = ["kms:*"]
    resources = ["*"]
  }
}

locals {
  common_tags = {
    Application        = "Good-Neighbor-App"
    ApplicationOwner   = "innovation@sfgov.org"
    Environment        = "prod"
    DataClassification = "sensitive"
    InternetExposure   = "internal-only"
    AssetCriticality   = "tier-2"
    Compliance         = "None"
  }
}

resource "aws_kms_key" "terraform_state" {
  description             = "KMS key for Good Neighbor production Terraform state"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  policy                  = data.aws_iam_policy_document.terraform_state_kms.json

  lifecycle {
    prevent_destroy = true

    precondition {
      condition     = data.aws_caller_identity.current.account_id == var.expected_account_id
      error_message = "The production state backend must be provisioned in the configured PROD account."
    }
  }
}

resource "aws_kms_alias" "terraform_state" {
  name          = var.kms_alias_name
  target_key_id = aws_kms_key.terraform_state.key_id
}

resource "aws_s3_bucket" "terraform_state" {
  bucket = var.state_bucket_name

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_ownership_controls" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  rule {
    id     = "abort-incomplete-state-uploads"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  rule {
    bucket_key_enabled = true

    apply_server_side_encryption_by_default {
      kms_master_key_id = aws_kms_key.terraform_state.arn
      sse_algorithm     = "aws:kms"
    }
  }
}

data "aws_iam_policy_document" "terraform_state" {
  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.terraform_state.arn,
      "${aws_s3_bucket.terraform_state.arn}/*",
    ]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  statement {
    sid    = "DenyStateWritesWithoutKMS"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.terraform_state.arn}/*"]

    condition {
      test     = "StringNotEquals"
      variable = "s3:x-amz-server-side-encryption"
      values   = ["aws:kms"]
    }
  }

  statement {
    sid    = "DenyStateWritesWithWrongKMSKey"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.terraform_state.arn}/*"]

    condition {
      test     = "StringNotEquals"
      variable = "s3:x-amz-server-side-encryption-aws-kms-key-id"
      values   = [aws_kms_key.terraform_state.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id
  policy = data.aws_iam_policy_document.terraform_state.json
}

resource "aws_s3_bucket_logging" "terraform_state" {
  bucket        = aws_s3_bucket.terraform_state.id
  target_bucket = aws_s3_bucket.terraform_state_logs.id
  target_prefix = "state-access/"

  depends_on = [aws_s3_bucket_policy.terraform_state_logs]
}

resource "aws_s3_bucket" "terraform_state_logs" {
  #checkov:skip=CKV_AWS_18:Access-log buckets are not access-logged to avoid recursive logging.
  #checkov:skip=CKV_AWS_145:S3 server-access-log destinations require SSE-S3 rather than SSE-KMS.
  bucket = var.state_log_bucket_name

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_ownership_controls" "terraform_state_logs" {
  bucket = aws_s3_bucket.terraform_state_logs.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "terraform_state_logs" {
  bucket = aws_s3_bucket.terraform_state_logs.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "terraform_state_logs" {
  bucket = aws_s3_bucket.terraform_state_logs.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "terraform_state_logs" {
  bucket = aws_s3_bucket.terraform_state_logs.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "terraform_state_logs" {
  bucket = aws_s3_bucket.terraform_state_logs.id

  rule {
    id     = "expire-state-access-logs"
    status = "Enabled"

    filter {}

    expiration {
      days = 365
    }

    noncurrent_version_expiration {
      noncurrent_days = 30
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

data "aws_iam_policy_document" "terraform_state_logs" {
  statement {
    sid    = "AllowS3LogDelivery"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["logging.s3.amazonaws.com"]
    }

    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.terraform_state_logs.arn}/state-access/*"]

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = [aws_s3_bucket.terraform_state.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [var.expected_account_id]
    }
  }

  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.terraform_state_logs.arn,
      "${aws_s3_bucket.terraform_state_logs.arn}/*",
    ]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "terraform_state_logs" {
  bucket = aws_s3_bucket.terraform_state_logs.id
  policy = data.aws_iam_policy_document.terraform_state_logs.json
}

resource "aws_dynamodb_table" "terraform_locks" {
  name         = var.lock_table_name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"

  attribute {
    name = "LockID"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.terraform_state.arn
  }

  lifecycle {
    prevent_destroy = true
  }
}

output "state_bucket_name" {
  description = "PROD-owned S3 bucket for Terraform state."
  value       = aws_s3_bucket.terraform_state.id
}

output "lock_table_name" {
  description = "PROD-owned DynamoDB table for Terraform state locking."
  value       = aws_dynamodb_table.terraform_locks.name
}

output "state_kms_key_arn" {
  description = "KMS key protecting production Terraform state and locks."
  value       = aws_kms_key.terraform_state.arn
}
