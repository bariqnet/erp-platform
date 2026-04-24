# AWS provider. Region + profile come from variables so the same
# root module can target staging and prod via different `-var-file=`
# passes. Every resource this module creates carries the default_tags
# set so billing exports group-by platform/env cleanly.

provider "aws" {
  region  = var.aws_region
  profile = var.aws_profile

  default_tags {
    tags = {
      Platform    = "erp"
      Environment = var.environment
      ManagedBy   = "terraform"
      Repo        = "github.com/bariqnet/erp-platform"
    }
  }
}
