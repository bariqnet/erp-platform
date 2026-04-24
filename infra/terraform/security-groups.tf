# Security groups — one per role. Each SG holds only `egress 0.0.0.0/0`
# by default; cross-SG ingress rules are declared separately so a
# human reviewer sees "what can talk to what" at a glance.
#
# Graph (arrows = ingress):
#
#   internet ──443──> alb-public ──4000──> ecs-api ──5432──> rds
#                                          │    │
#                                          │    └──6379──> redis
#                                          │
#                                          └────4100──> ecs-kernel
#                                          (via alb-internal)
#
#   ecs-worker ──5432──> rds
#   ecs-worker ──6379──> redis (occasional; tolerated)

# ── Public ALB ──────────────────────────────────────────────────

resource "aws_security_group" "alb_public" {
  name        = "${local.name_prefix}-alb-public"
  description = "Public ALB in front of apps/api"
  vpc_id      = aws_vpc.main.id

  tags = {
    Name = "${local.name_prefix}-alb-public"
  }
}

resource "aws_vpc_security_group_ingress_rule" "alb_public_https" {
  security_group_id = aws_security_group.alb_public.id
  description       = "HTTPS from the internet"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_security_group_ingress_rule" "alb_public_http" {
  # HTTP→HTTPS redirect only. See alb.tf for the listener rule.
  security_group_id = aws_security_group.alb_public.id
  description       = "HTTP (redirect to HTTPS)"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_vpc_security_group_egress_rule" "alb_public_all" {
  security_group_id = aws_security_group.alb_public.id
  description       = "All egress"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

# ── Internal ALB (kernel) ───────────────────────────────────────

resource "aws_security_group" "alb_internal" {
  name        = "${local.name_prefix}-alb-internal"
  description = "Internal ALB in front of apps/kernel — only apps/api talks to it"
  vpc_id      = aws_vpc.main.id

  tags = {
    Name = "${local.name_prefix}-alb-internal"
  }
}

resource "aws_vpc_security_group_egress_rule" "alb_internal_all" {
  security_group_id = aws_security_group.alb_internal.id
  description       = "All egress"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

# ── ECS services ────────────────────────────────────────────────

resource "aws_security_group" "ecs_api" {
  name        = "${local.name_prefix}-ecs-api"
  description = "apps/api Fargate tasks"
  vpc_id      = aws_vpc.main.id

  tags = {
    Name = "${local.name_prefix}-ecs-api"
  }
}

resource "aws_security_group" "ecs_kernel" {
  name        = "${local.name_prefix}-ecs-kernel"
  description = "apps/kernel Fargate tasks"
  vpc_id      = aws_vpc.main.id

  tags = {
    Name = "${local.name_prefix}-ecs-kernel"
  }
}

resource "aws_security_group" "ecs_worker" {
  name        = "${local.name_prefix}-ecs-worker"
  description = "apps/worker Fargate tasks"
  vpc_id      = aws_vpc.main.id

  tags = {
    Name = "${local.name_prefix}-ecs-worker"
  }
}

# Public ALB → ECS API:
resource "aws_vpc_security_group_ingress_rule" "alb_public_to_api" {
  security_group_id            = aws_security_group.ecs_api.id
  description                  = "Public ALB → apps/api"
  referenced_security_group_id = aws_security_group.alb_public.id
  ip_protocol                  = "tcp"
  from_port                    = 4000
  to_port                      = 4000
}

resource "aws_vpc_security_group_egress_rule" "alb_public_to_api_egress" {
  security_group_id            = aws_security_group.alb_public.id
  description                  = "Public ALB → apps/api"
  referenced_security_group_id = aws_security_group.ecs_api.id
  ip_protocol                  = "tcp"
  from_port                    = 4000
  to_port                      = 4000
}

# Internal ALB → ECS kernel:
resource "aws_vpc_security_group_ingress_rule" "alb_internal_to_kernel" {
  security_group_id            = aws_security_group.ecs_kernel.id
  description                  = "Internal ALB → apps/kernel"
  referenced_security_group_id = aws_security_group.alb_internal.id
  ip_protocol                  = "tcp"
  from_port                    = 4100
  to_port                      = 4100
}

# ECS API → internal ALB (kernel resolve RPC):
resource "aws_vpc_security_group_ingress_rule" "api_to_alb_internal" {
  security_group_id            = aws_security_group.alb_internal.id
  description                  = "apps/api → internal ALB"
  referenced_security_group_id = aws_security_group.ecs_api.id
  ip_protocol                  = "tcp"
  from_port                    = 80
  to_port                      = 80
}

# ECS service egress — tasks need to reach the internet for image
# pulls + OTLP exports to Grafana Cloud. Allow all egress; ingress
# is already locked down.
resource "aws_vpc_security_group_egress_rule" "ecs_api_all" {
  security_group_id = aws_security_group.ecs_api.id
  description       = "All egress"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_vpc_security_group_egress_rule" "ecs_kernel_all" {
  security_group_id = aws_security_group.ecs_kernel.id
  description       = "All egress"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_vpc_security_group_egress_rule" "ecs_worker_all" {
  security_group_id = aws_security_group.ecs_worker.id
  description       = "All egress"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

# ── RDS ─────────────────────────────────────────────────────────

resource "aws_security_group" "rds" {
  name        = "${local.name_prefix}-rds"
  description = "Postgres — accessible only from ECS tasks"
  vpc_id      = aws_vpc.main.id

  tags = {
    Name = "${local.name_prefix}-rds"
  }
}

resource "aws_vpc_security_group_ingress_rule" "rds_from_api" {
  security_group_id            = aws_security_group.rds.id
  description                  = "apps/api → Postgres"
  referenced_security_group_id = aws_security_group.ecs_api.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

resource "aws_vpc_security_group_ingress_rule" "rds_from_kernel" {
  security_group_id            = aws_security_group.rds.id
  description                  = "apps/kernel → Postgres"
  referenced_security_group_id = aws_security_group.ecs_kernel.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

resource "aws_vpc_security_group_ingress_rule" "rds_from_worker" {
  security_group_id            = aws_security_group.rds.id
  description                  = "apps/worker → Postgres"
  referenced_security_group_id = aws_security_group.ecs_worker.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

# ── ElastiCache ─────────────────────────────────────────────────

resource "aws_security_group" "redis" {
  name        = "${local.name_prefix}-redis"
  description = "ElastiCache — accessible only from ECS tasks"
  vpc_id      = aws_vpc.main.id

  tags = {
    Name = "${local.name_prefix}-redis"
  }
}

resource "aws_vpc_security_group_ingress_rule" "redis_from_api" {
  security_group_id            = aws_security_group.redis.id
  description                  = "apps/api → Redis"
  referenced_security_group_id = aws_security_group.ecs_api.id
  ip_protocol                  = "tcp"
  from_port                    = 6379
  to_port                      = 6379
}

resource "aws_vpc_security_group_ingress_rule" "redis_from_kernel" {
  security_group_id            = aws_security_group.redis.id
  description                  = "apps/kernel → Redis (L2 cache)"
  referenced_security_group_id = aws_security_group.ecs_kernel.id
  ip_protocol                  = "tcp"
  from_port                    = 6379
  to_port                      = 6379
}
