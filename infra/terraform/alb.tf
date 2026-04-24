# Application Load Balancers.
#
# Public ALB: terminates TLS (via ACM cert var.acm_certificate_arn),
# forwards to apps/api over HTTP within the VPC. HTTP listener on
# :80 redirects to :443.
#
# Internal ALB: reachable only from within the VPC; forwards apps/api
# → apps/kernel on /internal/resolve.
#
# When var.acm_certificate_arn is empty, the public ALB skips the
# :443 listener and runs HTTP-only — that's fine for a first
# `terraform apply` bring-up but must be fixed before pilot traffic
# hits the URL.

# ── Public ALB (apps/api) ───────────────────────────────────────

resource "aws_lb" "public" {
  name               = "${local.name_prefix}-public"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb_public.id]
  subnets            = aws_subnet.public[*].id

  # Prod hardening: deletion protection, S3 access logs, idle 60 s.
  enable_deletion_protection = var.environment == "prod"
  idle_timeout               = 60

  tags = {
    Name = "${local.name_prefix}-public"
  }
}

resource "aws_lb_target_group" "api" {
  name        = "${local.name_prefix}-api"
  port        = 4000
  protocol    = "HTTP"
  target_type = "ip" # Required for Fargate.
  vpc_id      = aws_vpc.main.id

  health_check {
    path                = "/readyz"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  deregistration_delay = 30

  tags = {
    Name = "${local.name_prefix}-api"
  }
}

# HTTP → HTTPS redirect (when a cert is provided) or direct HTTP
# forwarding for bootstrap.
resource "aws_lb_listener" "public_http" {
  load_balancer_arn = aws_lb.public.arn
  port              = 80
  protocol          = "HTTP"

  dynamic "default_action" {
    for_each = var.acm_certificate_arn != "" ? [1] : []
    content {
      type = "redirect"
      redirect {
        port        = "443"
        protocol    = "HTTPS"
        status_code = "HTTP_301"
      }
    }
  }

  dynamic "default_action" {
    for_each = var.acm_certificate_arn == "" ? [1] : []
    content {
      type             = "forward"
      target_group_arn = aws_lb_target_group.api.arn
    }
  }
}

resource "aws_lb_listener" "public_https" {
  count             = var.acm_certificate_arn != "" ? 1 : 0
  load_balancer_arn = aws_lb.public.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.acm_certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}

# ── Internal ALB (apps/kernel) ──────────────────────────────────

resource "aws_lb" "internal" {
  name               = "${local.name_prefix}-internal"
  internal           = true
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb_internal.id]
  subnets            = aws_subnet.private[*].id

  enable_deletion_protection = var.environment == "prod"
  idle_timeout               = 60

  tags = {
    Name = "${local.name_prefix}-internal"
  }
}

resource "aws_lb_target_group" "kernel" {
  name        = "${local.name_prefix}-kernel"
  port        = 4100
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.main.id

  health_check {
    path                = "/readyz"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  deregistration_delay = 30

  tags = {
    Name = "${local.name_prefix}-kernel"
  }
}

resource "aws_lb_listener" "internal_http" {
  load_balancer_arn = aws_lb.internal.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.kernel.arn
  }
}
