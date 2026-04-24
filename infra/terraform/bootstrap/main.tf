# Bootstrap — creates the S3 bucket + DynamoDB table that the main
# Terraform root module uses for remote state.
#
# Run ONCE per AWS account, with a LOCAL state file (this module's
# state lives in `terraform.tfstate` alongside the HCL). After
# `terraform apply`, you get a bucket + table name; plug those into
# the main module's `-backend-config` flags.
#
#   cd infra/terraform/bootstrap
#   terraform init
#   terraform apply
#   terraform output
#
# Then for the main module:
#
#   cd ..
#   terraform init \
#     -backend-config="bucket=<bucket-from-output>" \
#     -backend-config="key=env/staging/terraform.tfstate" \
#     -backend-config="region=eu-central-1" \
#     -backend-config="dynamodb_table=<table-from-output>" \
#     -backend-config="encrypt=true"

terraform {
  required_version = ">= 1.9"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.70"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Platform  = "erp"
      Purpose   = "terraform-backend"
      ManagedBy = "terraform-bootstrap"
    }
  }
}

variable "aws_region" {
  description = "AWS region for the state bucket + lock table."
  type        = string
  default     = "eu-central-1"
}

data "aws_caller_identity" "current" {}

resource "random_id" "suffix" {
  byte_length = 4
}

# ── State bucket ────────────────────────────────────────────────

resource "aws_s3_bucket" "state" {
  bucket = "erp-tf-state-${data.aws_caller_identity.current.account_id}-${random_id.suffix.hex}"

  # Never let `terraform destroy` wipe remote state.
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# ── Lock table ──────────────────────────────────────────────────

resource "aws_dynamodb_table" "locks" {
  name         = "erp-tf-locks"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"

  attribute {
    name = "LockID"
    type = "S"
  }

  # Locks are transient; no backup/recovery needed.
  point_in_time_recovery { enabled = false }

  lifecycle {
    prevent_destroy = true
  }
}

# ── Outputs ─────────────────────────────────────────────────────

output "state_bucket" {
  description = "Plug into main module's `-backend-config=\"bucket=<value>\"`."
  value       = aws_s3_bucket.state.id
}

output "lock_table" {
  description = "Plug into main module's `-backend-config=\"dynamodb_table=<value>\"`."
  value       = aws_dynamodb_table.locks.name
}
