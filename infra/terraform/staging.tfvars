# Staging overrides. `terraform apply -var-file=staging.tfvars`.
#
# Differences from defaults:
#   - No deletion protection on RDS (staging can rebuild)
#   - Multi-AZ OFF (cost)
#   - One Redis node (no failover)
#   - Smaller desired_count
#   - No ACM cert (HTTP bootstrap — wire HTTPS before any real users)

environment              = "staging"
rds_multi_az             = false
rds_deletion_protection  = false
redis_num_nodes          = 1
api_desired_count        = 1
kernel_desired_count     = 1
worker_desired_count     = 1
acm_certificate_arn      = ""
api_domain_name          = ""
