# S3 — tenant attachment store.
#
# One bucket per environment, tenants segregated by object-key prefix
# (`<tenant_id>/<object_path>`). Pre-signed URLs at the application
# layer gate access; the bucket stays fully private.
#
# Hardening:
#   - Block Public Access on at every level.
#   - Versioning on (restore after accidental overwrite).
#   - Server-side encryption with SSE-S3 (customer-managed KMS is a
#     Phase-4 hardening task).
#   - Lifecycle: stale non-current versions age out after 90 days,
#     incomplete multipart uploads are cleaned up after 7.

resource "random_id" "attachments_suffix" {
  # Bucket names are globally unique. Include a random hex suffix so
  # two accounts running the same env tag don't collide.
  byte_length = 4
}

resource "aws_s3_bucket" "attachments" {
  bucket = "${local.name_prefix}-attachments-${random_id.attachments_suffix.hex}"

  tags = {
    Name = "${local.name_prefix}-attachments"
  }
}

resource "aws_s3_bucket_public_access_block" "attachments" {
  bucket                  = aws_s3_bucket.attachments.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "attachments" {
  bucket = aws_s3_bucket.attachments.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "attachments" {
  bucket = aws_s3_bucket.attachments.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "attachments" {
  bucket = aws_s3_bucket.attachments.id

  rule {
    id     = "expire-noncurrent"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 90
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}
