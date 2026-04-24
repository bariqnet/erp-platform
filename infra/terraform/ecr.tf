# ECR — one private repo per service. Image mutability is OFF
# (tags immutable) so a `:sha-abc1234` tag always points at the
# same image forever — enables reliable rollback by tag.

locals {
  ecr_repositories = ["erp-api", "erp-kernel", "erp-worker", "erp-console"]
}

resource "aws_ecr_repository" "services" {
  for_each             = toset(local.ecr_repositories)
  name                 = each.value
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }

  tags = {
    Name = each.value
  }
}

# Lifecycle policy — keep the last 50 tagged images + expire
# untagged ones after 7 days. Prevents the bill from climbing
# indefinitely while leaving plenty of rollback history.
resource "aws_ecr_lifecycle_policy" "services" {
  for_each   = aws_ecr_repository.services
  repository = each.value.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Expire untagged images after 7 days"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 7
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Keep last 50 tagged images"
        selection = {
          tagStatus   = "tagged"
          tagPatternList = ["*"]
          countType   = "imageCountMoreThan"
          countNumber = 50
        }
        action = { type = "expire" }
      },
    ]
  })
}
