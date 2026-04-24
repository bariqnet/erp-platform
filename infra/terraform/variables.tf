# Input variables.
#
# Every value a reviewer might reasonably want to tune between
# staging and prod lives here. Defaults aim at staging — pass a
# `prod.tfvars` for the production stack (see docs/runbooks/
# production-deploy.md).

# ── Identity ────────────────────────────────────────────────────

variable "aws_region" {
  description = "AWS region. CLAUDE.md §2 pins eu-central-1 (Frankfurt)."
  type        = string
  default     = "eu-central-1"
}

variable "aws_profile" {
  description = "Named profile in ~/.aws/credentials. Leave empty to fall back to env vars / instance role."
  type        = string
  default     = ""
}

variable "environment" {
  description = "staging | prod. Appears in every resource name + tag."
  type        = string
  default     = "staging"

  validation {
    condition     = contains(["staging", "prod"], var.environment)
    error_message = "environment must be staging or prod."
  }
}

variable "platform_prefix" {
  description = "Name prefix for every resource. Keeps names short (<63 chars for RDS, <32 for ALB)."
  type        = string
  default     = "erp"
}

# ── Networking ──────────────────────────────────────────────────

variable "vpc_cidr" {
  description = "IPv4 CIDR block for the VPC. Leaves room for /20 subnets in 3 AZs + a /16 reserve."
  type        = string
  default     = "10.40.0.0/16"
}

variable "availability_zones" {
  description = "AZ names. eu-central-1 has three; we use all so RDS multi-AZ + ECS balanced placement work."
  type        = list(string)
  default     = ["eu-central-1a", "eu-central-1b", "eu-central-1c"]
}

variable "public_subnet_cidrs" {
  description = "One /24 per AZ for the ALB + NAT gateways."
  type        = list(string)
  default     = ["10.40.0.0/24", "10.40.1.0/24", "10.40.2.0/24"]
}

variable "private_subnet_cidrs" {
  description = "One /22 per AZ for ECS tasks + RDS + ElastiCache. Bigger so tasks have room to scale."
  type        = list(string)
  default     = ["10.40.16.0/22", "10.40.20.0/22", "10.40.24.0/22"]
}

# ── RDS ──────────────────────────────────────────────────────────

variable "rds_instance_class" {
  description = "RDS instance size. Staging default is t4g.small; bump for prod."
  type        = string
  default     = "db.t4g.small"
}

variable "rds_allocated_storage_gb" {
  description = "Initial GP3 storage. Auto-scaling max lives in rds.tf."
  type        = number
  default     = 20
}

variable "rds_multi_az" {
  description = "Standby replica in a second AZ. Mandatory for prod; optional for staging."
  type        = bool
  default     = false
}

variable "rds_backup_retention_days" {
  description = "Daily automated backups. Minimum for prod is 7."
  type        = number
  default     = 7
}

variable "rds_deletion_protection" {
  description = "Blocks accidental `terraform destroy`. Keep ON in prod."
  type        = bool
  default     = true
}

# ── ElastiCache ─────────────────────────────────────────────────

variable "redis_node_type" {
  description = "ElastiCache node size. t4g.small is enough for the kernel's L2 cache volume."
  type        = string
  default     = "cache.t4g.small"
}

variable "redis_num_nodes" {
  description = "Replica count. Staging: 1 (single AZ). Prod: 2 (cross-AZ)."
  type        = number
  default     = 1
}

# ── ECS / service sizes ─────────────────────────────────────────

variable "api_cpu" {
  description = "Fargate CPU units for apps/api. 1024 = 1 vCPU."
  type        = number
  default     = 512
}

variable "api_memory" {
  description = "Fargate memory (MiB) for apps/api."
  type        = number
  default     = 1024
}

variable "api_desired_count" {
  description = "Steady-state task count for apps/api. Autoscaling floors/ceilings are in ecs.tf."
  type        = number
  default     = 2
}

variable "kernel_cpu" {
  description = "Fargate CPU units for apps/kernel."
  type        = number
  default     = 512
}

variable "kernel_memory" {
  description = "Fargate memory (MiB) for apps/kernel."
  type        = number
  default     = 1024
}

variable "kernel_desired_count" {
  description = "Steady-state task count for apps/kernel."
  type        = number
  default     = 2
}

variable "worker_cpu" {
  description = "Fargate CPU units for apps/worker."
  type        = number
  default     = 256
}

variable "worker_memory" {
  description = "Fargate memory (MiB) for apps/worker."
  type        = number
  default     = 512
}

variable "worker_desired_count" {
  description = "Steady-state task count for apps/worker. Running >1 is safe — outbox polling uses SKIP LOCKED."
  type        = number
  default     = 1
}

# ── TLS / DNS ───────────────────────────────────────────────────

variable "acm_certificate_arn" {
  description = "ARN of an ACM cert covering api.<domain>. Leave empty to use HTTP-only (staging bootstrap)."
  type        = string
  default     = ""
}

variable "api_domain_name" {
  description = "Fully-qualified DNS name for the public ALB. Optional in staging; required in prod."
  type        = string
  default     = ""
}

# ── Observability ───────────────────────────────────────────────

variable "log_retention_days" {
  description = "CloudWatch log group retention. 30 is plenty when primary observability is Grafana Cloud OTLP."
  type        = number
  default     = 30
}

# ── Image tags ──────────────────────────────────────────────────

variable "image_tag" {
  description = "Container image tag to deploy. Deploy workflow overrides via -var image_tag=sha-<commit>."
  type        = string
  default     = "latest"
}
