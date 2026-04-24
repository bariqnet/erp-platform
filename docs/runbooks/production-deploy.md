# Production deploy runbook

> **Audience:** single-engineer operator (you, the future you, or the
> next Claude session picking up operations). Every step here
> assumes a clean AWS account; a running stack skips straight to
> §4.

The stack lives in `infra/terraform/` and is wired for
**eu-central-1** (Frankfurt) per CLAUDE.md §2. Staging and prod
share one set of HCL files — environment tunables live in
`staging.tfvars` and `prod.tfvars`.

---

## 1 · One-time bootstrap (per AWS account)

Create the S3 bucket + DynamoDB table that hold Terraform's remote
state. The bootstrap module uses a **local** `terraform.tfstate` —
it's the only local-state Terraform in the repo.

```bash
cd infra/terraform/bootstrap
terraform init
terraform apply
terraform output            # record `state_bucket` + `lock_table`
```

Expected outputs:

```
lock_table    = "erp-tf-locks"
state_bucket  = "erp-tf-state-<account-id>-<hex>"
```

Save both; every subsequent `terraform init` on the main module
passes them via `-backend-config`.

**Then set up the GitHub OIDC role** the deploy workflow assumes.
Terraform doesn't manage this (chicken-and-egg — the workflow is
what applies Terraform). Use the AWS console or the `aws` CLI:

1. IAM → Identity providers → Add provider → OpenID Connect
   - Provider URL: `https://token.actions.githubusercontent.com`
   - Audience: `sts.amazonaws.com`
2. IAM → Roles → Create role → Web identity → use the provider
   - Trust condition: `repo:<org>/erp-platform:ref:refs/heads/main`
3. Attach policy: `AdministratorAccess` (tight it after the first
   deploy succeeds — see §8 below).
4. Copy the role ARN into the repo secret `AWS_DEPLOY_ROLE_ARN`.

---

## 2 · First apply (staging)

```bash
cd infra/terraform
terraform init \
  -backend-config="bucket=<state-bucket>" \
  -backend-config="key=env/staging/terraform.tfstate" \
  -backend-config="region=eu-central-1" \
  -backend-config="dynamodb_table=erp-tf-locks" \
  -backend-config="encrypt=true"

terraform workspace new staging      # optional — keeps state keys tidy
terraform plan  -var-file=staging.tfvars
terraform apply -var-file=staging.tfvars
```

First apply takes ~15-20 minutes (RDS is the long pole). After it
finishes:

```bash
terraform output
```

Capture `api_public_url`, `ecr_repository_urls`, `secret_arns`.

### What's still empty after the first apply

Two secrets ship as empty placeholders — populate via CLI before
the first deploy or the ECS tasks will crash-loop:

```bash
# 1. Better Auth session signing key (random 64 bytes, hex)
openssl rand -hex 64 | \
  aws secretsmanager put-secret-value \
    --secret-id "erp-staging/better_auth_secret" \
    --secret-string fileb:///dev/stdin

# 2. Grafana Cloud OTLP headers (see CLAUDE.md §2; leave empty to
#    disable the OTLP exporter — the apps fall back to the NoOp
#    tracer automatically).
INSTANCE_ID=...      # Grafana Cloud instance id
API_TOKEN=...        # Grafana Cloud API token with otlp:write
b64=$(printf "%s:%s" "$INSTANCE_ID" "$API_TOKEN" | base64)
header="authorization=Basic%20${b64}"
aws secretsmanager put-secret-value \
  --secret-id "erp-staging/grafana_otlp_headers" \
  --secret-string "$header"
```

Update `GRAFANA_CLOUD_OTLP_ENDPOINT` in the ECS task-definitions'
environment block (or flip it to a third Secrets Manager entry) —
the default is the empty string which disables OTLP export.

---

## 3 · First deploy (push images)

The deploy workflow (`.github/workflows/deploy.yml`) is what builds
and pushes container images. Trigger it the first time with a
manual dispatch:

```
Actions → Deploy → Run workflow → environment: staging
```

The workflow:

1. Builds four images via Buildx with GHA cache.
2. Pushes to the four ECR repos with tags `sha-<commit>` + `latest`.
3. Applies DB migrations against the RDS instance.
4. Forces ECS to redeploy each service with the fresh image.

Total time: ~6-10 minutes on a warm cache.

After it succeeds, hit the public URL:

```bash
curl "$(terraform output -raw api_public_url)/readyz"
# → {"status":"ready","checks":{"database":{"status":"pass","latency_ms":<n>}}}
```

---

## 4 · Seed the first tenant

The seed script is idempotent — run it from a runner with the right
`DATABASE_URL`:

```bash
db_url=$(aws secretsmanager get-secret-value \
  --secret-id "erp-staging/database_url" \
  --query SecretString --output text)
DATABASE_URL="$db_url" pnpm db:seed
```

If you can't reach the RDS endpoint from outside the VPC (expected —
RDS is private-subnets-only), use SSM Session Manager to tunnel in
from a bastion ECS task, or run the seed from within the CI job via
`workflow_dispatch`.

---

## 5 · DNS + TLS (production only)

The first staging apply runs HTTP-only because `var.acm_certificate_arn`
is empty. For production:

1. Register the domain (or use an existing one).
2. ACM → Request certificate → `api.<your-domain>` + DNS validation.
3. Add a CNAME for `api.<your-domain>` pointing at
   `terraform output -raw api_public_alb_dns`.
4. Update `prod.tfvars`:

   ```
   acm_certificate_arn = "arn:aws:acm:eu-central-1:<acct>:certificate/<uuid>"
   api_domain_name     = "api.your-domain.com"
   ```

5. `terraform apply -var-file=prod.tfvars`.

The ALB now serves HTTPS on :443 and redirects :80 → :443.

---

## 6 · Grafana Cloud integration

Once the OTLP secret is populated (§2), edit the ECS task-definition
env block for each service to add:

```
GRAFANA_CLOUD_OTLP_ENDPOINT=https://otlp-gateway-prod-eu-west-0.grafana.net/otlp
```

Either by editing `infra/terraform/ecs.tf`'s `local.common_env` and
re-applying, or by patching the live task-def via the AWS console
for a one-off test.

@erp/telemetry's `registerOtelSdkFromEnv()` picks it up on the next
task start — no code changes needed.

---

## 7 · Rollback

Deploys are tag-pinned. To roll a service back:

```bash
# Find the previous deployment.
aws ecs describe-services \
  --cluster erp-staging-cluster \
  --services erp-staging-api \
  --query 'services[0].deployments[].{id:id,taskDefinition:taskDefinition,status:status}'

# Point the service at the older task-definition revision.
aws ecs update-service \
  --cluster erp-staging-cluster \
  --service erp-staging-api \
  --task-definition erp-staging-api:<older-revision> \
  --force-new-deployment
```

ECS drains the current tasks, starts the old ones, and `:latest` in
ECR stays current — the service is pinned to a specific revision
until the next workflow run.

**Postgres rollback:** run `packages/db`'s migrator with
`migrateDown()` against the last-known-good version. RLS posture
survives migration rollback. Data migrations (vs schema) are not
auto-reversible — snapshot RDS before any risky migration.

---

## 8 · Hardening after first green deploy

- Replace the deploy role's `AdministratorAccess` with a
  least-privilege policy covering only: ECR push, ECS update-service
  - describe-services, SecretsManager get-secret-value, CloudWatch
    logs put-events.
- Enable S3 access logs on the attachments bucket (new bucket,
  add `aws_s3_bucket_logging`).
- Enable GuardDuty account-wide.
- Wire SNS → Slack for ECS service-event alarms + RDS free-storage
  alarms.
- Rotate the RDS master password on a schedule (Secrets Manager
  rotation with the built-in Postgres Lambda).

These are Phase-4 hardening tasks in their own right; the shape
above is enough to pilot a first tenant.

---

## 9 · Teardown (staging only — never prod)

```bash
cd infra/terraform
terraform destroy -var-file=staging.tfvars
```

`var.rds_deletion_protection = true` will block this unless staging
explicitly turns it off (it does in `staging.tfvars`). The RDS
final-snapshot policy keeps a snapshot for 30 days after teardown —
enough to recover from an accidental destroy.

For prod: don't. Lift specific resources out via `terraform state rm`

- manual console action before anything destructive lands in the
  apply plan.
