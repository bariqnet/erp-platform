# ECS Fargate — cluster, IAM roles, log groups, task definitions,
# services. Three services (api, kernel, worker) share one cluster.
#
# Patterns:
#   - Task-exec role reads container images from ECR + pulls
#     secrets from Secrets Manager.
#   - Task role (app runtime) gets per-service policies: apps/api
#     reads S3 attachments + KMS, apps/worker the same. apps/kernel
#     touches Redis + Postgres only (no AWS SDK calls).
#   - Log driver is awslogs → CloudWatch. Every service has its own
#     log group with retention from var.log_retention_days.
#   - Container definitions reference Secrets Manager by ARN so ECS
#     resolves at container start; no plaintext in the task-def.

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

# ── Cluster ──────────────────────────────────────────────────────

resource "aws_ecs_cluster" "main" {
  name = "${local.name_prefix}-cluster"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  tags = {
    Name = "${local.name_prefix}-cluster"
  }
}

resource "aws_ecs_cluster_capacity_providers" "main" {
  cluster_name       = aws_ecs_cluster.main.name
  capacity_providers = ["FARGATE", "FARGATE_SPOT"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 100
  }
}

# ── CloudWatch log groups ────────────────────────────────────────

resource "aws_cloudwatch_log_group" "services" {
  for_each          = local.services
  name              = "/${local.name_prefix}/${each.key}"
  retention_in_days = var.log_retention_days

  tags = {
    Name = "${local.name_prefix}-${each.key}"
  }
}

# ── IAM: task-execution role (shared) ────────────────────────────
# This role is what ECS itself assumes to pull images + secrets +
# write logs. Not to be confused with the task role (app runtime
# permissions).

data "aws_iam_policy_document" "ecs_tasks_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "task_exec" {
  name               = "${local.name_prefix}-task-exec"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_trust.json

  tags = {
    Name = "${local.name_prefix}-task-exec"
  }
}

resource "aws_iam_role_policy_attachment" "task_exec_managed" {
  role       = aws_iam_role.task_exec.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# Extra: pull secrets for all four secret ARNs.
data "aws_iam_policy_document" "task_exec_secrets" {
  statement {
    actions = [
      "secretsmanager:GetSecretValue",
      "kms:Decrypt",
    ]
    resources = [
      aws_secretsmanager_secret.database_url.arn,
      aws_secretsmanager_secret.redis_url.arn,
      aws_secretsmanager_secret.better_auth_secret.arn,
      aws_secretsmanager_secret.grafana_otlp_headers.arn,
    ]
  }
}

resource "aws_iam_role_policy" "task_exec_secrets" {
  name   = "${local.name_prefix}-task-exec-secrets"
  role   = aws_iam_role.task_exec.id
  policy = data.aws_iam_policy_document.task_exec_secrets.json
}

# ── IAM: task role (per service) ─────────────────────────────────

resource "aws_iam_role" "task" {
  for_each           = local.services
  name               = "${local.name_prefix}-task-${each.key}"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_trust.json

  tags = {
    Name = "${local.name_prefix}-task-${each.key}"
  }
}

# apps/api + apps/worker get S3 read/write on the attachments bucket.
# apps/kernel does not touch S3.
data "aws_iam_policy_document" "s3_attachments" {
  statement {
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
      "s3:ListBucket",
    ]
    resources = [
      aws_s3_bucket.attachments.arn,
      "${aws_s3_bucket.attachments.arn}/*",
    ]
  }
}

resource "aws_iam_role_policy" "api_s3" {
  name   = "${local.name_prefix}-api-s3"
  role   = aws_iam_role.task["api"].id
  policy = data.aws_iam_policy_document.s3_attachments.json
}

resource "aws_iam_role_policy" "worker_s3" {
  name   = "${local.name_prefix}-worker-s3"
  role   = aws_iam_role.task["worker"].id
  policy = data.aws_iam_policy_document.s3_attachments.json
}

# ── Task definitions ─────────────────────────────────────────────

locals {
  ecr_account  = data.aws_caller_identity.current.account_id
  ecr_registry = "${data.aws_caller_identity.current.account_id}.dkr.ecr.${data.aws_region.current.name}.amazonaws.com"

  # Secrets every service reads (via task-exec role → Secrets Manager).
  # `DATABASE_URL` + `REDIS_URL` are pulled from AWS; `GRAFANA_CLOUD_*`
  # are pulled too but resolve to the empty string when the human
  # hasn't populated them yet — that's the no-op branch in
  # registerOtelSdkFromEnv().
  common_secrets = [
    { name = "DATABASE_URL", valueFrom = aws_secretsmanager_secret.database_url.arn },
    { name = "REDIS_URL", valueFrom = aws_secretsmanager_secret.redis_url.arn },
    { name = "GRAFANA_CLOUD_OTLP_HEADERS", valueFrom = aws_secretsmanager_secret.grafana_otlp_headers.arn },
    { name = "BETTER_AUTH_SECRET", valueFrom = aws_secretsmanager_secret.better_auth_secret.arn },
  ]

  # Plain-text env values (no secrets). Populated per service in the
  # container definition.
  common_env = [
    { name = "NODE_ENV", value = "production" },
    { name = "LOG_LEVEL", value = "info" },
    { name = "GRAFANA_CLOUD_OTLP_ENDPOINT", value = "" }, # Filled by the operator after ACM + OTLP endpoint chosen.
  ]
}

resource "aws_ecs_task_definition" "services" {
  for_each = local.services

  family                   = "${local.name_prefix}-${each.key}"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = each.value.cpu
  memory                   = each.value.memory
  execution_role_arn       = aws_iam_role.task_exec.arn
  task_role_arn            = aws_iam_role.task[each.key].arn

  container_definitions = jsonencode([
    {
      name      = each.key
      image     = "${local.ecr_registry}/${each.value.image_name}:${var.image_tag}"
      essential = true

      portMappings = each.value.container_port > 0 ? [
        {
          containerPort = each.value.container_port
          hostPort      = each.value.container_port
          protocol      = "tcp"
        }
      ] : []

      environment = concat(local.common_env,
        each.key == "api" ? [{ name = "PORT", value = "4000" }] : [],
        each.key == "kernel" ? [{ name = "KERNEL_PORT", value = "4100" }] : [],
      )
      secrets = local.common_secrets

      healthCheck = each.value.container_port > 0 ? {
        command     = ["CMD-SHELL", "wget -q -O /dev/null http://127.0.0.1:${each.value.container_port}${each.value.health_path} || exit 1"]
        interval    = 15
        timeout     = 5
        retries     = 3
        startPeriod = 20
      } : null

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.services[each.key].name
          awslogs-region        = data.aws_region.current.name
          awslogs-stream-prefix = each.key
        }
      }

      readonlyRootFilesystem = false # Node writes temp files in dev; tighten to true once audited.
    }
  ])

  tags = {
    Name = "${local.name_prefix}-${each.key}"
  }
}

# ── Services ─────────────────────────────────────────────────────

resource "aws_ecs_service" "api" {
  name            = "${local.name_prefix}-api"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.services["api"].arn
  desired_count   = local.services.api.desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.ecs_api.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = 4000
  }

  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  health_check_grace_period_seconds  = 60

  depends_on = [aws_lb_listener.public_http]

  tags = {
    Name = "${local.name_prefix}-api"
  }

  # Allow out-of-band task-definition rotation (e.g. a deploy
  # workflow doing `aws ecs update-service --force-new-deployment`
  # with a fresh image tag).
  lifecycle {
    ignore_changes = [task_definition, desired_count]
  }
}

resource "aws_ecs_service" "kernel" {
  name            = "${local.name_prefix}-kernel"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.services["kernel"].arn
  desired_count   = local.services.kernel.desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.ecs_kernel.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.kernel.arn
    container_name   = "kernel"
    container_port   = 4100
  }

  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  health_check_grace_period_seconds  = 60

  depends_on = [aws_lb_listener.internal_http]

  tags = {
    Name = "${local.name_prefix}-kernel"
  }

  lifecycle {
    ignore_changes = [task_definition, desired_count]
  }
}

resource "aws_ecs_service" "worker" {
  name            = "${local.name_prefix}-worker"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.services["worker"].arn
  desired_count   = local.services.worker.desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.ecs_worker.id]
    assign_public_ip = false
  }

  # No ALB — worker has no HTTP surface. ECS service still manages
  # restarts on task crash because `essential = true`.

  deployment_minimum_healthy_percent = 0 # Worker can be down briefly during deploy.
  deployment_maximum_percent         = 200

  tags = {
    Name = "${local.name_prefix}-worker"
  }

  lifecycle {
    ignore_changes = [task_definition, desired_count]
  }
}
