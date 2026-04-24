# Provider pins. The AWS provider tracks major versions; floating on
# ~> 5.x picks up bug fixes via `terraform init -upgrade` without
# surprise breaking changes. Terraform itself is pinned to 1.9+ so
# features like `moved` blocks and `import` blocks are available.

terraform {
  required_version = ">= 1.9"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.70"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}
