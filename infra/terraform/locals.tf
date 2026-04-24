# Computed values used across multiple .tf files. Keeping them in
# one place avoids duplicated "${var.platform_prefix}-${var.environment}"
# sprinkling and makes renames safer.

locals {
  # Short prefix used for every resource name. e.g. erp-staging,
  # erp-prod. Stays well under AWS's 32-char ALB / 63-char RDS limits.
  name_prefix = "${var.platform_prefix}-${var.environment}"

  # Tags that carry beyond the provider defaults — primarily used
  # for resources that don't expose a `default_tags`-friendly tagging
  # interface.
  common_tags = {
    Platform    = "erp"
    Environment = var.environment
    ManagedBy   = "terraform"
  }

  # AZ→subnet zip. Using the index lets subnets align 1:1 with
  # var.availability_zones even when the list shrinks to two in
  # smaller regions.
  az_count = length(var.availability_zones)

  # Service → per-service knobs. Keeping the shape consistent across
  # api/kernel/worker lets the ECS service resource iterate with one
  # for_each.
  services = {
    api = {
      image_name      = "erp-api"
      cpu             = var.api_cpu
      memory          = var.api_memory
      desired_count   = var.api_desired_count
      container_port  = 4000
      health_path     = "/readyz"
      has_public_alb  = true
      has_private_alb = false
    }
    kernel = {
      image_name      = "erp-kernel"
      cpu             = var.kernel_cpu
      memory          = var.kernel_memory
      desired_count   = var.kernel_desired_count
      container_port  = 4100
      health_path     = "/readyz"
      has_public_alb  = false
      has_private_alb = true
    }
    worker = {
      image_name      = "erp-worker"
      cpu             = var.worker_cpu
      memory          = var.worker_memory
      desired_count   = var.worker_desired_count
      container_port  = 0
      health_path     = ""
      has_public_alb  = false
      has_private_alb = false
    }
  }
}
