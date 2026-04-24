# AWS Secrets Manager entries that ECS tasks resolve at container
# start via `secrets = [{ name, valueFrom }]` in their task
# definition. Keeps every sensitive value out of the Terraform state
# file and out of CloudWatch log lines.
#
# Populated here:
#
#   database_url          — postgres://erp_master:<random>@<rds-endpoint>:5432/erp_prod
#   redis_url             — redis://<redis-endpoint>:6379
#
# Populated OUTSIDE Terraform (see docs/runbooks/production-deploy.md):
#
#   better_auth_secret    — session signing key (TASK-10.1b.1)
#   grafana_otlp_headers  — authorization=Basic <base64(instance:token)>
#
# Splitting keeps `terraform apply` idempotent even when the human
# operator has yet to mint the external secrets.

resource "aws_secretsmanager_secret" "database_url" {
  name                    = "${local.name_prefix}/database_url"
  description             = "Postgres connection string — consumed by apps/api, apps/kernel, apps/worker."
  recovery_window_in_days = 7

  tags = {
    Name = "${local.name_prefix}-database-url"
  }
}

resource "aws_secretsmanager_secret_version" "database_url" {
  secret_id = aws_secretsmanager_secret.database_url.id
  secret_string = format(
    "postgresql://%s:%s@%s:%d/%s?sslmode=require",
    aws_db_instance.main.username,
    random_password.rds.result,
    aws_db_instance.main.address,
    aws_db_instance.main.port,
    aws_db_instance.main.db_name,
  )
}

resource "aws_secretsmanager_secret" "redis_url" {
  name                    = "${local.name_prefix}/redis_url"
  description             = "Redis URL — apps/kernel L2 cache."
  recovery_window_in_days = 7

  tags = {
    Name = "${local.name_prefix}-redis-url"
  }
}

resource "aws_secretsmanager_secret_version" "redis_url" {
  secret_id = aws_secretsmanager_secret.redis_url.id
  secret_string = format(
    "rediss://%s:%d",
    aws_elasticache_replication_group.main.primary_endpoint_address,
    aws_elasticache_replication_group.main.port,
  )
}

# Placeholders for externally-populated secrets. Creating the Secret
# resource without a SecretVersion yields a well-known ARN that
# task definitions can reference; the first deploy after the human
# pushes a value picks it up.

resource "aws_secretsmanager_secret" "better_auth_secret" {
  name                    = "${local.name_prefix}/better_auth_secret"
  description             = "Session signing key for Better Auth (TASK-10.1b.1). Populate via awscli."
  recovery_window_in_days = 7

  tags = {
    Name = "${local.name_prefix}-better-auth-secret"
  }
}

resource "aws_secretsmanager_secret" "grafana_otlp_headers" {
  name                    = "${local.name_prefix}/grafana_otlp_headers"
  description             = "OTEL-spec headers string (authorization=Basic <b64(instance:token)>). Populate via awscli."
  recovery_window_in_days = 7

  tags = {
    Name = "${local.name_prefix}-grafana-otlp-headers"
  }
}
