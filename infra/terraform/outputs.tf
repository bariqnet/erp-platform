# Outputs consumed by the deploy workflow + operators.
#
# Usage:
#   terraform output -json ecr_repository_urls
#   terraform output api_public_url

# ── Endpoints ────────────────────────────────────────────────────

output "api_public_url" {
  description = "Public URL the console + integrators point at. Use HTTPS in prod."
  value = (
    var.acm_certificate_arn != ""
    ? "https://${aws_lb.public.dns_name}"
    : "http://${aws_lb.public.dns_name}"
  )
}

output "api_public_alb_dns" {
  description = "Raw public-ALB DNS name — use this as the CNAME target when wiring ${var.api_domain_name}."
  value       = aws_lb.public.dns_name
}

output "kernel_internal_url" {
  description = "Internal URL for apps/api → apps/kernel resolve RPC."
  value       = "http://${aws_lb.internal.dns_name}"
}

output "rds_endpoint" {
  description = "RDS endpoint (use DATABASE_URL secret for connections, not this)."
  value       = aws_db_instance.main.address
  sensitive   = false
}

output "redis_endpoint" {
  description = "ElastiCache primary endpoint."
  value       = aws_elasticache_replication_group.main.primary_endpoint_address
  sensitive   = false
}

output "attachments_bucket" {
  description = "S3 bucket for tenant attachments."
  value       = aws_s3_bucket.attachments.id
}

# ── ECR repos — one per service ─────────────────────────────────

output "ecr_repository_urls" {
  description = "Map of service → ECR repo URL. The deploy workflow builds + pushes to these."
  value       = { for k, v in aws_ecr_repository.services : k => v.repository_url }
}

output "ecs_cluster_name" {
  description = "ECS cluster name — deploy workflow uses this in `aws ecs update-service`."
  value       = aws_ecs_cluster.main.name
}

output "ecs_service_names" {
  description = "Service names per role."
  value = {
    api    = aws_ecs_service.api.name
    kernel = aws_ecs_service.kernel.name
    worker = aws_ecs_service.worker.name
  }
}

# ── Secret ARNs (for out-of-band population) ─────────────────────

output "secret_arns" {
  description = "Secret ARNs the operator populates via awscli (BETTER_AUTH_SECRET + GRAFANA_CLOUD_OTLP_HEADERS)."
  value = {
    database_url          = aws_secretsmanager_secret.database_url.arn
    redis_url             = aws_secretsmanager_secret.redis_url.arn
    better_auth_secret    = aws_secretsmanager_secret.better_auth_secret.arn
    grafana_otlp_headers  = aws_secretsmanager_secret.grafana_otlp_headers.arn
  }
}
