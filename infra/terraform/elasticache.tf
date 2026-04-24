# ElastiCache — Redis 7 cluster for the kernel's L2 cache
# (CLAUDE.md §2, RFC §5.3).
#
# Shape:
#   - cluster-mode disabled (one shard is enough; we cache per-tenant
#     metadata, not a globally-sharded dataset)
#   - replication group (not single node) so failover works
#   - encryption in transit + at rest
#   - automatic failover when num_nodes > 1

resource "aws_elasticache_subnet_group" "main" {
  name       = "${local.name_prefix}-redis"
  subnet_ids = aws_subnet.private[*].id

  tags = {
    Name = "${local.name_prefix}-redis"
  }
}

# Dedicated parameter group in case future tuning needs diverge from
# the AWS default (eviction policy, timeouts, etc).
resource "aws_elasticache_parameter_group" "main" {
  name        = "${local.name_prefix}-redis7"
  family      = "redis7"
  description = "Redis 7 params for ${local.name_prefix}"

  parameter {
    name  = "maxmemory-policy"
    value = "allkeys-lru" # Kernel cache is rebuildable; LRU is correct.
  }
}

resource "aws_elasticache_replication_group" "main" {
  replication_group_id = "${local.name_prefix}-redis"
  description          = "L2 cache for apps/kernel"

  engine         = "redis"
  engine_version = "7.1"
  node_type      = var.redis_node_type
  port           = 6379

  num_cache_clusters = var.redis_num_nodes
  automatic_failover_enabled = var.redis_num_nodes > 1
  multi_az_enabled           = var.redis_num_nodes > 1

  parameter_group_name = aws_elasticache_parameter_group.main.name
  subnet_group_name    = aws_elasticache_subnet_group.main.name
  security_group_ids   = [aws_security_group.redis.id]

  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  # No password on REDIS — in-VPC, SG-scoped. A future task can add
  # `auth_token` + rotate via Secrets Manager if compliance demands.

  # Snapshots are cheap insurance against the kernel needing to warm
  # a big tenant's cache from cold.
  snapshot_retention_limit = 1
  snapshot_window          = "03:00-04:00" # UTC

  maintenance_window = "sun:04:30-sun:05:30"

  tags = {
    Name = "${local.name_prefix}-redis"
  }
}
