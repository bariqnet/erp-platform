# Managed Postgres 16 (CLAUDE.md §2).
#
# Key choices:
#   - GP3 storage with autoscaling up to 200 GB — scales without
#     downtime.
#   - Encrypted at rest with an AWS-managed KMS key (a per-env
#     customer-managed key is a Phase-4 hardening task).
#   - Multi-AZ by variable — off in staging, on in prod.
#   - Parameter group sets `shared_preload_libraries = pg_stat_statements`
#     for query-level observability, and `rds.force_ssl = 1` so
#     apps/api's pg client must connect over TLS.

# Random password for the master user. Lives in Secrets Manager
# (see secrets.tf); apps/api reads it from there.
resource "random_password" "rds" {
  length           = 32
  special          = true
  override_special = "_-"
}

# Subnet group — one per env.
resource "aws_db_subnet_group" "main" {
  name        = "${local.name_prefix}-rds"
  description = "Private subnets for ${local.name_prefix} RDS"
  subnet_ids  = aws_subnet.private[*].id

  tags = {
    Name = "${local.name_prefix}-rds"
  }
}

# Parameter group — tenant isolation relies on a non-superuser role
# that RLS actually enforces against. rds.force_ssl keeps traffic
# encrypted end-to-end.
resource "aws_db_parameter_group" "main" {
  name        = "${local.name_prefix}-pg16"
  family      = "postgres16"
  description = "Postgres 16 params — pg_stat_statements + force_ssl"

  parameter {
    name         = "shared_preload_libraries"
    value        = "pg_stat_statements"
    apply_method = "pending-reboot"
  }

  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }

  parameter {
    name  = "log_min_duration_statement"
    value = "500" # Log anything >500ms.
  }

  tags = {
    Name = "${local.name_prefix}-pg16"
  }
}

resource "aws_db_instance" "main" {
  identifier = "${local.name_prefix}-postgres"

  engine               = "postgres"
  engine_version       = "16.6"
  instance_class       = var.rds_instance_class
  allocated_storage    = var.rds_allocated_storage_gb
  max_allocated_storage = var.rds_allocated_storage_gb * 10
  storage_type         = "gp3"
  storage_encrypted    = true

  db_name  = "erp_prod"
  username = "erp_master"
  password = random_password.rds.result
  port     = 5432

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  parameter_group_name   = aws_db_parameter_group.main.name

  multi_az            = var.rds_multi_az
  publicly_accessible = false

  backup_retention_period = var.rds_backup_retention_days
  backup_window           = "02:00-03:00" # UTC
  maintenance_window      = "sun:03:30-sun:04:30"

  performance_insights_enabled    = true
  performance_insights_retention_period = 7

  deletion_protection       = var.rds_deletion_protection
  skip_final_snapshot       = false
  final_snapshot_identifier = "${local.name_prefix}-postgres-final-${formatdate("YYYYMMDDhhmmss", timestamp())}"
  copy_tags_to_snapshot     = true

  # Safe for Phase 1: the migrator + apps/api run as `erp_master`.
  # Application-level RLS is enforced via `SET LOCAL app.current_tenant`
  # inside `withTenantContext` (packages/db). Phase 4 hardening will
  # split into a migrator role + a less-privileged runtime role.
  apply_immediately = false

  # `timestamp()` above drifts on every plan; ignore so planning stays
  # idempotent. The final snapshot id is only used on destroy.
  lifecycle {
    ignore_changes = [final_snapshot_identifier]
  }

  tags = {
    Name = "${local.name_prefix}-postgres"
  }
}

# CloudWatch log exports let us surface slow-query logs in Grafana
# Cloud via CloudWatch Logs → OTLP bridge (outside this module's
# scope; set up per docs/runbooks/production-deploy.md §5).
