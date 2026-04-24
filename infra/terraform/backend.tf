# S3 + DynamoDB remote state.
#
# The bucket + table themselves live OUTSIDE this module — bootstrap
# them once per AWS account via `infra/terraform/bootstrap/` before
# `terraform init` on this root module (see docs/runbooks/
# production-deploy.md §1).
#
# Two environments (staging, prod) share the same bucket with
# per-env keys:
#
#   env/staging/terraform.tfstate
#   env/prod/terraform.tfstate
#
# Pass the key at init time:
#
#   terraform init \
#     -backend-config="bucket=erp-tf-state-<acct-id>" \
#     -backend-config="key=env/staging/terraform.tfstate" \
#     -backend-config="region=eu-central-1" \
#     -backend-config="dynamodb_table=erp-tf-locks" \
#     -backend-config="encrypt=true"

terraform {
  backend "s3" {
    # Every field here is a placeholder; real values come from
    # `-backend-config` flags in the workflow + runbook.
  }
}
