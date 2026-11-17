# Check media through the app distribution with CloudFront signed cookies
# (notes/media-signed-cookies-plan.md). Card photos are plain `/checks/...`
# paths on the app origin, the object key itself, so the viewer URL that the
# signed policy is matched against is also the origin URI (no rewrite, so the
# order in which CloudFront validates the signature and runs the viewer
# function cannot matter). The api Lambda mints a one-hour signed cookie scoped
# to the caller's site prefix, so no per-photo signing request is made and the
# browser and edge can cache the bytes. The SPA's own routes are `/check` and
# `/check/describe`; `/checks/*` is distinct. S3 presigned GETs stay for the admin
# distribution, care-work and complaint media, 311 attachments, and the local
# harness.
#
# Everything here is gated on `media_signing_public_key_pem`: with the default
# empty value no key, origin or behaviour is created and the api Lambda does
# not advertise the feature, so an environment deploys unchanged until its key
# pair exists. The private half of the pair lives only in Secrets Manager; see
# docs/runbooks/media-safeguards.md "Media access cookies" for generation and
# rotation.

locals {
  media_cookies_enabled = trimspace(var.media_signing_public_key_pem) != ""
}

resource "aws_cloudfront_public_key" "media" {
  count = local.media_cookies_enabled ? 1 : 0

  # name_prefix, not name: a new PEM replaces this resource, and the
  # replacement must be created (under a fresh name) before the old key
  # leaves the key group.
  name_prefix = "${local.name_prefix}-media-signing-"
  comment     = "Verifies signed cookies for ${local.name_prefix} check media"
  encoded_key = var.media_signing_public_key_pem

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_cloudfront_key_group" "media" {
  count = local.media_cookies_enabled ? 1 : 0

  name    = "${local.name_prefix}-media-signing"
  comment = "Key group trusted by the /checks/* behaviour"
  items   = [aws_cloudfront_public_key.media[0].id]
}

resource "aws_cloudfront_origin_access_control" "uploads_media" {
  count = local.media_cookies_enabled ? 1 : 0

  name                              = "${local.name_prefix}-uploads-media-oac"
  description                       = "OAC for check media read through the ${local.name_prefix} frontend distribution"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# Objects are write-once under unpredictable keys, so caching is safe; both TTLs
# are capped at the cookie lifetime so a deleted photo leaves the edge within
# the same hour its cookies stop working. Nothing from the viewer is forwarded
# or keyed: the signed cookies are checked before the cache and never reach S3.
resource "aws_cloudfront_cache_policy" "media" {
  count = local.media_cookies_enabled ? 1 : 0

  name        = "${local.name_prefix}-media"
  comment     = "Check media: one-hour edge cache, no viewer data forwarded"
  min_ttl     = 0
  default_ttl = 3600
  max_ttl     = 3600

  parameters_in_cache_key_and_forwarded_to_origin {
    enable_accept_encoding_brotli = false
    enable_accept_encoding_gzip   = false
    cookies_config {
      cookie_behavior = "none"
    }
    headers_config {
      header_behavior = "none"
    }
    query_strings_config {
      query_string_behavior = "none"
    }
  }
}

# Images only: no script, frame or navigation context. `private` keeps shared
# caches out while the browser keeps the bytes for the cookie's lifetime.
resource "aws_cloudfront_response_headers_policy" "media" {
  count = local.media_cookies_enabled ? 1 : 0

  name = "${local.name_prefix}-media-security"

  security_headers_config {
    content_security_policy {
      content_security_policy = "default-src 'none'; base-uri 'none'; frame-ancestors 'none'"
      override                = true
    }
    content_type_options { override = true }
    frame_options {
      frame_option = "DENY"
      override     = true
    }
    referrer_policy {
      referrer_policy = "no-referrer"
      override        = true
    }
    strict_transport_security {
      access_control_max_age_sec = 31536000
      include_subdomains         = true
      preload                    = true
      override                   = true
    }
  }

  custom_headers_config {
    items {
      header   = "Cache-Control"
      value    = "private, max-age=3600"
      override = true
    }
  }
}

# Guard only, never a rewrite: refuse anything that looks like a listing or a
# traversal before it reaches S3. The URI the signed policy was matched
# against is the URI S3 receives.
resource "aws_cloudfront_function" "media_path" {
  count = local.media_cookies_enabled ? 1 : 0

  name    = "${local.name_prefix}-media-path"
  runtime = "cloudfront-js-2.0"
  comment = "Refuse listing-shaped or traversal media paths before the uploads origin."
  publish = true
  code    = <<-EOT
  function handler(event) {
    var request = event.request;
    var uri = request.uri;

    if (uri.indexOf("/checks/") !== 0 || uri.slice(-1) === "/" || uri.indexOf("..") !== -1) {
      return { statusCode: 404, statusDescription: "Not Found" };
    }

    return request;
  }
  EOT
}

# Private signing key container; the PEM is set out-of-band (runbook). Read by
# the api Lambda only.
resource "aws_secretsmanager_secret" "media_signing_key" {
  #checkov:skip=CKV2_AWS_57:RSA signing key rotated manually through the CloudFront key group (add, switch, remove); automatic rotation has no CloudFront-side counterpart.
  name        = "${local.name_prefix}-media-signing-key"
  description = "RSA private key (PEM) that signs CloudFront media cookies (value set out-of-band)."
  kms_key_id  = aws_kms_key.app.arn
  tags        = var.tags
}

locals {
  # Wired into the api Lambda only when the key group exists; the backend
  # treats an absent MEDIA_KEY_PAIR_ID as "feature off".
  media_lambda_environment = local.media_cookies_enabled ? {
    MEDIA_KEY_PAIR_ID            = aws_cloudfront_public_key.media[0].id
    MEDIA_SIGNING_KEY_SECRET_ARN = aws_secretsmanager_secret.media_signing_key.arn
  } : {}
}
